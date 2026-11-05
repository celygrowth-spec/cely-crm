-- Projets et portail client — phase 4 : fichiers partagés. Migration additive.
-- Réutilise le module Fichiers existant (table company_files, bucket privé company-files) :
-- * un document du projet est un document de la fiche CRM ; « partager avec le projet » crée une RÉFÉRENCE
--   (project_files), jamais une copie ; retirer du projet ≠ supprimer le fichier ;
-- * un dépôt client crée un document de la fiche, marqué comme déposé par ce contact, puis sa référence ;
-- * le client n'a pas de compte : le serveur agit avec le rôle anon, et les politiques Storage ne
--   l'autorisent que sur des objets précis, pour une durée courte, après contrôle de la session en base.

alter table public.company_files
  add column uploaded_by_kind text not null default 'owner' check (uploaded_by_kind in ('owner','client')),
  add column uploaded_by_person uuid references public.people (id) on delete set null;

create table public.project_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  parent_id uuid references public.project_folders (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create index project_folders_idx on public.project_folders (project_id, parent_id);

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  file_id uuid not null references public.company_files (id) on delete cascade,
  folder_id uuid references public.project_folders (id) on delete set null,
  task_id uuid references public.project_tasks (id) on delete set null,
  shared_by_kind text not null default 'owner' check (shared_by_kind in ('owner','client')),
  shared_by_person uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, file_id)
);
create index project_files_project_idx on public.project_files (project_id, folder_id);

-- Autorisations Storage temporaires (téléchargement / prévisualisation) : 60 secondes
create table public.portal_storage_grants (
  id bigint generated always as identity primary key,
  object_name text not null,
  action text not null check (action in ('read','delete')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index portal_storage_grants_idx on public.portal_storage_grants (object_name, action, expires_at);

-- Cohérence : dossier et fichier du même projet ; deux niveaux de dossiers au plus ; fichier de la fiche du projet
create or replace function portal_private.tg_folder()
returns trigger language plpgsql set search_path = '' as $$
declare v_parent public.project_folders;
begin
  if new.parent_id is not null then
    select * into v_parent from public.project_folders where id = new.parent_id;
    if v_parent.project_id <> new.project_id then raise exception 'Dossier parent d''un autre projet' using errcode = '22023'; end if;
    if v_parent.parent_id is not null then raise exception 'Deux niveaux de dossiers au maximum' using errcode = '22023'; end if;
    if new.id = new.parent_id then raise exception 'Dossier invalide' using errcode = '22023'; end if;
  end if;
  return new;
end; $$;
create trigger project_folders_rules before insert or update on public.project_folders for each row execute function portal_private.tg_folder();

create or replace function portal_private.tg_project_file()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.company_files f join public.projects p on p.company_id = f.company_id where f.id = new.file_id and p.id = new.project_id) then
    raise exception 'Ce document n''appartient pas à la fiche CRM du projet' using errcode = '22023';
  end if;
  if new.folder_id is not null and not exists (select 1 from public.project_folders where id = new.folder_id and project_id = new.project_id) then
    raise exception 'Dossier d''un autre projet' using errcode = '22023';
  end if;
  if new.task_id is not null and not exists (select 1 from public.project_tasks where id = new.task_id and project_id = new.project_id) then
    raise exception 'Tâche d''un autre projet' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger project_files_rules before insert or update on public.project_files for each row execute function portal_private.tg_project_file();

do $$
declare t text;
begin
  foreach t in array array['project_folders','project_files','portal_storage_grants']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['project_folders','project_files']
  loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Politiques Storage pour le rôle anon (serveur agissant pour un client authentifié par session)
-- Les fonctions sont « security definer » et ne répondent que pour un objet précis.
-- ---------------------------------------------------------------------------

-- Envoi : objet d'un dépôt client en attente, créé il y a moins de 15 minutes
create or replace function public.portal_storage_can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_files f
                  where f.storage_path = p_name and f.status = 'pending' and f.uploaded_by_kind = 'client'
                    and f.created_at > now() - interval '15 minutes');
$$;

create or replace function public.portal_storage_can(p_name text, p_action text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.portal_storage_grants g where g.object_name = p_name and g.action = p_action and g.expires_at > now());
$$;

create policy portal_files_insert on storage.objects for insert to anon
  with check (bucket_id = 'company-files' and public.portal_storage_can_upload(name));
create policy portal_files_select on storage.objects for select to anon
  using (bucket_id = 'company-files' and public.portal_storage_can(name, 'read'));
