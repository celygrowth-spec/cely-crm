-- Tracking du site, lot 5 — Google Search Console et Bing Webmaster Tools (lecture seule).
--
--   * seo_connections : une ligne par fournisseur ('gsc', 'bing') : propriété suivie, état, dernière synchronisation,
--     curseur de reprise. Aucun secret dans cette table.
--   * seo_connection_secrets : jeton de rafraîchissement Google ou clé API Bing, CHIFFRÉ par le serveur avant
--     l'écriture (AES-256-GCM, clé dérivée de APPOINTMENTS_SECRET). Aucune lecture possible depuis le navigateur :
--     ni politique, ni droit. Le texte chiffré ne sort que par seo_server_connection (clé serveur).
--   * seo_daily : clics, impressions et position moyenne par jour, page et requête. Le CTR se calcule
--     (clics / impressions), il n'est pas stocké. Une ligne par (fournisseur, jour, page, requête) : relancer une
--     synchronisation remplace les mêmes lignes, sans doublon.
--     Niveaux : page et requête renseignées = croisement ; page = '' : total d'une requête ; requête = '' : total
--     d'une page ; les deux vides : total du site. Search Console n'écrit que des croisements ; Bing écrit les
--     quatre niveaux (son API ne croise pas tout) : ne jamais additionner des niveaux différents.
--
-- Migration additive et rejouable : aucune table ni fonction existante n'est modifiée, sauf deux listes autorisées
-- complétées sans rien retirer (connector_checks.key, scheduled_jobs.job).

