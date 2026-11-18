-- Onboarding de l'offre découverte (test à 500 € : 300 contacts, 3 cibles, email + LinkedIn, 28 jours).
-- Migration additive. Rien n'est créé pour les projets existants : l'offre est décochée par défaut.
--
--   discovery_settings      réglage unique : adresse à inviter dans le workspace lemlist du client
--   discovery_onboardings   un par projet : case « Offre découverte », état (non commencé, en cours, envoyé)
--   discovery_answers       réponses du questionnaire (clé → texte), avec une révision par réponse
--   discovery_steps         état de chaque étape (fait, sans objet, plus tard)
--   discovery_progress      écran où chaque contact s'est arrêté (reprise exacte)
--   discovery_files         dépôts (blacklist, archives LinkedIn, autres documents) : référence vers company_files
--   discovery_targets       les 3 cibles, préremplies par moi, validées ou complétées par le client
--   discovery_target_comments commentaires du client sur une cible
--   discovery_changes       ce que le client modifie après l'envoi
--
-- Accès :
--   - Le propriétaire lit tout (RLS) et écrit par les fonctions discovery_* (application uniquement).
--   - Un contact n'a aucun droit sur les tables : il passe par les fonctions portal_discovery_*, qui revérifient
--     la session, l'appartenance au projet (portal_private.assert_project), la publication, l'archivage et
--     la case « Offre découverte ». Un projet d'un autre client répond « introuvable ».
--   - Deux contacts en même temps : chaque réponse et chaque cible porte une révision ; une écriture faite sur
--     une révision dépassée est refusée et renvoie la valeur actuelle et son auteur (rien n'est écrasé en silence).
--
-- Fichiers : réutilise company_files (documents de la fiche) et project_files (dossier interne du projet
-- « Onboarding offre découverte »). Les archives LinkedIn pèsent souvent des centaines de Mo : la limite de la
-- table et du bucket passe à 1 Gio ; chaque circuit garde sa propre limite (25 Mo ailleurs, contrôlée en base
-- ou par l'application), et l'onboarding applique les siennes par étape.

create schema if not exists discovery_private;
revoke all on schema discovery_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.discovery_settings (
  id boolean primary key default true check (id),
  lemlist_invite_email text check (lemlist_invite_email is null or (char_length(lemlist_invite_email) <= 254 and lemlist_invite_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')),
  updated_at timestamptz not null default now()
);
insert into public.discovery_settings (id) values (true) on conflict do nothing;

create table public.discovery_onboardings (
  project_id uuid primary key references public.projects (id) on delete cascade,
  enabled boolean not null default false,
  -- owner : cochée à la main ; sale : cochée d'après la vente (mission « offre découverte »)
  enabled_source text not null default 'owner' check (enabled_source in ('owner', 'sale')),
  started_at timestamptz,
  sent_at timestamptz,
  sent_by uuid references public.people (id) on delete set null,
  sent_task_id uuid references public.project_tasks (id) on delete set null,
  changed_after_send_at timestamptz,
  change_task_id uuid references public.project_tasks (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.discovery_onboardings for each row execute function public.tg_set_updated_at();

create table public.discovery_answers (
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9_]{1,60}$'),
  value text not null check (char_length(value) <= 5000),
  rev integer not null default 1,
  updated_by uuid references public.people (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, key)
);

create table public.discovery_steps (
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  step text not null check (step in ('welcome', 'offer', 'lemlist', 'blacklist', 'linkedin', 'documents', 'targets')),
  -- done : terminée ; none : « Je n'en ai pas » / rien à ajouter ; later : « Je l'ajouterai plus tard »
  status text not null check (status in ('done', 'none', 'later')),
  updated_by uuid references public.people (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (project_id, step)
);

create table public.discovery_progress (
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  screen text not null check (screen ~ '^[a-z0-9_:.-]{1,60}$'),
  updated_at timestamptz not null default now(),
  primary key (project_id, person_id)
);

create table public.discovery_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  step text not null check (step in ('blacklist', 'linkedin', 'documents')),
  file_id uuid not null unique references public.company_files (id) on delete cascade,
  -- archive LinkedIn : nom de la personne dont c'est le compte
  account_name text check (account_name is null or char_length(btrim(account_name)) between 1 and 120),
  person_id uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now(),
  check (step <> 'linkedin' or account_name is not null)
);
create index discovery_files_project_idx on public.discovery_files (project_id, step, created_at);

create table public.discovery_targets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  position smallint not null check (position between 1 and 3),
  name text not null default '' check (char_length(name) <= 120),
  sector text not null default '' check (char_length(sector) <= 300),
  company_size text not null default '' check (char_length(company_size) <= 120),
  roles text not null default '' check (char_length(roles) <= 500),
  geography text not null default '' check (char_length(geography) <= 300),
  notes text not null default '' check (char_length(notes) <= 2000),
  -- champs que le client a remplis lui-même (ils étaient vides)
  client_filled text[] not null default '{}',
  validated_at timestamptz,
  validated_by uuid references public.people (id) on delete set null,
  modified_since_validation boolean not null default false,
  rev integer not null default 1,
  owner_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (project_id, position)
);

create table public.discovery_target_comments (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references public.discovery_targets (id) on delete cascade,
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  person_id uuid references public.people (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  task_id uuid references public.project_tasks (id) on delete set null,
  created_at timestamptz not null default now()
);
create index discovery_target_comments_idx on public.discovery_target_comments (target_id, created_at);

create table public.discovery_changes (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.discovery_onboardings (project_id) on delete cascade,
  person_id uuid references public.people (id) on delete set null,
  kind text not null check (kind in ('answer', 'step', 'file_added', 'file_removed', 'target_filled', 'target_validated', 'target_comment')),
  label text not null check (char_length(label) <= 300),
  before text check (before is null or char_length(before) <= 5000),
  after text check (after is null or char_length(after) <= 5000),
  created_at timestamptz not null default now()
);
create index discovery_changes_idx on public.discovery_changes (project_id, id desc);

do $$
declare t text;
begin
  foreach t in array array['discovery_settings', 'discovery_onboardings', 'discovery_answers', 'discovery_steps', 'discovery_progress',
                           'discovery_files', 'discovery_targets', 'discovery_target_comments', 'discovery_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    -- lecture seule pour le propriétaire (et Claude) ; toute écriture passe par les fonctions ci-dessous
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Limites de taille. La base garde 25 Mo pour tous les documents, sauf les dépôts d'onboarding (archives
-- LinkedIn jusqu'à 1 Gio) : seule portal_discovery_file_start lève ce plafond, le temps de son insertion
-- (réglage de transaction, inaccessible depuis l'API). Le bucket passe à 1 Gio pour que Storage accepte ces
-- archives ; chaque circuit garde son contrôle en base.
-- ---------------------------------------------------------------------------
alter table public.company_files drop constraint if exists company_files_size_bytes_check;
alter table public.company_files add constraint company_files_size_bytes_check check (size_bytes > 0 and size_bytes <= 1073741824);

create or replace function discovery_private.tg_company_files_size()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.size_bytes > 26214400 and coalesce(current_setting('cely.discovery_upload', true), '') <> 'on' then
    raise exception 'Fichier trop volumineux (25 Mo maximum)' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger company_files_size_guard before insert or update of size_bytes on public.company_files
  for each row execute function discovery_private.tg_company_files_size();

update storage.buckets set file_size_limit = 1073741824 where id = 'company-files';

-- ---------------------------------------------------------------------------
-- Outils
-- ---------------------------------------------------------------------------
create or replace function discovery_private.person_name(p_person uuid)
returns text language sql stable set search_path = '' as $$
  select nullif(btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '') from public.people where id = p_person;
$$;

-- Les 3 cibles existent dès que l'onboarding existe (vides si je ne les prépare pas).
create or replace function discovery_private.ensure(p_project uuid, p_enabled boolean, p_source text)
returns void language plpgsql set search_path = '' as $$
begin
  insert into public.discovery_onboardings (project_id, enabled, enabled_source) values (p_project, p_enabled, p_source)
  on conflict (project_id) do nothing;
  insert into public.discovery_targets (project_id, position) select p_project, g from generate_series(1, 3) g
  on conflict (project_id, position) do nothing;
end; $$;

-- Contact → onboarding accessible. Mêmes règles que le reste du portail, plus la case « Offre découverte ».
create or replace function discovery_private.assert(p_person uuid, p_project uuid, p_write boolean)
returns void language plpgsql stable set search_path = '' as $$
begin
  perform portal_private.assert_project(p_person, p_project, p_write);
  if not exists (select 1 from public.discovery_onboardings where project_id = p_project and enabled) then
    raise exception 'Onboarding introuvable' using errcode = 'P0002';
  end if;
end; $$;

-- Après l'envoi, chaque modification du client est tracée, et une seule action « modifié » reste ouverte.
create or replace function discovery_private.touch(p_project uuid, p_person uuid, p_kind text, p_label text, p_before text, p_after text)
returns void language plpgsql set search_path = '' as $$
declare o public.discovery_onboardings; v_task uuid;
begin
  select * into o from public.discovery_onboardings where project_id = p_project;
  if o.started_at is null then
    update public.discovery_onboardings set started_at = now() where project_id = p_project;
  end if;
  if o.sent_at is null then return; end if;
  insert into public.discovery_changes (project_id, person_id, kind, label, before, after)
  values (p_project, p_person, p_kind, left(p_label, 300), left(p_before, 5000), left(p_after, 5000));
  update public.discovery_onboardings set changed_after_send_at = now() where project_id = p_project;
  if o.change_task_id is null or not exists (select 1 from public.project_tasks where id = o.change_task_id and status <> 'termine') then
    insert into public.project_tasks (project_id, title, description, assignee_kind, visible_to_client, due_date, created_by_kind, created_by_person, updated_by_kind, updated_by_person)
    values (p_project, 'Onboarding modifié après envoi : voir les changements',
            'Le client a modifié son onboarding après l''envoi. Les changements sont listés dans le panneau « Onboarding offre découverte » du projet.',
            'owner', false, (now() at time zone 'Europe/Paris')::date, 'client', p_person, 'client', p_person)
    returning id into v_task;
    update public.discovery_onboardings set change_task_id = v_task where project_id = p_project;
  end if;
end; $$;

-- Contenu de l'onboarding vu par un contact (ou par moi en aperçu, p_person nul) : jamais de note interne.
create or replace function discovery_private.view(p_project uuid, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'company', c.name,
                                  'read_only', coalesce((select read_only from portal_private.visible_projects(p_person) where project_id = p.id), p.status = 'archive')),
    'me', case when p_person is null then null else jsonb_build_object('id', p_person, 'first_name', (select first_name from public.people where id = p_person)) end,
    'settings', jsonb_build_object('lemlist_invite_email', (select lemlist_invite_email from public.discovery_settings where id)),
    'started_at', o.started_at, 'sent_at', o.sent_at, 'sent_by', discovery_private.person_name(o.sent_by),
    'position', (select screen from public.discovery_progress where project_id = p.id and person_id = p_person),
    'answers', coalesce((select jsonb_object_agg(a.key, jsonb_build_object('value', a.value, 'rev', a.rev, 'by', discovery_private.person_name(a.updated_by),
                                                                          'mine', a.updated_by = p_person, 'at', a.updated_at))
                           from public.discovery_answers a where a.project_id = p.id), '{}'),
    'steps', coalesce((select jsonb_object_agg(s.step, jsonb_build_object('status', s.status, 'by', discovery_private.person_name(s.updated_by), 'at', s.updated_at))
                         from public.discovery_steps s where s.project_id = p.id), '{}'),
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'step', d.step, 'name', f.display_name, 'size', f.size_bytes, 'account', d.account_name,
                                                          'by', discovery_private.person_name(d.person_id), 'mine', d.person_id = p_person, 'at', d.created_at)
                                        order by d.created_at)
                         from public.discovery_files d join public.company_files f on f.id = d.file_id
                        where d.project_id = p.id and f.status = 'ready'), '[]'),
    'targets', coalesce((select jsonb_agg(jsonb_build_object(
                           'position', t.position, 'name', t.name, 'sector', t.sector, 'company_size', t.company_size, 'roles', t.roles,
                           'geography', t.geography, 'notes', t.notes, 'client_filled', to_jsonb(t.client_filled), 'rev', t.rev,
                           'validated_at', t.validated_at, 'validated_by', discovery_private.person_name(t.validated_by),
                           'modified_since_validation', t.modified_since_validation,
                           'comments', coalesce((select jsonb_agg(jsonb_build_object('id', cm.id, 'body', cm.body, 'by', discovery_private.person_name(cm.person_id),
                                                                                     'mine', cm.person_id = p_person, 'at', cm.created_at) order by cm.created_at)
                                                   from public.discovery_target_comments cm where cm.target_id = t.id), '[]'))
                         order by t.position)
                           from public.discovery_targets t where t.project_id = p.id), '[]'))
    from public.discovery_onboardings o
    join public.projects p on p.id = o.project_id
    join public.companies c on c.id = p.company_id
   where o.project_id = p_project;
$$;

-- ---------------------------------------------------------------------------
-- Propriétaire (application ; Claude lit seulement)
-- ---------------------------------------------------------------------------
create or replace function public.discovery_set_enabled(p_project uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.projects where id = p_project) then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
  perform discovery_private.ensure(p_project, p_enabled, 'owner');
  -- décocher masque l'onglet : réponses, fichiers et cibles sont conservés
  update public.discovery_onboardings set enabled = p_enabled, enabled_source = 'owner' where project_id = p_project and enabled is distinct from p_enabled;
  if found then perform portal_private.log(p_project, 'owner', null, case when p_enabled then 'discovery_enabled' else 'discovery_disabled' end); end if;
  return jsonb_build_object('enabled', p_enabled);
end; $$;

create or replace function public.discovery_settings_save(p_lemlist_invite_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform portal_private.assert_owner_user();
  update public.discovery_settings set lemlist_invite_email = nullif(btrim(lower(p_lemlist_invite_email)), ''), updated_at = now() where id;
end; $$;

-- Cibles préparées par moi. Une cible déjà validée par le client et modifiée ici perd sa validation et
-- s'affiche « Modifiée depuis ta validation ».
create or replace function public.discovery_target_save(p_project uuid, p_position int, p_data jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.discovery_targets; n public.discovery_targets; f text;
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.discovery_onboardings where project_id = p_project) then raise exception 'Onboarding introuvable' using errcode = 'P0002'; end if;
  if p_position not between 1 and 3 then raise exception 'Cible inconnue' using errcode = '22023'; end if;
  perform discovery_private.ensure(p_project, false, 'owner');
  select * into t from public.discovery_targets where project_id = p_project and position = p_position for update;
  n := t;
  n.name := btrim(coalesce(p_data ->> 'name', t.name));
  n.sector := btrim(coalesce(p_data ->> 'sector', t.sector));
  n.company_size := btrim(coalesce(p_data ->> 'company_size', t.company_size));
  n.roles := btrim(coalesce(p_data ->> 'roles', t.roles));
  n.geography := btrim(coalesce(p_data ->> 'geography', t.geography));
  n.notes := btrim(coalesce(p_data ->> 'notes', t.notes));
  if (n.name, n.sector, n.company_size, n.roles, n.geography, n.notes) is not distinct from (t.name, t.sector, t.company_size, t.roles, t.geography, t.notes) then
    return jsonb_build_object('rev', t.rev, 'changed', false);
  end if;
  -- un champ que je réécris n'est plus « rempli par le client »
  foreach f in array t.client_filled loop
    if (case f when 'name' then n.name is distinct from t.name when 'sector' then n.sector is distinct from t.sector
              when 'company_size' then n.company_size is distinct from t.company_size when 'roles' then n.roles is distinct from t.roles
              when 'geography' then n.geography is distinct from t.geography when 'notes' then n.notes is distinct from t.notes else false end) then
      n.client_filled := array_remove(n.client_filled, f);
    end if;
  end loop;
  update public.discovery_targets
     set name = n.name, sector = n.sector, company_size = n.company_size, roles = n.roles, geography = n.geography, notes = n.notes,
         client_filled = n.client_filled, rev = t.rev + 1, owner_updated_at = now(), updated_at = now(),
         modified_since_validation = t.validated_at is not null or t.modified_since_validation,
         validated_at = null, validated_by = null
   where id = t.id;
  return jsonb_build_object('rev', t.rev + 1, 'changed', true, 'validation_dropped', t.validated_at is not null);
end; $$;

-- Aperçu « Voir comme le client » : même contenu que le portail, en lecture seule.
create or replace function public.discovery_preview(p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  if not exists (select 1 from public.discovery_onboardings where project_id = p_project) then raise exception 'Onboarding introuvable' using errcode = 'P0002'; end if;
  return discovery_private.view(p_project, null);
end; $$;

-- Panneau de suivi (et connecteur Claude) : contenu client + état interne (changements, actions, contacts).
create or replace function public.discovery_admin(p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.discovery_onboardings;
begin
  perform public.assert_owner();
  select * into o from public.discovery_onboardings where project_id = p_project;
  if not found then
    return jsonb_build_object('exists', false, 'enabled', false,
      'suggested', exists (select 1 from public.sales s join public.finance_missions m on m.id = s.mission_id
                            where s.project_id = p_project and m.label ~* 'd[ée]couverte'));
  end if;
  return discovery_private.view(p_project, null) || jsonb_build_object(
    'exists', true, 'enabled', o.enabled, 'enabled_source', o.enabled_source, 'changed_after_send_at', o.changed_after_send_at,
    'sent_task_id', o.sent_task_id,
    'changes', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'label', x.label, 'before', x.before, 'after', x.after,
                                                             'by', discovery_private.person_name(x.person_id), 'at', x.created_at) order by x.id desc)
                           from (select * from public.discovery_changes where project_id = p_project order by id desc limit 200) x), '[]'),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', pp.id, 'name', discovery_private.person_name(pp.id),
                                                              'position', (select screen from public.discovery_progress g where g.project_id = p_project and g.person_id = pp.id),
                                                              'seen_at', (select updated_at from public.discovery_progress g where g.project_id = p_project and g.person_id = pp.id)))
                            from public.project_members m join public.people pp on pp.id = m.person_id where m.project_id = p_project), '[]'));