create policy portal_files_delete on storage.objects for delete to anon
  using (bucket_id = 'company-files' and public.portal_storage_can(name, 'delete'));

-- ---------------------------------------------------------------------------
-- Portail
-- ---------------------------------------------------------------------------

create or replace function portal_private.file_json(pf public.project_files, f public.company_files, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', pf.id, 'name', f.display_name, 'mime_type', f.mime_type, 'size', f.size_bytes, 'folder_id', pf.folder_id, 'task_id', pf.task_id,
    'created_at', pf.created_at,
    'author', case when f.uploaded_by_kind = 'client' and f.uploaded_by_person is not null
                   then (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = f.uploaded_by_person)
                   else 'Cely Growth' end,
    'mine', f.uploaded_by_kind = 'client' and f.uploaded_by_person = p_person);
$$;

-- Liste d'un projet (paginée). Seuls les documents partagés avec le projet et prêts.
create or replace function public.portal_files(p_server_key text, p_session_hash text, p_project uuid, p_limit int default 200, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return jsonb_build_object(
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id) order by name)
                           from public.project_folders where project_id = p_project), '[]'),
    'total', (select count(*) from public.project_files pf join public.company_files f on f.id = pf.file_id where pf.project_id = p_project and f.status = 'ready'),
    'files', coalesce((select jsonb_agg(portal_private.file_json(pf, f, v_person) order by pf.created_at desc)
                         from (select pf.id from public.project_files pf join public.company_files f on f.id = pf.file_id
                                where pf.project_id = p_project and f.status = 'ready'
                                order by pf.created_at desc limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)) x
                         join public.project_files pf on pf.id = x.id
                         join public.company_files f on f.id = pf.file_id), '[]'),
    'read_only', (select read_only from portal_private.visible_projects(v_person) where project_id = p_project));
end; $$;

-- Dépôt client, étape 1 : document « en attente » dans la fiche du projet, chemin de stockage aléatoire.
create or replace function public.portal_file_start(
  p_server_key text, p_session_hash text, p_project uuid, p_folder uuid, p_task uuid, p_name text, p_type text, p_size bigint, p_ext text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  v_company uuid;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  if p_size is null or p_size <= 0 or p_size > 26214400 then raise exception 'Fichier vide ou trop volumineux (25 Mo maximum)' using errcode = '22023'; end if;
  if p_type is null or p_type not in (
       'application/pdf','image/png','image/jpeg','image/webp','image/gif','application/msword',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint',
       'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','text/csv','application/zip') then
    raise exception 'Format non autorisé' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Nom de fichier manquant' using errcode = '22023'; end if;
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  if p_task is not null and not exists (select 1 from public.project_tasks where id = p_task and project_id = p_project and visible_to_client) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  -- limite de débit : 50 dépôts par heure et par personne
  if (select count(*) from public.company_files where uploaded_by_person = v_person and created_at > now() - interval '1 hour') >= 50 then
    raise exception 'Trop de dépôts en peu de temps : réessayez dans une heure' using errcode = '22023';
  end if;
  select company_id into v_company from public.projects where id = p_project;
  v_path := v_company::text || '/' || v_id::text || '.' || coalesce(nullif(lower(regexp_replace(coalesce(p_ext, ''), '[^a-zA-Z0-9]', '', 'g')), ''), 'bin');
  insert into public.company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status, uploaded_by_kind, uploaded_by_person)
  values (v_id, v_company, v_path, left(btrim(p_name), 200), p_type, p_size, 'pending', 'client', v_person);
  -- la référence projet est préparée maintenant (dossier, tâche) mais le fichier n'apparaît qu'une fois « prêt »
  insert into public.project_files (project_id, file_id, folder_id, task_id, shared_by_kind, shared_by_person)
  values (p_project, v_id, p_folder, p_task, 'client', v_person);
  return jsonb_build_object('file_id', v_id, 'path', v_path);
end; $$;

