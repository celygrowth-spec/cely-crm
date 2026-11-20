-- Tracking site · lot 1 : collecte des visites de celygrowth.com.
--
-- Principes :
-- - mesure propriétaire : tout reste dans cette base, aucune donnée n'est envoyée à un service tiers ;
-- - avant consentement, une visite n'a aucun identifiant persistant (visitor_id nul) ; l'adresse IP n'est jamais
--   stockée (seules des empreintes salées servent à limiter les abus et à écarter les visites du propriétaire) ;
-- - le point de collecte public n'écrit que par site_collect / site_bot_hit, protégées par la clé serveur ;
-- - lecture réservée au propriétaire (RLS).
-- Rejouable : peut être appliquée plusieurs fois et dans n'importe quel ordre vis-à-vis des autres branches.

-- ---------------------------------------------------------------------------
-- Visiteurs consentants : identifiant persistant créé par le site, 13 mois au plus
-- ---------------------------------------------------------------------------
create table if not exists public.site_visitors (
  id uuid primary key,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '13 months'),
  -- adresse donnée par le visiteur lui-même (formulaire du site), utilisée pour retrouver sa fiche
  email_norm text check (email_norm is null or char_length(email_norm) <= 254),
  demo boolean not null default false
);
create index if not exists site_visitors_email on public.site_visitors (email_norm) where email_norm is not null;

-- ---------------------------------------------------------------------------
-- Visites humaines
-- ---------------------------------------------------------------------------
create table if not exists public.site_visits (
  id uuid primary key,
  visitor_id uuid references public.site_visitors (id) on delete set null,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  channel text not null default 'direct'
    check (channel in ('campaign','organic','ai','social','email','paid','referral','direct')),
  source text check (source is null or char_length(source) <= 120),
  referrer_host text check (referrer_host is null or char_length(referrer_host) <= 120),
  -- UTM normalisés (regroupement) et valeurs d'origine (jamais perdues)
  utm_source text check (utm_source is null or char_length(utm_source) <= 120),
  utm_medium text check (utm_medium is null or char_length(utm_medium) <= 120),
  utm_campaign text check (utm_campaign is null or char_length(utm_campaign) <= 120),
  utm_content text check (utm_content is null or char_length(utm_content) <= 120),
  utm_term text check (utm_term is null or char_length(utm_term) <= 120),
  utm_raw jsonb,
  country text check (country is null or country ~ '^[A-Z]{2}$'),
  device text not null default 'desktop' check (device in ('desktop','mobile','tablet')),
  browser text check (browser is null or char_length(browser) <= 40),
  entry_page text not null check (char_length(entry_page) between 1 and 300),
  exit_page text not null check (char_length(exit_page) between 1 and 300),
  is_returning boolean not null default false,
  pageviews int not null default 0,
  duration_s int not null default 0,
  max_scroll smallint not null default 0,
  cta_clicks int not null default 0,
  forms int not null default 0,
  demo boolean not null default false
);
create index if not exists site_visits_started on public.site_visits (started_at desc);
create index if not exists site_visits_visitor on public.site_visits (visitor_id, started_at) where visitor_id is not null;
create index if not exists site_visits_campaign on public.site_visits (utm_campaign, started_at) where utm_campaign is not null;
create index if not exists site_visits_last_seen on public.site_visits (last_seen_at desc);

create table if not exists public.site_pageviews (
  id uuid primary key,
  visit_id uuid not null references public.site_visits (id) on delete cascade,
  at timestamptz not null default now(),
  path text not null check (char_length(path) between 1 and 300),
  duration_s int not null default 0,
  scroll_pct smallint not null default 0
);
create index if not exists site_pageviews_visit on public.site_pageviews (visit_id, at);
create index if not exists site_pageviews_at on public.site_pageviews (at desc);
create index if not exists site_pageviews_path on public.site_pageviews (path, at);

-- Clic vers la prise de rendez-vous, formulaire envoyé, rendez-vous confirmé (vu depuis le site)
create table if not exists public.site_events (
  id uuid primary key,
  visit_id uuid not null references public.site_visits (id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('cta','form','booking')),
  path text not null check (char_length(path) between 1 and 300),
  label text check (label is null or char_length(label) <= 120),
  -- « Comment m'avez-vous connu ? » saisi dans un formulaire du site
  declared_source text check (declared_source is null or char_length(declared_source) <= 60),
  declared_detail text check (declared_detail is null or char_length(declared_detail) <= 300)
);
create index if not exists site_events_visit on public.site_events (visit_id, at);
create index if not exists site_events_kind on public.site_events (kind, at desc);

