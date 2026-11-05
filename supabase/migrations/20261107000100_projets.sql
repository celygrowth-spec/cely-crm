-- Projets et portail client — phase 1 : projets, membres, accès par code, sessions, cloisonnement.
-- Migration additive.
--
-- Modèle de sécurité du portail
-- * Les clients n'ont pas de compte Supabase. Le serveur Next appelle les fonctions portal_* avec la clé
--   publique, la clé serveur (même mécanisme que la réservation publique : empreinte enregistrée en base,
--   secret APPOINTMENTS_SECRET côté serveur uniquement) et l'empreinte du jeton de session du client
--   (cookie httpOnly). Chaque fonction revérifie : session valide, accès non révoqué ni expiré, personne
--   membre du projet, projet publié et ouvert. Aucune table n'est lisible par le rôle anon.
-- * Le code d'accès n'est jamais stocké : seule son empreinte HMAC (poivrée côté serveur) l'est.
-- * Les fonctions internes sont dans le schéma non exposé portal_private.

create schema if not exists portal_private;
revoke all on schema portal_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Projets
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (description is null or char_length(description) <= 2000),
  status text not null default 'a_preparer' check (status in ('a_preparer','en_cours','en_attente','termine','archive')),
  start_date date,
  end_date date,
  -- visible du client : message d'état rédigé par l'administrateur
  client_update text check (client_update is null or char_length(client_update) <= 2000),
  -- interne uniquement, jamais renvoyé au portail
  internal_note text check (internal_note is null or char_length(internal_note) <= 10000),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 500),
  -- le portail n'affiche le projet qu'une fois publié explicitement
  portal_published boolean not null default false,
  -- projet archivé : lecture seule pour le client, ou accès fermé
  archived_portal text not null default 'read_only' check (archived_portal in ('read_only','closed')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index projects_company_idx on public.projects (company_id);
create index projects_status_idx on public.projects (status);

-- Contacts clients d'un projet (personnes de la fiche CRM)
create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (project_id, person_id)
);
create index project_members_person_idx on public.project_members (person_id);