-- Dépôt client, étape 2 : l'objet doit réellement exister dans Storage
create or replace function public.portal_file_confirm(p_server_key text, p_session_hash text, p_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  f public.company_files;
  pf public.project_files;
begin
  select * into f from public.company_files where id = p_file and uploaded_by_person = v_person and status = 'pending' for update;
  if not found then raise exception 'Dépôt introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'company-files' and o.name = f.storage_path) then
    raise exception 'Le fichier n''a pas été reçu par le stockage' using errcode = '22023';
  end if;
  update public.company_files set status = 'ready' where id = p_file returning * into f;
  select * into pf from public.project_files where file_id = p_file;
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_uploaded', jsonb_build_object('file_id', p_file, 'name', f.display_name));
  return portal_private.file_json(pf, f, v_person);
end; $$;

-- Transfert échoué : aucune pièce fantôme (l'objet éventuel est retiré par le nettoyage habituel)
create or replace function public.portal_file_abort(p_server_key text, p_session_hash text, p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  delete from public.company_files where id = p_file and uploaded_by_person = v_person and status = 'pending';
end; $$;

-- Lien temporaire : vérifie le partage, puis autorise la lecture de CET objet pendant 60 secondes
create or replace function public.portal_file_grant(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  r record;
begin
  select pf.project_id, f.storage_path, f.display_name, f.mime_type into r
    from public.project_files pf join public.company_files f on f.id = pf.file_id
   where pf.id = p_project_file and f.status = 'ready';
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, r.project_id);
  delete from public.portal_storage_grants where expires_at < now() - interval '1 hour';
  insert into public.portal_storage_grants (object_name, action, expires_at) values (r.storage_path, 'read', now() + interval '60 seconds');
  return jsonb_build_object('path', r.storage_path, 'name', r.display_name, 'mime_type', r.mime_type);
end; $$;

-- Dépôts du client : renommer, déplacer, supprimer les siens uniquement
create or replace function public.portal_file_update(p_server_key text, p_session_hash text, p_project_file uuid, p_name text, p_folder uuid, p_move boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez modifier que vos propres dépôts' using errcode = '42501';
  end if;
  if p_name is not null then
    if coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 then raise exception 'Nom invalide' using errcode = '22023'; end if;
    update public.company_files set display_name = btrim(p_name) where id = f.id returning * into f;
  end if;
  if p_move then
    update public.project_files set folder_id = p_folder where id = pf.id returning * into pf;
  end if;
  return portal_private.file_json(pf, f, v_person);
end; $$;

-- Suppression d'un dépôt par son auteur : invisible aussitôt, objet retiré par le serveur (autorisation de 60 s)
create or replace function public.portal_file_delete(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id for update;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez supprimer que vos propres dépôts' using errcode = '42501';
  end if;
  update public.company_files set status = 'deleting' where id = f.id;
  -- une suppression filtrée exige aussi la visibilité de la ligne (lecture), pour ce seul objet
  insert into public.portal_storage_grants (object_name, action, expires_at)
  values (f.storage_path, 'delete', now() + interval '60 seconds'), (f.storage_path, 'read', now() + interval '60 seconds');
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_deleted', jsonb_build_object('name', f.display_name));
  return jsonb_build_object('path', f.storage_path, 'file_id', f.id);
end; $$;

-- Après retrait de l'objet : la ligne disparaît (sinon le nettoyage administrateur la reprendra)
create or replace function public.portal_file_purge(p_server_key text, p_session_hash text, p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  delete from public.company_files f where f.id = p_file and f.status = 'deleting' and f.uploaded_by_person = v_person
     and not exists (select 1 from storage.objects o where o.bucket_id = 'company-files' and o.name = f.storage_path);
end; $$;

-- Vue d'administration des fichiers d'un projet
create or replace view public.project_file_overview with (security_invoker = true) as
  select pf.id, pf.project_id, pf.file_id, pf.folder_id, pf.task_id, pf.shared_by_kind, pf.created_at as shared_at,
         f.display_name, f.mime_type, f.size_bytes, f.status, f.uploaded_by_kind, f.created_at,
         case when f.uploaded_by_kind = 'client' then btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) else 'Vous' end as author
    from public.project_files pf
    join public.company_files f on f.id = pf.file_id
    left join public.people pe on pe.id = f.uploaded_by_person
   where f.status = 'ready';
revoke all on public.project_file_overview from anon;
grant select on public.project_file_overview to authenticated;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'portal_files(text, text, uuid, int, int)', 'portal_file_start(text, text, uuid, uuid, uuid, text, text, bigint, text)',
    'portal_file_confirm(text, text, uuid)', 'portal_file_abort(text, text, uuid)', 'portal_file_grant(text, text, uuid)',
    'portal_file_update(text, text, uuid, text, uuid, boolean)', 'portal_file_delete(text, text, uuid)', 'portal_file_purge(text, text, uuid)',
    'portal_storage_can_upload(text)', 'portal_storage_can(text, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