create table if not exists public.seo_connections (
  provider text primary key check (provider in ('gsc', 'bing')),
  site_url text check (site_url is null or char_length(site_url) between 1 and 500),
  account_label text check (account_label is null or char_length(account_label) <= 200),
  -- propriétés proposées au choix (Search Console) : adresses seulement
  sites jsonb not null default '[]',
  status text not null default 'connected' check (status in ('connected', 'reconnect', 'error')),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  history_done_at timestamptz,
  cursor jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
drop trigger if exists set_updated_at on public.seo_connections;
create trigger set_updated_at before update on public.seo_connections
  for each row execute function public.tg_set_updated_at();

alter table public.seo_connections enable row level security;
drop policy if exists owner_select on public.seo_connections;
create policy owner_select on public.seo_connections for select to authenticated using ((select public.is_app_owner()));
revoke all on public.seo_connections from anon;
revoke insert, update, delete, truncate on public.seo_connections from authenticated;

create table if not exists public.seo_connection_secrets (
  provider text primary key references public.seo_connections (provider) on delete cascade,
  secret_enc text not null check (secret_enc like 'v1.%' and char_length(secret_enc) <= 4000),
  updated_at timestamptz not null default now()
);
-- RLS sans aucune politique, et aucun droit : la table n'est lisible que par les fonctions ci-dessous
alter table public.seo_connection_secrets enable row level security;
revoke all on public.seo_connection_secrets from public, anon, authenticated;

create table if not exists public.seo_daily (
  provider text not null check (provider in ('gsc', 'bing')),
  day date not null,
  page text not null default '' check (char_length(page) <= 500),
  query text not null default '' check (char_length(query) <= 500),
  clicks integer not null default 0 check (clicks >= 0),
  impressions integer not null default 0 check (impressions >= 0),
  position numeric(7,2) check (position is null or position >= 0),
  demo boolean not null default false,
  constraint seo_daily_unique unique (provider, day, page, query)
);
create index if not exists seo_daily_day_idx on public.seo_daily (day);
create index if not exists seo_daily_query_idx on public.seo_daily (provider, query, day);

alter table public.seo_daily enable row level security;
drop policy if exists owner_select on public.seo_daily;
create policy owner_select on public.seo_daily for select to authenticated using ((select public.is_app_owner()));
revoke all on public.seo_daily from anon;
revoke insert, update, delete, truncate on public.seo_daily from authenticated;

-- ---------------------------------------------------------------------------
-- Propriétaire, dans l'application : connecter, choisir la propriété, déconnecter
-- ---------------------------------------------------------------------------
create schema if not exists seo_private;
revoke all on schema seo_private from public, anon, authenticated;

create or replace function seo_private.assert_owner_user()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then
    raise exception 'Les connecteurs se règlent dans l''application.' using errcode = '42501';
  end if;
end;
$$;

create or replace function seo_private.provider(p_provider text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_provider is null or p_provider not in ('gsc', 'bing') then
    raise exception 'Fournisseur inconnu' using errcode = '22023';
  end if;
  return p_provider;
end;
$$;

-- Enregistre une connexion (jeton ou clé déjà chiffrés par le serveur). Reconnexion de la même propriété : le
-- curseur et l'historique sont conservés. Propriété différente : l'import repart de zéro (voir seo_set_site).
create or replace function public.seo_connect(
  p_provider text, p_secret_enc text, p_account_label text default null, p_site_url text default null, p_sites jsonb default '[]')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_site text := nullif(btrim(coalesce(p_site_url, '')), '');
  v_old text;
begin
  perform seo_private.assert_owner_user();
  v_provider := seo_private.provider(p_provider);
  if p_secret_enc is null or p_secret_enc not like 'v1.%' then
    raise exception 'Secret non chiffré' using errcode = '22023';
  end if;
  select site_url into v_old from public.seo_connections where provider = v_provider;
  -- même compte reconnecté sans propriété imposée : la propriété déjà choisie est gardée si elle est encore proposée
  if v_site is null and v_old is not null and coalesce(p_sites, '[]') @> to_jsonb(v_old) then
    v_site := v_old;
  end if;
  insert into public.seo_connections as c (provider, site_url, account_label, sites, status, last_error, connected_at)
  values (v_provider, v_site, nullif(btrim(coalesce(p_account_label, '')), ''), coalesce(p_sites, '[]'), 'connected', null, now())
  on conflict (provider) do update set
    site_url = excluded.site_url, account_label = excluded.account_label, sites = excluded.sites,
    status = 'connected', last_error = null, connected_at = now(),
    cursor = case when c.site_url is not distinct from excluded.site_url then c.cursor else '{}'::jsonb end,
    history_done_at = case when c.site_url is not distinct from excluded.site_url then c.history_done_at end,
    last_sync_at = case when c.site_url is not distinct from excluded.site_url then c.last_sync_at end;
  if v_old is not null and v_old is distinct from v_site then
    delete from public.seo_daily where provider = v_provider and not demo;
  end if;
  insert into public.seo_connection_secrets (provider, secret_enc) values (v_provider, p_secret_enc)
  on conflict (provider) do update set secret_enc = excluded.secret_enc, updated_at = now();
end;
$$;

-- Choix de la propriété suivie. En changer efface les chiffres importés de l'ancienne (ils ne décrivent pas le même
-- site) et relance l'import complet ; les lignes de démonstration ne sont pas touchées.
create or replace function public.seo_set_site(p_provider text, p_site_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_site text := nullif(btrim(coalesce(p_site_url, '')), '');
  v_row public.seo_connections;
begin
  perform seo_private.assert_owner_user();
  v_provider := seo_private.provider(p_provider);
  select * into v_row from public.seo_connections where provider = v_provider for update;
  if not found then raise exception 'Connecteur non connecté' using errcode = 'P0002'; end if;
  if v_site is null or char_length(v_site) > 500 then
    raise exception 'Propriété invalide' using errcode = '22023';
  end if;
  if v_provider = 'gsc' and not (v_row.sites @> to_jsonb(v_site)) then
    raise exception 'Cette propriété ne fait pas partie de celles du compte connecté' using errcode = '22023';
  end if;
  if v_row.site_url is not distinct from v_site then return; end if;
  if v_row.site_url is not null then
    delete from public.seo_daily where provider = v_provider and not demo;
  end if;
  update public.seo_connections
     set site_url = v_site, cursor = '{}', history_done_at = null, last_sync_at = null,
         status = case when status = 'error' then 'connected' else status end,
         last_error = case when status = 'error' then null else last_error end
   where provider = v_provider;
end;
$$;

-- Déconnexion : le secret est effacé, les chiffres déjà importés restent.
create or replace function public.seo_disconnect(p_provider text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform seo_private.assert_owner_user();
  delete from public.seo_connections where provider = seo_private.provider(p_provider);
end;
$$;

-- ---------------------------------------------------------------------------
-- Serveur de l'application (clé serveur) : passage quotidien et vérifications
-- ---------------------------------------------------------------------------

-- Connexion et secret chiffré ; null si le fournisseur n'est pas connecté.
create or replace function public.seo_server_connection(p_server_key text, p_provider text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  return (select jsonb_build_object('provider', c.provider, 'site_url', c.site_url, 'status', c.status, 'cursor', c.cursor,
                                    'history_done_at', c.history_done_at, 'last_sync_at', c.last_sync_at, 'secret_enc', s.secret_enc)
            from public.seo_connections c join public.seo_connection_secrets s using (provider)
           where c.provider = seo_private.provider(p_provider));
end;
$$;

-- Écrit un lot de lignes [{day, page, query, clicks, impressions, position}]. La même ligne reçue deux fois est
-- remplacée, jamais doublée. p_replace_days : ces jours sont d'abord vidés (hors démonstration) dans la même
-- transaction, pour qu'une ligne disparue chez le fournisseur (données provisoires) ne reste pas.
-- Renvoie le nombre de lignes écrites. Au plus 60 000 lignes par appel.
create or replace function public.seo_server_upsert(p_server_key text, p_provider text, p_rows jsonb, p_replace_days date[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider text;
  v_count integer := 0;
begin
  perform appt_private.assert_server(p_server_key);
  v_provider := seo_private.provider(p_provider);
  if not exists (select 1 from public.seo_connections where provider = v_provider) then
    raise exception 'Connecteur non connecté' using errcode = 'P0002';
  end if;
  if p_rows is not null and jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Lot invalide' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_rows, '[]')) > 60000 then
    raise exception 'Lot trop volumineux' using errcode = '22023';
  end if;
  if p_replace_days is not null then
    delete from public.seo_daily where provider = v_provider and day = any (p_replace_days) and not demo;
  end if;
  insert into public.seo_daily as d (provider, day, page, query, clicks, impressions, position, demo)
  select distinct on (r.day, r.page, r.query) v_provider, r.day, r.page, r.query, r.clicks, r.impressions, r.position, false
    from (select (x ->> 'day')::date as day,
                 left(coalesce(x ->> 'page', ''), 500) as page,
                 left(coalesce(x ->> 'query', ''), 500) as query,
                 greatest(0, round(coalesce((x ->> 'clicks')::numeric, 0)))::integer as clicks,
                 greatest(0, round(coalesce((x ->> 'impressions')::numeric, 0)))::integer as impressions,
                 case when (x ->> 'position') is null then null
                      else least(99999.99, greatest(0, round((x ->> 'position')::numeric, 2))) end as position
            from jsonb_array_elements(coalesce(p_rows, '[]')) x) r
   where r.day is not null
   order by r.day, r.page, r.query, r.impressions desc
  on conflict (provider, day, page, query) do update
    set clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position, demo = false;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Avance de la synchronisation. p_cursor null : curseur inchangé. Toute avance confirme que l'accès fonctionne.
create or replace function public.seo_server_progress(
  p_server_key text, p_provider text, p_cursor jsonb default null, p_history_done boolean default false, p_synced boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.seo_connections
     set cursor = coalesce(p_cursor, cursor),
         history_done_at = case when p_history_done then coalesce(history_done_at, now()) else history_done_at end,
         last_sync_at = case when p_synced then now() else last_sync_at end,
         status = 'connected', last_error = null
   where provider = seo_private.provider(p_provider);
end;
$$;

-- Échec : 'reconnect' (accès refusé, expiré ou révoqué : à reconnecter) ou 'error' (panne passagère). Le message
-- est écrit par le serveur de l'application : jamais de jeton, de clé ni d'adresse appelée.
create or replace function public.seo_server_fail(p_server_key text, p_provider text, p_status text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  if p_status is null or p_status not in ('reconnect', 'error') then
    raise exception 'État invalide' using errcode = '22023';
  end if;
  update public.seo_connections
     set status = p_status, last_error = left(coalesce(nullif(btrim(p_error), ''), 'Erreur inconnue.'), 300)
   where provider = seo_private.provider(p_provider);
end;
$$;

revoke execute on all functions in schema seo_private from public, anon, authenticated;
revoke execute on function public.seo_connect(text, text, text, text, jsonb) from public, anon;
revoke execute on function public.seo_set_site(text, text) from public, anon;
revoke execute on function public.seo_disconnect(text) from public, anon;
grant execute on function public.seo_connect(text, text, text, text, jsonb) to authenticated;
grant execute on function public.seo_set_site(text, text) to authenticated;
grant execute on function public.seo_disconnect(text) to authenticated;

revoke execute on function public.seo_server_connection(text, text) from public;
revoke execute on function public.seo_server_upsert(text, text, jsonb, date[]) from public;
revoke execute on function public.seo_server_progress(text, text, jsonb, boolean, boolean) from public;
revoke execute on function public.seo_server_fail(text, text, text, text) from public;
grant execute on function public.seo_server_connection(text, text) to anon, authenticated;
grant execute on function public.seo_server_upsert(text, text, jsonb, date[]) to anon, authenticated;
grant execute on function public.seo_server_progress(text, text, jsonb, boolean, boolean) to anon, authenticated;
grant execute on function public.seo_server_fail(text, text, text, text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Listes autorisées complétées sans retirer ce qu'une autre migration a ajouté entre-temps :
-- vérifications à la demande (Connecteurs) et passage planifié « seo ».
-- ---------------------------------------------------------------------------
do $$
declare
  v text;
  k text;
begin
  foreach k in array array['search_console', 'bing_webmaster'] loop
    select pg_get_constraintdef(oid) into v from pg_constraint
     where conrelid = 'public.connector_checks'::regclass and conname = 'connector_checks_key_check';
    if v is not null and v not like '%''' || k || '''%' and v like '%ARRAY[%' then
      alter table public.connector_checks drop constraint connector_checks_key_check;
      execute 'alter table public.connector_checks add constraint connector_checks_key_check '
        || replace(v, 'ARRAY[', 'ARRAY[''' || k || '''::text, ');
    end if;
  end loop;

  select pg_get_constraintdef(oid) into v from pg_constraint
   where conrelid = 'public.scheduled_jobs'::regclass and conname = 'scheduled_jobs_job_check';
  if v is not null and v not like '%''seo''%' and v like '%ARRAY[%' then
    alter table public.scheduled_jobs drop constraint scheduled_jobs_job_check;
    execute 'alter table public.scheduled_jobs add constraint scheduled_jobs_job_check ' || replace(v, 'ARRAY[', 'ARRAY[''seo''::text, ');
  end if;
end $$;