-- Un accès individuel par personne, valable pour tous les projets dont elle est membre
create table public.portal_accesses (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null unique references public.people (id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  code_hint text not null check (char_length(code_hint) between 2 and 8),
  code_generated_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  access_id uuid not null references public.portal_accesses (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index portal_sessions_access_idx on public.portal_sessions (access_id);

create table public.portal_login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index portal_login_attempts_idx on public.portal_login_attempts (ip_hash, created_at desc);

-- Journal du projet : qui a fait quoi (administrateur ou client identifié)
create table public.project_activity (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  actor text not null check (actor in ('owner','client','system')),
  person_id uuid references public.people (id) on delete set null,
  kind text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index project_activity_idx on public.project_activity (project_id, id desc);

create trigger set_updated_at before update on public.projects for each row execute function public.tg_set_updated_at();

do $$
declare t text;
begin
  foreach t in array array['projects','project_members','portal_accesses','portal_sessions','portal_login_attempts','project_activity']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['projects','project_members']
  loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
  end loop;
end $$;
-- empreintes jamais lisibles par l'API, même par le propriétaire
revoke select on public.portal_accesses from authenticated;
grant select (id, person_id, code_hint, code_generated_at, expires_at, revoked_at, last_used_at, created_at) on public.portal_accesses to authenticated;
revoke select on public.portal_sessions from authenticated;
grant select (id, access_id, user_agent, created_at, expires_at, last_seen_at, revoked_at) on public.portal_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- Contrôles
-- ---------------------------------------------------------------------------

create or replace function portal_private.assert_owner_user()
returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then
    raise exception 'Projets : action réservée à l''application' using errcode = '42501';
  end if;
end; $$;

create or replace function portal_private.assert_server(p_key text)
returns void language plpgsql stable set search_path = '' as $$
begin
  perform appt_private.assert_server(p_key);
end; $$;

create or replace function portal_private.log(p_project uuid, p_actor text, p_person uuid, p_kind text, p_data jsonb default '{}')
returns void language sql set search_path = '' as $$
  insert into public.project_activity (project_id, actor, person_id, kind, data) values (p_project, p_actor, p_person, p_kind, coalesce(p_data, '{}'));
$$;

-- Session du portail → personne. Lève une erreur « session » si elle n'est plus valable
-- (expirée, révoquée, accès révoqué ou expiré). Prolonge l'activité.
create or replace function portal_private.session_person(p_server_key text, p_session_hash text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_person uuid;
  v_session uuid;
begin
  perform portal_private.assert_server(p_server_key);
  select a.person_id, s.id into v_person, v_session
    from public.portal_sessions s
    join public.portal_accesses a on a.id = s.access_id
   where s.token_hash = p_session_hash and s.revoked_at is null and s.expires_at > now()
     and a.revoked_at is null and (a.expires_at is null or a.expires_at > now());
  if v_person is null then
    raise exception 'Session expirée' using errcode = '28000';
  end if;
  update public.portal_sessions set last_seen_at = now() where id = v_session and last_seen_at < now() - interval '5 minutes';
  return v_person;
end;
$$;

-- Projets visibles par une personne : membre, projet publié, non fermé.
create or replace function portal_private.visible_projects(p_person uuid)
returns table (project_id uuid, read_only boolean)
language sql
stable
set search_path = ''
as $$
  select p.id, p.status = 'archive'
    from public.project_members m
    join public.projects p on p.id = m.project_id
   where m.person_id = p_person and p.portal_published
     and (p.status <> 'archive' or p.archived_portal = 'read_only');
$$;

create or replace function portal_private.assert_project(p_person uuid, p_project uuid, p_write boolean default false)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare v_ro boolean;
begin
  select read_only into v_ro from portal_private.visible_projects(p_person) where project_id = p_project;
  if not found then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
  if p_write and v_ro then raise exception 'Ce projet est archivé : il est consultable mais plus modifiable' using errcode = '42501'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Administration (propriétaire)
-- ---------------------------------------------------------------------------

-- p_data : {company_id, name, description, start_date, end_date, status}
create or replace function public.project_create(p_data jsonb, p_person_ids uuid[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_company uuid := nullif(p_data ->> 'company_id', '')::uuid;
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche CRM introuvable' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_person_ids, '{}')) x where not exists (
               select 1 from public.people p where p.id = x and p.company_id = v_company)) then
    raise exception 'Un contact choisi n''appartient pas à cette entreprise' using errcode = '22023';
  end if;
  insert into public.projects (company_id, name, description, start_date, end_date, status)
  values (v_company, btrim(p_data ->> 'name'), nullif(btrim(coalesce(p_data ->> 'description', '')), ''),
          nullif(p_data ->> 'start_date', '')::date, nullif(p_data ->> 'end_date', '')::date,
          coalesce(nullif(p_data ->> 'status', ''), 'a_preparer'))
  returning id into v_id;
  insert into public.project_members (project_id, person_id) select v_id, x from unnest(coalesce(p_person_ids, '{}')) x on conflict do nothing;
  perform portal_private.log(v_id, 'owner', null, 'created');
  insert into public.interactions (company_id, kind, content, content_origin, source, meta)
  values (v_company, 'system', 'Projet créé : ' || btrim(p_data ->> 'name'), 'system', 'user', jsonb_build_object('project_id', v_id));
  return v_id;
end;
$$;

create or replace function public.project_add_member(p_project uuid, p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.projects pr join public.people p on p.company_id = pr.company_id where pr.id = p_project and p.id = p_person) then
    raise exception 'Ce contact n''appartient pas à l''entreprise du projet' using errcode = '22023';
  end if;
  insert into public.project_members (project_id, person_id) values (p_project, p_person) on conflict do nothing;
  if found then perform portal_private.log(p_project, 'owner', p_person, 'member_added'); end if;
end;
$$;

create or replace function public.project_remove_member(p_project uuid, p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  delete from public.project_members where project_id = p_project and person_id = p_person;
  if found then perform portal_private.log(p_project, 'owner', p_person, 'member_removed'); end if;
end;
$$;

-- Nouveau code (création ou régénération) : l'ancien code et toutes les sessions sont invalidés.
-- Le code est généré et haché par le serveur ; il n'est jamais transmis à la base.
create or replace function public.portal_access_issue(p_person uuid, p_code_hash text, p_code_hint text, p_expires_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.people where id = p_person) then raise exception 'Contact introuvable' using errcode = 'P0002'; end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'La date d''expiration est déjà passée' using errcode = '22023'; end if;
  insert into public.portal_accesses (person_id, code_hash, code_hint, expires_at)
  values (p_person, p_code_hash, p_code_hint, p_expires_at)
  on conflict (person_id) do update set code_hash = excluded.code_hash, code_hint = excluded.code_hint, code_generated_at = now(),
    expires_at = excluded.expires_at, revoked_at = null
  returning id into v_id;
  update public.portal_sessions set revoked_at = now() where access_id = v_id and revoked_at is null;
  return v_id;
end;
$$;

create or replace function public.portal_access_set_expiry(p_person uuid, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  update public.portal_accesses set expires_at = p_expires_at where person_id = p_person;
  if not found then raise exception 'Aucun accès pour ce contact' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.portal_access_revoke(p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform portal_private.assert_owner_user();
  update public.portal_accesses set revoked_at = coalesce(revoked_at, now()) where person_id = p_person returning id into v_id;
  if v_id is null then raise exception 'Aucun accès pour ce contact' using errcode = 'P0002'; end if;
  update public.portal_sessions set revoked_at = now() where access_id = v_id and revoked_at is null;
end;
$$;

-- Vue d'administration : un projet avec ses compteurs (les phases suivantes enrichissent cette vue)
create or replace view public.project_overview with (security_invoker = true) as
  select p.*, c.name as company_name,
         (select count(*) from public.project_members m where m.project_id = p.id)::int as member_count
    from public.projects p
    join public.companies c on c.id = p.company_id;
revoke all on public.project_overview from anon;
grant select on public.project_overview to authenticated;

-- ---------------------------------------------------------------------------
-- Portail (serveur + session du client)
-- ---------------------------------------------------------------------------

-- Connexion par code. Limitation : 8 échecs par adresse IP en 15 minutes, 200 échecs au total par minute.
create or replace function public.portal_login(p_server_key text, p_code_hash text, p_ip_hash text, p_session_hash text, p_user_agent text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.portal_accesses;
  v_name text;
begin
  perform portal_private.assert_server(p_server_key);
  if (select count(*) from public.portal_login_attempts where ip_hash = p_ip_hash and not success and created_at > now() - interval '15 minutes') >= 8
     or (select count(*) from public.portal_login_attempts where not success and created_at > now() - interval '1 minute') >= 200 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  select * into a from public.portal_accesses where code_hash = p_code_hash;
  if not found or a.revoked_at is not null or (a.expires_at is not null and a.expires_at <= now())
     or not exists (select 1 from portal_private.visible_projects(a.person_id)) then
    insert into public.portal_login_attempts (ip_hash, success) values (p_ip_hash, false);
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.portal_login_attempts (ip_hash, success) values (p_ip_hash, true);
  insert into public.portal_sessions (access_id, token_hash, user_agent, expires_at)
  values (a.id, p_session_hash, left(p_user_agent, 300),
          least(now() + interval '30 days', coalesce(a.expires_at, now() + interval '30 days')));
  update public.portal_accesses set last_used_at = now() where id = a.id;
  -- ménage : tentatives anciennes et sessions périmées
  delete from public.portal_login_attempts where created_at < now() - interval '1 day';
  delete from public.portal_sessions where expires_at < now() - interval '30 days';
  select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) into v_name from public.people where id = a.person_id;
  return jsonb_build_object('status', 'ok', 'name', v_name);
end;
$$;

create or replace function public.portal_logout(p_server_key text, p_session_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_server(p_server_key);
  update public.portal_sessions set revoked_at = now() where token_hash = p_session_hash and revoked_at is null;
end;
$$;

-- Identité et projets de la session
create or replace function public.portal_me(p_server_key text, p_session_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  return jsonb_build_object(
    'person', (select jsonb_build_object('id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'company', c.name)
                 from public.people p join public.companies c on c.id = p.company_id where p.id = v_person),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'read_only', v.read_only) order by p.status = 'archive', p.created_at desc)
        from portal_private.visible_projects(v_person) v join public.projects p on p.id = v.project_id), '[]'));
end;
$$;

-- Contenu publié d'un projet (base commune au portail et à la prévisualisation administrateur).
-- Seuls des champs explicitement destinés au client sont renvoyés.
create or replace function portal_private.project_view(p_project uuid, p_person uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'status', p.status,
    'start_date', p.start_date, 'end_date', p.end_date, 'client_update', p.client_update,
    'read_only', p.status = 'archive', 'company', c.name, 'updated_at', p.updated_at)
    from public.projects p join public.companies c on c.id = p.company_id
   where p.id = p_project;
$$;

create or replace function public.portal_project(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return portal_private.project_view(p_project, v_person);
end;
$$;

-- Prévisualisation administrateur : mêmes règles que le portail, pour un contact donné.
create or replace function public.portal_preview_project(p_project uuid, p_person uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.project_members where project_id = p_project and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  return portal_private.project_view(p_project, p_person);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'project_create(jsonb, uuid[])', 'project_add_member(uuid, uuid)', 'project_remove_member(uuid, uuid)',
    'portal_access_issue(uuid, text, text, timestamptz)', 'portal_access_set_expiry(uuid, timestamptz)',
    'portal_access_revoke(uuid)', 'portal_preview_project(uuid, uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'portal_login(text, text, text, text, text)', 'portal_logout(text, text)', 'portal_me(text, text)', 'portal_project(text, text, uuid)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