end; $$;

-- Une nouvelle vente dont la mission s'appelle « … découverte … » coche l'offre (jamais rétroactivement :
-- seulement quand la vente est créée ou liée à un projet après cette migration, et sans écraser mon choix).
create or replace function discovery_private.tg_sales_discovery()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null and new.mission_id is not null
     and exists (select 1 from public.finance_missions m where m.id = new.mission_id and m.label ~* 'd[ée]couverte')
     and not exists (select 1 from public.discovery_onboardings where project_id = new.project_id) then
    perform discovery_private.ensure(new.project_id, true, 'sale');
  end if;
  return null;
end; $$;
create trigger sales_discovery after insert or update of project_id, mission_id on public.sales
  for each row execute function discovery_private.tg_sales_discovery();

-- ---------------------------------------------------------------------------
-- Portail (contact authentifié par sa session)
-- ---------------------------------------------------------------------------
-- Onglet visible ? (sans erreur : le portail n'affiche simplement pas l'onglet)
create or replace function public.portal_discovery_enabled(p_server_key text, p_session_hash text, p_project uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  return exists (select 1 from portal_private.visible_projects(v_person) v join public.discovery_onboardings o on o.project_id = v.project_id
                  where v.project_id = p_project and o.enabled);
end; $$;

create or replace function public.portal_discovery(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform discovery_private.assert(v_person, p_project, false);
  return discovery_private.view(p_project, v_person);
end; $$;

-- Reprise : écran courant du contact
create or replace function public.portal_discovery_position(p_server_key text, p_session_hash text, p_project uuid, p_screen text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform discovery_private.assert(v_person, p_project, false);
  if p_screen !~ '^[a-z0-9_:.-]{1,60}$' then raise exception 'Écran inconnu' using errcode = '22023'; end if;
  insert into public.discovery_progress (project_id, person_id, screen) values (p_project, v_person, p_screen)
  on conflict (project_id, person_id) do update set screen = excluded.screen, updated_at = now();
  update public.discovery_onboardings set started_at = coalesce(started_at, now()) where project_id = p_project and started_at is null;
end; $$;

-- Réponse : p_base_rev = révision lue (0 si aucune). Révision dépassée → conflit, rien n'est écrit.
create or replace function public.portal_discovery_answer(p_server_key text, p_session_hash text, p_project uuid, p_key text, p_value text, p_base_rev int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  a public.discovery_answers;
  v_value text := btrim(coalesce(p_value, ''));
begin
  perform discovery_private.assert(v_person, p_project, true);
  if p_key !~ '^[a-z0-9_]{1,60}$' then raise exception 'Question inconnue' using errcode = '22023'; end if;
  if char_length(v_value) > 5000 then raise exception 'Réponse trop longue (5 000 caractères au plus)' using errcode = '22023'; end if;
  select * into a from public.discovery_answers where project_id = p_project and key = p_key for update;
  if found then
    if a.value = v_value then return jsonb_build_object('ok', true, 'rev', a.rev); end if;
    if a.rev <> coalesce(p_base_rev, 0) then
      return jsonb_build_object('ok', false, 'conflict', true, 'value', a.value, 'rev', a.rev, 'by', discovery_private.person_name(a.updated_by), 'at', a.updated_at);
    end if;
    update public.discovery_answers set value = v_value, rev = a.rev + 1, updated_by = v_person, updated_at = now() where project_id = p_project and key = p_key;
    perform discovery_private.touch(p_project, v_person, 'answer', p_key, a.value, v_value);
    return jsonb_build_object('ok', true, 'rev', a.rev + 1);
  end if;
  if coalesce(p_base_rev, 0) <> 0 then
    raise exception 'Réponse introuvable : rechargez la page' using errcode = '22023';
  end if;
  if (select count(*) from public.discovery_answers where project_id = p_project) >= 60 then raise exception 'Trop de réponses' using errcode = '22023'; end if;
  insert into public.discovery_answers (project_id, key, value, updated_by) values (p_project, p_key, v_value, v_person);
  perform discovery_private.touch(p_project, v_person, 'answer', p_key, null, v_value);
  return jsonb_build_object('ok', true, 'rev', 1);
end; $$;

-- État d'une étape (null : rouvrir l'étape)
create or replace function public.portal_discovery_step(p_server_key text, p_session_hash text, p_project uuid, p_step text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash); v_before text;
begin
  perform discovery_private.assert(v_person, p_project, true);
  if p_step not in ('welcome', 'offer', 'lemlist', 'blacklist', 'linkedin', 'documents', 'targets') then raise exception 'Étape inconnue' using errcode = '22023'; end if;
  if p_status is not null and p_status not in ('done', 'none', 'later') then raise exception 'État inconnu' using errcode = '22023'; end if;
  select status into v_before from public.discovery_steps where project_id = p_project and step = p_step;
  if v_before is not distinct from p_status then return jsonb_build_object('ok', true); end if;
  if p_status is null then
    delete from public.discovery_steps where project_id = p_project and step = p_step;
  else
    insert into public.discovery_steps (project_id, step, status, updated_by) values (p_project, p_step, p_status, v_person)
    on conflict (project_id, step) do update set status = excluded.status, updated_by = excluded.updated_by, updated_at = now();
  end if;
  perform discovery_private.touch(p_project, v_person, 'step', p_step, v_before, p_status);
  return jsonb_build_object('ok', true);
end; $$;

-- ---------------------------------------------------------------------------
-- Dépôts : référence dans la fiche (company_files) et dans le dossier interne du projet
-- ---------------------------------------------------------------------------
create or replace function discovery_private.folder(p_project uuid)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  select id into v_id from public.project_folders where project_id = p_project and parent_id is null and name = 'Onboarding offre découverte' limit 1;
  if v_id is null then
    insert into public.project_folders (project_id, name, visible_to_client, client_can_upload) values (p_project, 'Onboarding offre découverte', false, false)
    returning id into v_id;
  end if;
  return v_id;
end; $$;

-- Types et tailles autorisés par étape (le serveur Next déduit le type de l'extension, jamais du navigateur).
create or replace function discovery_private.file_rules(p_step text, p_type text, p_size bigint)
returns void language plpgsql immutable set search_path = '' as $$
declare v_max bigint; v_types text[];
begin
  case p_step
    when 'blacklist' then
      v_max := 52428800; -- 50 Mo
      v_types := array['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
    when 'linkedin' then
      v_max := 1073741824; -- 1 Gio
      v_types := array['application/zip'];
    when 'documents' then
      v_max := 104857600; -- 100 Mo
      v_types := array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/plain', 'text/csv', 'application/zip'];
    else raise exception 'Étape inconnue' using errcode = '22023';
  end case;
  if p_type is null or not (p_type = any (v_types)) then raise exception 'Format non accepté pour cette étape' using errcode = '22023'; end if;
  if p_size is null or p_size <= 0 then raise exception 'Ce fichier est vide' using errcode = '22023'; end if;
  if p_size > v_max then
    raise exception 'Fichier trop volumineux (% maximum pour cette étape)', case p_step when 'linkedin' then '1 Go' when 'blacklist' then '50 Mo' else '100 Mo' end using errcode = '22023';
  end if;
end; $$;

create or replace function public.portal_discovery_file_start(
  p_server_key text, p_session_hash text, p_project uuid, p_step text, p_name text, p_type text, p_size bigint, p_ext text, p_account text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  v_company uuid;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform discovery_private.assert(v_person, p_project, true);
  perform discovery_private.file_rules(p_step, p_type, p_size);
  if coalesce(btrim(p_name), '') = '' then raise exception 'Nom de fichier manquant' using errcode = '22023'; end if;
  if p_step = 'linkedin' and coalesce(btrim(p_account), '') = '' then raise exception 'Indiquez à qui appartient ce compte LinkedIn' using errcode = '22023'; end if;
  if (select count(*) from public.company_files where uploaded_by_person = v_person and created_at > now() - interval '1 hour') >= 50 then
    raise exception 'Trop de dépôts en peu de temps : réessayez dans une heure' using errcode = '22023';
  end if;
  if (select count(*) from public.discovery_files where project_id = p_project) >= 100 then raise exception 'Nombre maximal de fichiers atteint' using errcode = '22023'; end if;
  select company_id into v_company from public.projects where id = p_project;
  v_path := v_company::text || '/' || v_id::text || '.' || coalesce(nullif(lower(regexp_replace(coalesce(p_ext, ''), '[^a-zA-Z0-9]', '', 'g')), ''), 'bin');
  -- plafond de 25 Mo levé pour cette seule insertion (limites de l'étape déjà vérifiées ci-dessus)
  perform set_config('cely.discovery_upload', 'on', true);
  insert into public.company_files (id, company_id, storage_path, display_name, category, mime_type, size_bytes, status, uploaded_by_kind, uploaded_by_person)
  values (v_id, v_company, v_path, left(btrim(p_name), 200), 'Autre', p_type, p_size, 'pending', 'client', v_person);
  perform set_config('cely.discovery_upload', 'off', true);
  insert into public.project_files (project_id, file_id, folder_id, shared_by_kind, shared_by_person)
  values (p_project, v_id, discovery_private.folder(p_project), 'client', v_person);
  insert into public.discovery_files (project_id, step, file_id, account_name, person_id)
  values (p_project, p_step, v_id, nullif(left(btrim(coalesce(p_account, '')), 120), ''), v_person);
  return jsonb_build_object('file_id', v_id, 'path', v_path);
end; $$;

-- Reprise d'un envoi interrompu (même fichier, même personne, moins de 24 h) : renvoie le chemin déjà réservé.
create or replace function public.portal_discovery_file_resume(p_server_key text, p_session_hash text, p_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash); r record;
begin
  select f.storage_path, d.project_id into r from public.company_files f join public.discovery_files d on d.file_id = f.id
   where f.id = p_file and f.uploaded_by_person = v_person and f.status = 'pending' and f.created_at > now() - interval '23 hours';
  if not found then raise exception 'Envoi introuvable' using errcode = 'P0002'; end if;
  perform discovery_private.assert(v_person, r.project_id, true);
  return jsonb_build_object('file_id', p_file, 'path', r.storage_path);
end; $$;

create or replace function public.portal_discovery_file_confirm(p_server_key text, p_session_hash text, p_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash); f public.company_files; d public.discovery_files;
begin
  select * into f from public.company_files where id = p_file and uploaded_by_person = v_person and status = 'pending' for update;
  if not found then
    -- double confirmation (reprise réseau) : déjà prêt, rien à refaire
    select * into d from public.discovery_files where file_id = p_file and person_id = v_person;
    if found and exists (select 1 from public.company_files where id = p_file and status = 'ready') then return jsonb_build_object('ok', true, 'id', d.id); end if;
    raise exception 'Dépôt introuvable' using errcode = 'P0002';
  end if;
  select * into d from public.discovery_files where file_id = p_file;
  if not found then raise exception 'Dépôt introuvable' using errcode = 'P0002'; end if;
  perform discovery_private.assert(v_person, d.project_id, true);
  if not exists (select 1 from storage.objects o where o.bucket_id = 'company-files' and o.name = f.storage_path) then
    raise exception 'Le fichier n''a pas été reçu par le stockage' using errcode = '22023';
  end if;
  update public.company_files set status = 'ready' where id = p_file;
  perform portal_private.log(d.project_id, 'client', v_person, 'discovery_file', jsonb_build_object('file_id', p_file, 'step', d.step));
  perform discovery_private.touch(d.project_id, v_person, 'file_added', d.step, null, f.display_name);
  return jsonb_build_object('ok', true, 'id', d.id);
end; $$;

create or replace function public.portal_discovery_file_abort(p_server_key text, p_session_hash text, p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  delete from public.company_files where id = p_file and uploaded_by_person = v_person and status = 'pending'
     and exists (select 1 from public.discovery_files d where d.file_id = p_file);
end; $$;

-- Retirer un dépôt de l'onboarding (seulement le sien) : le document reste dans la fiche et le projet.
create or replace function public.portal_discovery_file_remove(p_server_key text, p_session_hash text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash); d public.discovery_files; v_name text;
begin
  select * into d from public.discovery_files where id = p_id;
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform discovery_private.assert(v_person, d.project_id, true);
  if d.person_id is distinct from v_person then raise exception 'Seule la personne qui a déposé ce fichier peut le retirer' using errcode = '42501'; end if;
  select display_name into v_name from public.company_files where id = d.file_id;
  delete from public.discovery_files where id = p_id;
  perform discovery_private.touch(d.project_id, v_person, 'file_removed', d.step, v_name, null);
end; $$;

-- Téléchargement par un contact du projet : objet précis, 60 secondes.
create or replace function public.portal_discovery_file_grant(p_server_key text, p_session_hash text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash); r record;
begin
  select d.project_id, f.storage_path, f.display_name, f.mime_type into r
    from public.discovery_files d join public.company_files f on f.id = d.file_id where d.id = p_id and f.status = 'ready';
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform discovery_private.assert(v_person, r.project_id, false);
  delete from public.portal_storage_grants where expires_at < now() - interval '1 hour';
  insert into public.portal_storage_grants (object_name, action, expires_at) values (r.storage_path, 'read', now() + interval '60 seconds');
  return jsonb_build_object('path', r.storage_path, 'name', r.display_name, 'mime_type', r.mime_type);
end; $$;

-- Storage : un dépôt d'onboarding en attente peut être envoyé pendant 24 h (gros fichiers, reprise après coupure).
create or replace function public.discovery_storage_can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_files f join public.discovery_files d on d.file_id = f.id
                  where f.storage_path = p_name and f.status = 'pending' and f.uploaded_by_kind = 'client'
                    and f.created_at > now() - interval '24 hours');
$$;
create policy discovery_files_insert on storage.objects for insert to anon
  with check (bucket_id = 'company-files' and public.discovery_storage_can_upload(name));

-- ---------------------------------------------------------------------------
-- Les 3 cibles côté client
-- ---------------------------------------------------------------------------
create or replace function discovery_private.target_conflict(t public.discovery_targets)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'conflict', true, 'rev', t.rev,
    'target', jsonb_build_object('name', t.name, 'sector', t.sector, 'company_size', t.company_size, 'roles', t.roles, 'geography', t.geography, 'notes', t.notes,
                                 'client_filled', to_jsonb(t.client_filled), 'modified_since_validation', t.modified_since_validation));
$$;

-- Champ vide (ou rempli par le client) : le client peut le compléter. Ce que j'ai prérempli ne se modifie pas
-- (il le commente).
create or replace function public.portal_discovery_target_fill(p_server_key text, p_session_hash text, p_project uuid, p_position int, p_field text, p_value text, p_base_rev int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.discovery_targets;
  v_value text := btrim(coalesce(p_value, ''));
  v_current text;
  v_max int;
begin
  perform discovery_private.assert(v_person, p_project, true);
  select * into t from public.discovery_targets where project_id = p_project and position = p_position for update;
  if not found then raise exception 'Cible introuvable' using errcode = 'P0002'; end if;
  v_max := case p_field when 'name' then 120 when 'sector' then 300 when 'company_size' then 120 when 'roles' then 500 when 'geography' then 300 when 'notes' then 2000 end;
  if v_max is null then raise exception 'Champ inconnu' using errcode = '22023'; end if;
  if char_length(v_value) > v_max then raise exception 'Texte trop long (% caractères au plus)', v_max using errcode = '22023'; end if;
  if t.rev <> coalesce(p_base_rev, 0) then return discovery_private.target_conflict(t); end if;
  v_current := (to_jsonb(t) ->> p_field);
  if v_current <> '' and not (p_field = any (t.client_filled)) then
    raise exception 'Ce champ a été préparé par Cely Growth : ajoutez plutôt un commentaire' using errcode = '42501';
  end if;
  if v_current = v_value then return jsonb_build_object('ok', true, 'rev', t.rev); end if;
  execute format('update public.discovery_targets set %I = $1, rev = rev + 1, updated_at = now(), client_filled = case when $1 = '''' then array_remove(client_filled, $2) when $2 = any (client_filled) then client_filled else client_filled || $2 end where id = $3', p_field)
    using v_value, p_field, t.id;
  perform discovery_private.touch(p_project, v_person, 'target_filled', 'Cible ' || p_position || ' · ' || p_field, nullif(v_current, ''), nullif(v_value, ''));
  return jsonb_build_object('ok', true, 'rev', t.rev + 1);
end; $$;

create or replace function public.portal_discovery_target_validate(p_server_key text, p_session_hash text, p_project uuid, p_position int, p_base_rev int, p_valid boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash); t public.discovery_targets;
begin
  perform discovery_private.assert(v_person, p_project, true);
  select * into t from public.discovery_targets where project_id = p_project and position = p_position for update;
  if not found then raise exception 'Cible introuvable' using errcode = 'P0002'; end if;
  -- je viens de modifier la cible : le client valide ce qu'il voit, pas une version périmée
  if t.rev <> coalesce(p_base_rev, 0) then return discovery_private.target_conflict(t); end if;
  if p_valid then
    if t.validated_at is not null then return jsonb_build_object('ok', true, 'rev', t.rev); end if;
    update public.discovery_targets set validated_at = now(), validated_by = v_person, modified_since_validation = false, updated_at = now() where id = t.id;
  else
    if t.validated_at is null then return jsonb_build_object('ok', true, 'rev', t.rev); end if;
    update public.discovery_targets set validated_at = null, validated_by = null, updated_at = now() where id = t.id;
  end if;
  perform discovery_private.touch(p_project, v_person, 'target_validated', 'Cible ' || p_position || coalesce(' · ' || nullif(t.name, ''), ''),
                                  case when p_valid then null else 'validée' end, case when p_valid then 'validée' else null end);
  return jsonb_build_object('ok', true, 'rev', t.rev);
end; $$;

-- Commentaire sur une cible : crée aussi une action pour moi (Aujourd'hui).
create or replace function public.portal_discovery_target_comment(p_server_key text, p_session_hash text, p_project uuid, p_position int, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.discovery_targets;
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
  v_task uuid;
  v_label text;
begin
  perform discovery_private.assert(v_person, p_project, true);
  if char_length(v_body) not between 1 and 2000 then raise exception 'Commentaire vide ou trop long (2 000 caractères au plus)' using errcode = '22023'; end if;
  select * into t from public.discovery_targets where project_id = p_project and position = p_position;
  if not found then raise exception 'Cible introuvable' using errcode = 'P0002'; end if;
  -- même commentaire renvoyé dans la minute (double clic, reprise réseau) : un seul commentaire, une seule action
  select id into v_id from public.discovery_target_comments
   where target_id = t.id and person_id = v_person and body = v_body and created_at > now() - interval '1 minute';
  if v_id is not null then return jsonb_build_object('ok', true, 'id', v_id); end if;
  if (select count(*) from public.discovery_target_comments where project_id = p_project and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Trop de commentaires en peu de temps : réessayez plus tard' using errcode = '22023';
  end if;
  v_label := 'Cible ' || p_position || coalesce(' (' || nullif(t.name, '') || ')', '');
  insert into public.project_tasks (project_id, title, description, assignee_kind, visible_to_client, due_date, created_by_kind, created_by_person, updated_by_kind, updated_by_person)
  values (p_project, left('Onboarding : commentaire sur la ' || lower(left(v_label, 1)) || substr(v_label, 2) || ' à traiter', 300),
          left(coalesce(discovery_private.person_name(v_person), 'Le client') || ' a écrit : « ' || v_body || ' »', 5000),
          'owner', false, (now() at time zone 'Europe/Paris')::date, 'client', v_person, 'client', v_person)
  returning id into v_task;
  insert into public.discovery_target_comments (target_id, project_id, person_id, body, task_id) values (t.id, p_project, v_person, v_body, v_task) returning id into v_id;
  perform portal_private.log(p_project, 'client', v_person, 'discovery_target_comment', jsonb_build_object('position', p_position));
  perform discovery_private.touch(p_project, v_person, 'target_comment', v_label, null, v_body);
  return jsonb_build_object('ok', true, 'id', v_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Envoi : une seule fois, une seule action « Onboarding reçu, à traiter », même avec un double clic.
-- ---------------------------------------------------------------------------
create or replace function public.portal_discovery_send(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  o public.discovery_onboardings;
  v_task uuid;
  v_company uuid;
begin
  perform discovery_private.assert(v_person, p_project, true);
  select * into o from public.discovery_onboardings where project_id = p_project for update;
  if o.sent_at is not null then
    return jsonb_build_object('ok', true, 'already', true, 'sent_at', o.sent_at, 'sent_by', discovery_private.person_name(o.sent_by));
  end if;
  insert into public.project_tasks (project_id, title, description, assignee_kind, visible_to_client, due_date, created_by_kind, created_by_person, updated_by_kind, updated_by_person)
  values (p_project, 'Onboarding reçu, à traiter',
          'Envoyé par ' || coalesce(discovery_private.person_name(v_person), 'le client') || '. Réponses, fichiers et cibles : panneau « Onboarding offre découverte » du projet.',
          'owner', false, (now() at time zone 'Europe/Paris')::date, 'client', v_person, 'client', v_person)
  returning id into v_task;
  update public.discovery_onboardings set sent_at = now(), sent_by = v_person, sent_task_id = v_task, started_at = coalesce(started_at, now())
   where project_id = p_project;
  select company_id into v_company from public.projects where id = p_project;
  insert into public.interactions (company_id, kind, content, content_origin, source, meta)
  values (v_company, 'system', 'Onboarding offre découverte reçu', 'system', 'user', jsonb_build_object('project_id', p_project));
  perform portal_private.log(p_project, 'client', v_person, 'discovery_sent');
  return jsonb_build_object('ok', true, 'already', false, 'sent_at', now(), 'sent_by', discovery_private.person_name(v_person));
end; $$;

-- ---------------------------------------------------------------------------
-- Droits d'exécution : fonctions du portail pour anon (contrôle par session), le reste pour authenticated.
-- ---------------------------------------------------------------------------
revoke all on all functions in schema discovery_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['discovery_set_enabled', 'discovery_settings_save', 'discovery_target_save', 'discovery_preview', 'discovery_admin'] loop
    execute format('revoke execute on function public.%I from public, anon', f);
  end loop;
end $$;
grant execute on function public.portal_discovery_enabled, public.portal_discovery, public.portal_discovery_position, public.portal_discovery_answer,
  public.portal_discovery_step, public.portal_discovery_file_start, public.portal_discovery_file_resume, public.portal_discovery_file_confirm,
  public.portal_discovery_file_abort, public.portal_discovery_file_remove, public.portal_discovery_file_grant,
  public.portal_discovery_target_fill, public.portal_discovery_target_validate, public.portal_discovery_target_comment, public.portal_discovery_send
  to anon;
grant execute on function public.discovery_storage_can_upload to anon, authenticated;
