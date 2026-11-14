-- Messages lemlist, lot M1 : comptes lemlist des clients (une clé API par compte, chiffrée par l'application).
-- Additive : deux tables et leurs fonctions, aucune table ni fonction existante modifiée.
--  * Un compte lemlist (une équipe lemlist) est rattaché à UNE seule fiche client ; une fiche peut en avoir plusieurs.
--  * La clé est chiffrée côté serveur (AES-256-GCM, MAIL_TOKEN_KEY) avant d'arriver ici : la base n'en voit jamais
--    la valeur. Elle est rangée à part et n'est lue que par lemlist_account_key, pour un compte connecté.
--  * Propriétaire uniquement : ni le portail client (anon), ni un autre compte, ni Claude (MCP) n'y ont accès.
--  * Fiche à la corbeille : le compte est caché et inutilisable (politique de la Corbeille), il revient à la
--    restauration ; purge définitive : compte et clé supprimés ; fusion : le compte suit la fiche conservée ;
--    fiche archivée : le compte reste actif.

create table public.lemlist_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  team_id text not null check (char_length(team_id) between 1 and 100),
  team_name text not null default '' check (char_length(team_name) <= 200),
  -- connected : utilisable ; needs_reconnect : clé refusée par lemlist ; disconnected : déconnecté (clé effacée)
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect', 'disconnected')),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  last_checked_at timestamptz,
  last_ok_at timestamptz,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- une équipe lemlist n'appartient qu'à une fiche à la fois
create unique index lemlist_accounts_team_idx on public.lemlist_accounts (team_id);
create index lemlist_accounts_company_idx on public.lemlist_accounts (company_id);
create trigger set_updated_at before update on public.lemlist_accounts
  for each row execute function public.tg_set_updated_at();

create table public.lemlist_account_secrets (
  account_id uuid primary key references public.lemlist_accounts (id) on delete cascade,
  api_key_enc text not null check (api_key_enc like 'v1.%'),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.lemlist_account_secrets
  for each row execute function public.tg_set_updated_at();

do $$
declare t text;
begin
  foreach t in array array['lemlist_accounts', 'lemlist_account_secrets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated
      using ((select public.is_app_owner()) and public.current_actor() = ''user'')
      with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Corbeille : compte d'une fiche à la corbeille invisible (et donc inutilisable), comme le reste de la fiche
select trash_private.hide('lemlist_accounts', array['company_id:companies']);

-- Fusion de fiches : le compte suit la fiche conservée
create or replace function public.tg_companies_merge_lemlist()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.lemlist_accounts set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger companies_merge_lemlist after update of merged_into_id on public.companies
  for each row execute function public.tg_companies_merge_lemlist();

-- ---------------------------------------------------------------------------
-- Fonctions (droits de l'appelant : la RLS s'applique)
-- ---------------------------------------------------------------------------

-- Connexion ou reconnexion après un test réussi de la clé (fait par le serveur).
create or replace function public.lemlist_connect(p_company uuid, p_team_id text, p_team_name text, p_key_enc text)
returns uuid
language plpgsql
as $$
declare v_id uuid; v_other uuid; v_status text; v_other_name text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Connexion lemlist');
  if p_key_enc is null or p_key_enc not like 'v1.%' then
    raise exception 'Clé chiffrée attendue.' using errcode = '22023';
  end if;
  if coalesce(btrim(p_team_id), '') = '' then raise exception 'Équipe lemlist inconnue.' using errcode = '22023'; end if;
  if not exists (select 1 from public.companies c where c.id = p_company and c.merged_into_id is null) then
    raise exception 'Fiche client introuvable.' using errcode = 'P0001';
  end if;
  select a.id, a.company_id, a.status into v_id, v_other, v_status from public.lemlist_accounts a where a.team_id = p_team_id;
  if v_id is not null and v_other <> p_company and v_status <> 'disconnected' then
    select c.name into v_other_name from public.companies c where c.id = v_other;
    raise exception 'Ce compte lemlist est déjà rattaché à la fiche « % ». Déconnectez-le d''abord de cette fiche.', coalesce(v_other_name, 'autre fiche')
      using errcode = 'P0001';
  end if;
  begin
    if v_id is null then
      insert into public.lemlist_accounts (company_id, team_id, team_name, status, last_checked_at, last_ok_at, connected_at)
      values (p_company, p_team_id, left(coalesce(p_team_name, ''), 200), 'connected', now(), now(), now())
      returning id into v_id;
    else
      -- reconnexion (même fiche) ou nouveau rattachement d'un compte déconnecté
      update public.lemlist_accounts
         set company_id = p_company, team_name = left(coalesce(p_team_name, ''), 200), status = 'connected', last_error = null,
             last_checked_at = now(), last_ok_at = now(), connected_at = now(), disconnected_at = null
       where id = v_id;
    end if;
  exception when unique_violation then
    -- la ligne existe mais n'est pas visible : sa fiche est à la corbeille
    raise exception 'Ce compte lemlist est rattaché à une fiche à la corbeille. Restaurez-la ou videz-la de la corbeille d''abord.'
      using errcode = 'P0001';
  end;
  insert into public.lemlist_account_secrets (account_id, api_key_enc) values (v_id, p_key_enc)
  on conflict (account_id) do update set api_key_enc = excluded.api_key_enc;
  return v_id;
end;
$$;

-- Déconnexion : la clé est effacée du CRM (elle reste valable chez lemlist tant qu'on ne l'y supprime pas).
create or replace function public.lemlist_disconnect(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Déconnexion lemlist');
  update public.lemlist_accounts set status = 'disconnected', disconnected_at = now(), last_error = null where id = p_id;
  if not found then raise exception 'Compte introuvable.' using errcode = 'P0001'; end if;
  delete from public.lemlist_account_secrets where account_id = p_id;
end;
$$;

-- Résultat d'un appel à lemlist pour UN compte : un refus de la clé le passe « à reconnecter », sans toucher aux autres.
-- p_kind : ok | auth (clé refusée) | other (erreur passagère : l'état ne change pas, l'erreur est notée).
create or replace function public.lemlist_account_result(p_id uuid, p_kind text, p_error text)
returns text
language plpgsql
as $$
declare v_status text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('lemlist');
  if p_kind not in ('ok', 'auth', 'other') then raise exception 'Résultat inconnu.' using errcode = '22023'; end if;
  update public.lemlist_accounts
     set status = case when status = 'disconnected' then status when p_kind = 'auth' then 'needs_reconnect' when p_kind = 'ok' then 'connected' else status end,
         last_error = case when p_kind = 'ok' then null else left(p_error, 300) end,
         last_checked_at = now(),
         last_ok_at = case when p_kind = 'ok' then now() else last_ok_at end
   where id = p_id
  returning status into v_status;
  if v_status is null then raise exception 'Compte introuvable.' using errcode = 'P0001'; end if;
  return v_status;
end;
$$;

-- Clé chiffrée d'UN compte utilisable (connecté ou à reconnecter, pour le tester) et visible : fiche pas à la corbeille.
-- Le serveur la déchiffre ; elle n'est jamais renvoyée au navigateur.
create or replace function public.lemlist_account_key(p_id uuid)
returns text
language sql
stable
as $$
  select s.api_key_enc
    from public.lemlist_account_secrets s
    join public.lemlist_accounts a on a.id = s.account_id
   where a.id = p_id and a.status in ('connected', 'needs_reconnect') and public.current_actor() = 'user';
$$;

-- Comptes affichables (jamais la clé) : un seul (p_id) ou tous ceux qui ne sont pas déconnectés.
create or replace function public.lemlist_accounts_list(p_id uuid default null)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', a.id, 'company_id', a.company_id, 'company_name', c.name, 'company_archived', c.archived_at is not null,
    'team_id', a.team_id, 'team_name', a.team_name, 'status', a.status, 'last_error', a.last_error,
    'last_checked_at', a.last_checked_at, 'last_ok_at', a.last_ok_at, 'connected_at', a.connected_at
  ) order by a.connected_at), '[]'::jsonb)
    from public.lemlist_accounts a
    join public.companies c on c.id = a.company_id
   where (p_id is null and a.status <> 'disconnected') or a.id = p_id;
$$;

-- Fiches proposées au rattachement : clients (vente gagnée), non fusionnées, hors corbeille (RLS).
create or replace function public.lemlist_client_options()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'archived', c.archived_at is not null) order by lower(c.name)), '[]'::jsonb)
    from public.companies c
   where c.merged_into_id is null
     and (c.deal_status = 'won' or exists (select 1 from public.sales s where s.company_id = c.id and s.state = 'won'));
$$;

do $$
declare f text;
begin
  foreach f in array array['public.lemlist_connect(uuid, text, text, text)', 'public.lemlist_disconnect(uuid)',
    'public.lemlist_account_result(uuid, text, text)', 'public.lemlist_account_key(uuid)',
    'public.lemlist_accounts_list(uuid)', 'public.lemlist_client_options()'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