-- ---------------------------------------------------------------------------
-- Robots (moteurs de recherche et IA) : un compteur par jour, robot, statut et page
-- ---------------------------------------------------------------------------
create table if not exists public.site_bot_hits (
  day date not null,
  bot text not null check (char_length(bot) between 1 and 60),
  kind text not null check (kind in ('ai','search','other')),
  -- verified : origine confirmée ; unverified : nom connu mais origine démentie (usurpation probable) ;
  -- unverifiable : l'éditeur du robot ne publie aucun moyen de contrôle
  status text not null check (status in ('verified','unverified','unverifiable')),
  path text not null check (char_length(path) between 1 and 300),
  hits int not null default 1,
  last_at timestamptz not null default now(),
  demo boolean not null default false,
  primary key (day, bot, status, path)
);
create index if not exists site_bot_hits_bot on public.site_bot_hits (bot, day);

-- ---------------------------------------------------------------------------
-- Technique : limites d'abus et exclusion des visites du propriétaire (empreintes, jamais l'adresse)
-- ---------------------------------------------------------------------------
create table if not exists public.site_rate (
  bucket text not null check (char_length(bucket) between 1 and 80),
  minute timestamptz not null,
  n int not null default 1,
  primary key (bucket, minute)
);
create table if not exists public.site_excluded_ips (
  ip_hash text primary key check (char_length(ip_hash) between 16 and 80),
  seen_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS : lecture par le propriétaire uniquement, aucune écriture directe
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['site_visitors','site_visits','site_pageviews','site_events','site_bot_hits','site_rate','site_excluded_ips']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('drop policy if exists owner_select on public.%I', t);
  end loop;
  foreach t in array array['site_visitors','site_visits','site_pageviews','site_events','site_bot_hits']
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Fonctions
-- ---------------------------------------------------------------------------
create schema if not exists site_private;
revoke all on schema site_private from public, anon, authenticated;

create or replace function site_private.txt(p jsonb, p_key text, p_max int)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(left(btrim(p ->> p_key), p_max), ''); $$;

create or replace function site_private.uuid_or_null(p text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p is null or p !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return null; end if;
  return p::uuid;
end;
$$;

-- Limite d'abus : au plus p_max événements par minute pour une empreinte. Faux = refusé.
create or replace function site_private.rate_ok(p_bucket text, p_max int)
returns boolean
language plpgsql
set search_path = ''
as $$
declare v_n int; v_minute timestamptz := date_trunc('minute', now());
begin
  if p_bucket is null then return true; end if;
  insert into public.site_rate (bucket, minute) values (left(p_bucket, 80), v_minute)
  on conflict (bucket, minute) do update set n = public.site_rate.n + 1
  returning n into v_n;
  if random() < 0.02 then delete from public.site_rate where minute < now() - interval '1 hour'; end if;
  return v_n <= p_max;
end;
$$;

-- Visiteur consentant : créé à la première vue, durée de vie de 13 mois non prolongée.
create or replace function site_private.touch_visitor(p_id uuid)
returns void
language sql
set search_path = ''
as $$
  insert into public.site_visitors (id) values (p_id)
  on conflict (id) do update set last_seen_at = now();
$$;

/**
 * Point d'entrée unique de la collecte. p_event (déjà validé et classé par le serveur) :
 *   type : pv | pe | cta | form | booking | consent | withdraw
 *   visit_id, visitor_id?, pageview_id?, event_id?, path, duration_s?, scroll_pct?, label?, email?,
 *   declared_source?, declared_detail?, visit : { channel, source, referrer_host, utm_*, utm_raw, country, device, browser }
 * p_ip_hash : empreinte stable de l'adresse (exclusion du propriétaire) ; p_rate_hash : empreinte du jour (abus).
 * Retour : ok | excluded | rate_limited | ignored. N'écrit que dans les tables site_*.
 */
create or replace function public.site_collect(p_server_key text, p_event jsonb, p_ip_hash text default null, p_rate_hash text default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := p_event ->> 'type';
  v_visit uuid := site_private.uuid_or_null(p_event ->> 'visit_id');
  v_visitor uuid := site_private.uuid_or_null(p_event ->> 'visitor_id');
  v_pv uuid := site_private.uuid_or_null(p_event ->> 'pageview_id');
  v_event uuid := site_private.uuid_or_null(p_event ->> 'event_id');
  v_path text := coalesce(site_private.txt(p_event, 'path', 300), '/');
  v jsonb := coalesce(p_event -> 'visit', '{}'::jsonb);
  v_new boolean := false;
  v_old_d int; v_old_s int; v_d int; v_s int; v_rows int;
  v_kind text;
begin
  perform appt_private.assert_server(p_server_key);
  if v_visit is null or v_type is null then return 'ignored'; end if;
  if p_ip_hash is not null and exists (
    select 1 from public.site_excluded_ips where ip_hash = p_ip_hash and seen_at > now() - interval '30 days') then
    return 'excluded';
  end if;
  if not site_private.rate_ok('ip:' || p_rate_hash, 90) or not site_private.rate_ok('all', 3000) then return 'rate_limited'; end if;

  -- un identifiant expiré n'est plus rattaché : la visite reste anonyme
  if v_visitor is not null and exists (select 1 from public.site_visitors where id = v_visitor and expires_at < now()) then
    v_visitor := null;
  end if;

  if v_type = 'pv' then
    if v_pv is null then return 'ignored'; end if;
    if v_visitor is not null then perform site_private.touch_visitor(v_visitor); end if;
    insert into public.site_visits (id, visitor_id, channel, source, referrer_host, utm_source, utm_medium, utm_campaign,
      utm_content, utm_term, utm_raw, country, device, browser, entry_page, exit_page, is_returning)
    values (v_visit, v_visitor,
      case when v ->> 'channel' in ('campaign','organic','ai','social','email','paid','referral','direct') then v ->> 'channel' else 'direct' end,
      site_private.txt(v, 'source', 120), site_private.txt(v, 'referrer_host', 120),
      site_private.txt(v, 'utm_source', 120), site_private.txt(v, 'utm_medium', 120), site_private.txt(v, 'utm_campaign', 120),
      site_private.txt(v, 'utm_content', 120), site_private.txt(v, 'utm_term', 120),
      case when jsonb_typeof(v -> 'utm_raw') = 'object' and pg_column_size(v -> 'utm_raw') <= 1200 then v -> 'utm_raw' end,
      case when v ->> 'country' ~ '^[A-Z]{2}$' then v ->> 'country' end,
      case when v ->> 'device' in ('desktop','mobile','tablet') then v ->> 'device' else 'desktop' end,
      site_private.txt(v, 'browser', 40), v_path, v_path,
      v_visitor is not null and exists (select 1 from public.site_visits o where o.visitor_id = v_visitor and o.id <> v_visit))
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    v_new := v_rows > 0;
    insert into public.site_pageviews (id, visit_id, path) values (v_pv, v_visit, v_path) on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      update public.site_visits set pageviews = pageviews + 1, exit_page = v_path, last_seen_at = now(),
        visitor_id = coalesce(visitor_id, v_visitor)
      where id = v_visit;
    end if;
    return 'ok';
  end if;

  -- les autres événements portent sur une visite déjà ouverte
  if not exists (select 1 from public.site_visits where id = v_visit) then return 'ignored'; end if;

  if v_type = 'pe' then
    v_d := least(greatest(coalesce((p_event ->> 'duration_s')::int, 0), 0), 3600);
    v_s := least(greatest(coalesce((p_event ->> 'scroll_pct')::int, 0), 0), 100);
    select duration_s, scroll_pct into v_old_d, v_old_s from public.site_pageviews where id = v_pv and visit_id = v_visit for update;
    if not found then return 'ignored'; end if;
    update public.site_pageviews set duration_s = greatest(v_old_d, v_d), scroll_pct = greatest(v_old_s, v_s) where id = v_pv;
    update public.site_visits set duration_s = duration_s + greatest(v_d - v_old_d, 0),
      max_scroll = greatest(max_scroll, v_s), last_seen_at = now()
    where id = v_visit;
    return 'ok';
  end if;

  if v_type in ('cta', 'form', 'booking') then
    if v_event is null then return 'ignored'; end if;
    v_kind := v_type;
    insert into public.site_events (id, visit_id, kind, path, label, declared_source, declared_detail)
    values (v_event, v_visit, v_kind, v_path, site_private.txt(p_event, 'label', 120),
      site_private.txt(p_event, 'declared_source', 60), site_private.txt(p_event, 'declared_detail', 300))
    on conflict (id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      update public.site_visits set last_seen_at = now(),
        cta_clicks = cta_clicks + (v_kind = 'cta')::int, forms = forms + (v_kind = 'form')::int
      where id = v_visit;
      -- l'adresse saisie dans un formulaire ne relie le parcours à une fiche que si le visiteur a consenti
      if v_kind = 'form' and site_private.txt(p_event, 'email', 254) is not null then
        update public.site_visitors set email_norm = lower(site_private.txt(p_event, 'email', 254))
        where id = (select visitor_id from public.site_visits where id = v_visit);
      end if;
    end if;
    return 'ok';
  end if;

  if v_type = 'consent' then
    -- consentement donné en cours de visite : le rattachement commence ici
    if v_visitor is null then return 'ignored'; end if;
    perform site_private.touch_visitor(v_visitor);
    update public.site_visits set visitor_id = v_visitor, last_seen_at = now(),
      is_returning = exists (select 1 from public.site_visits o where o.visitor_id = v_visitor and o.id <> v_visit)
    where id = v_visit and visitor_id is null;
    return 'ok';
  end if;

  if v_type = 'withdraw' then
    -- consentement retiré : l'identifiant disparaît, ses visites redeviennent anonymes
    if v_visitor is null then return 'ignored'; end if;
    if not exists (select 1 from public.site_visits where id = v_visit and visitor_id = v_visitor) then return 'ignored'; end if;
    delete from public.site_visitors where id = v_visitor; -- visitor_id des visites remis à nul par la clé étrangère
    return 'ok';
  end if;

  return 'ignored';
exception when invalid_text_representation or numeric_value_out_of_range then
  return 'ignored';
end;
$$;

-- Passage d'un robot, signalé par le serveur du site.
create or replace function public.site_bot_hit(p_server_key text, p_bot text, p_kind text, p_status text, p_path text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  if not site_private.rate_ok('bots', 1200) then return 'rate_limited'; end if;
  insert into public.site_bot_hits (day, bot, kind, status, path)
  values ((now() at time zone 'Europe/Paris')::date, left(btrim(p_bot), 60), p_kind, p_status, left(coalesce(nullif(btrim(p_path), ''), '/'), 300))
  on conflict (day, bot, status, path) do update set hits = public.site_bot_hits.hits + 1, last_at = now();
  return 'ok';
end;
$$;

-- Le propriétaire utilise le CRM depuis cette connexion : ses visites du site ne sont pas comptées.
create or replace function public.site_exclude_ip(p_ip_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  if p_ip_hash is null or char_length(p_ip_hash) not between 16 and 80 then return; end if;
  insert into public.site_excluded_ips (ip_hash) values (p_ip_hash)
  on conflict (ip_hash) do update set seen_at = now() where public.site_excluded_ips.seen_at < now() - interval '1 hour';
  delete from public.site_excluded_ips where seen_at < now() - interval '60 days';
end;
$$;

-- Purge : identifiants de plus de 13 mois (les visites restent, anonymes). Appelée par le passage quotidien.
create or replace function public.site_purge(p_server_key text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_n int;
begin
  perform appt_private.assert_server(p_server_key);
  delete from public.site_visitors where expires_at < now() and not demo;
  get diagnostics v_n = row_count;
  delete from public.site_rate where minute < now() - interval '1 hour';
  return v_n;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.site_collect(text, jsonb, text, text)', 'public.site_bot_hit(text, text, text, text, text)', 'public.site_purge(text)']
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke execute on function public.site_exclude_ip(text) from public, anon;
grant execute on function public.site_exclude_ip(text) to authenticated;
revoke execute on all functions in schema site_private from public, anon, authenticated;
