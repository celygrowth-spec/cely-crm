-- Projets et portail client — ajustements : dossiers partagés ou internes, dépôt client par dossier,
-- déplacements contrôlés, et « Mes prochains points » sur plusieurs projets. Migration additive.
--
-- Règle de visibilité d'un document de projet pour le client :
--   * à la racine du projet : visible (comportement existant inchangé) ;
--   * dans un dossier : visible seulement si ce dossier ET son parent éventuel sont partagés.
-- Un document ne devient JAMAIS visible par effet de bord : un déplacement, une suppression de dossier ou
-- le partage d'un dossier qui exposerait un document jusqu'ici interne exige une confirmation explicite,
-- vérifiée en base (déclencheurs), pas seulement dans l'interface.

-- Les dossiers existants restent partagés et ouverts au dépôt (comportement actuel) ;
-- les nouveaux dossiers sont internes et fermés au dépôt tant que rien n'est choisi.
alter table public.project_folders
  add column visible_to_client boolean not null default true,
  add column client_can_upload boolean not null default true;
alter table public.project_folders
  alter column visible_to_client set default false,
  alter column client_can_upload set default false;

-- Dossier visible du client (null = racine du projet)
create or replace function portal_private.folder_visible(p_folder uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_folder is null or exists (
    select 1 from public.project_folders f left join public.project_folders pa on pa.id = f.parent_id
     where f.id = p_folder and f.visible_to_client and (f.parent_id is null or pa.visible_to_client));
$$;

-- Dépôt client autorisé dans ce dossier (racine : oui, comme aujourd'hui)
create or replace function portal_private.folder_uploadable(p_folder uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_folder is null or (portal_private.folder_visible(p_folder)
    and exists (select 1 from public.project_folders where id = p_folder and client_can_upload));
$$;

-- Confirmation explicite, valable pour la transaction en cours seulement
create or replace function portal_private.exposure_confirmed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('cely.confirm_expose', true), '') = 'on';
$$;

-- Garde-fou 1 : déplacer un document interne vers un emplacement visible exige une confirmation
create or replace function portal_private.tg_project_file_move()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.folder_id is distinct from old.folder_id
     and not portal_private.folder_visible(old.folder_id) and portal_private.folder_visible(new.folder_id)
     and not portal_private.exposure_confirmed() then
    raise exception 'Ce déplacement rendrait un document interne visible du client : confirmation requise' using errcode = '42501';
  end if;
  return new;
end; $$;
create trigger project_files_exposure before update of folder_id on public.project_files
  for each row execute function portal_private.tg_project_file_move();

-- Garde-fou 2 : partager un dossier (ou le rattacher à un dossier partagé) qui contient des documents
-- jusqu'ici internes exige une confirmation
create or replace function portal_private.tg_folder_exposure()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_before boolean; v_after boolean;
begin
  v_before := old.visible_to_client and (old.parent_id is null or exists (select 1 from public.project_folders where id = old.parent_id and visible_to_client));
  v_after := new.visible_to_client and (new.parent_id is null or exists (select 1 from public.project_folders where id = new.parent_id and visible_to_client));
  if not v_before and v_after and not portal_private.exposure_confirmed() and exists (
       select 1 from public.project_files pf left join public.project_folders s on s.id = pf.folder_id
        where pf.folder_id = new.id
           or (s.parent_id = new.id and s.visible_to_client)) then
    raise exception 'Partager ce dossier rendrait des documents internes visibles du client : confirmation requise' using errcode = '42501';
  end if;
  return new;
end; $$;
create trigger project_folders_exposure before update of visible_to_client, parent_id on public.project_folders
  for each row execute function portal_private.tg_folder_exposure();

-- Garde-fou 3 : un dossier non vide ne se supprime pas directement (ses documents remonteraient à la
-- racine, visible). La suppression d'un projet entier reste possible.
create or replace function portal_private.tg_folder_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.project_files where folder_id = old.id)
     and exists (select 1 from public.projects where id = old.project_id) then
    raise exception 'Dossier non vide : choisissez d''abord où déplacer ses fichiers' using errcode = '23503';
  end if;
  return old;
end; $$;
create trigger project_folders_no_orphans before delete on public.project_folders
  for each row execute function portal_private.tg_folder_delete();

-- ---------------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------------

-- Nombre de documents qu'un déplacement vers p_target rendrait visibles (jusqu'ici internes)
create or replace function portal_private.exposed_count(p_ids uuid[], p_target uuid)
returns int language sql stable set search_path = '' as $$
  select case when portal_private.folder_visible(p_target)
              then (select count(*)::int from public.project_files where id = any (p_ids) and not portal_private.folder_visible(folder_id))
              else 0 end;
$$;

-- Créer ou modifier un dossier. Renvoie {"id"} ou, si le partage exposerait des documents internes sans
-- confirmation, {"confirm": n} sans rien modifier.
create or replace function public.project_folder_save(
  p_project uuid, p_folder uuid, p_name text, p_parent uuid, p_visible boolean, p_upload boolean, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.project_folders;
  v_n int;
begin
  perform portal_private.assert_owner_user();
  if coalesce(btrim(p_name), '') = '' or char_length(btrim(p_name)) > 80 then raise exception 'Nom de dossier obligatoire (80 caractères maximum)' using errcode = '22023'; end if;
  if p_folder is null then
    if not exists (select 1 from public.projects where id = p_project) then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
    if exists (select 1 from public.project_folders where project_id = p_project and parent_id is not distinct from p_parent and lower(name) = lower(btrim(p_name))) then
      raise exception 'Un dossier porte déjà ce nom à cet endroit' using errcode = '22023';
    end if;
    insert into public.project_folders (project_id, parent_id, name, visible_to_client, client_can_upload)
    values (p_project, p_parent, btrim(p_name), coalesce(p_visible, false), coalesce(p_visible, false) and coalesce(p_upload, false))
    returning * into f;
    perform portal_private.log(p_project, 'owner', null, 'folder_created', jsonb_build_object('folder_id', f.id, 'name', f.name));
    return jsonb_build_object('id', f.id);
  end if;
  select * into f from public.project_folders where id = p_folder and project_id = p_project for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if exists (select 1 from public.project_folders where project_id = p_project and id <> f.id and parent_id is not distinct from f.parent_id and lower(name) = lower(btrim(p_name))) then
    raise exception 'Un dossier porte déjà ce nom à cet endroit' using errcode = '22023';
  end if;
  if coalesce(p_visible, f.visible_to_client) and not f.visible_to_client and not coalesce(p_confirm, false) then
    select count(*)::int into v_n from public.project_files pf left join public.project_folders s on s.id = pf.folder_id
     where pf.folder_id = f.id or (s.parent_id = f.id and s.visible_to_client);
    if v_n > 0 and (f.parent_id is null or portal_private.folder_visible(f.parent_id)) then
      return jsonb_build_object('confirm', v_n);
    end if;
  end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  update public.project_folders
     set name = btrim(p_name),
         visible_to_client = coalesce(p_visible, visible_to_client),
         client_can_upload = coalesce(p_visible, visible_to_client) and coalesce(p_upload, client_can_upload)
   where id = f.id returning * into f;
  perform set_config('cely.confirm_expose', '', true);
  return jsonb_build_object('id', f.id);
end; $$;

-- Déplacer des documents du projet. {"moved": n} ou {"confirm": n} (rien n'est déplacé).
create or replace function public.project_files_move(p_project uuid, p_ids uuid[], p_folder uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int; v_moved int;
begin
  perform portal_private.assert_owner_user();
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  v_n := portal_private.exposed_count(array(select id from public.project_files where id = any (p_ids) and project_id = p_project), p_folder);
  if v_n > 0 and not coalesce(p_confirm, false) then return jsonb_build_object('confirm', v_n); end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  update public.project_files set folder_id = p_folder where id = any (p_ids) and project_id = p_project and folder_id is distinct from p_folder;
  get diagnostics v_moved = row_count;
  perform set_config('cely.confirm_expose', '', true);
  if v_moved > 0 then
    perform portal_private.log(p_project, 'owner', null, 'files_moved', jsonb_build_object('count', v_moved, 'folder_id', p_folder));
  end if;
  return jsonb_build_object('moved', v_moved);
end; $$;

-- Supprimer un dossier (et son sous-dossier éventuel) après avoir déplacé ses documents vers p_target
-- (null = racine). {"deleted": true} ou {"confirm": n}.
create or replace function public.project_folder_delete(p_folder uuid, p_target uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.project_folders;
  v_ids uuid[];
  v_n int;
begin
  perform portal_private.assert_owner_user();
  select * into f from public.project_folders where id = p_folder for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if p_target is not null and not exists (
       select 1 from public.project_folders where id = p_target and project_id = f.project_id and id <> f.id and parent_id is distinct from f.id) then
    raise exception 'Destination invalide' using errcode = '22023';
  end if;
  v_ids := array(select pf.id from public.project_files pf join public.project_folders d on d.id = pf.folder_id
                  where d.id = f.id or d.parent_id = f.id);
  v_n := portal_private.exposed_count(v_ids, p_target);
  if v_n > 0 and not coalesce(p_confirm, false) then return jsonb_build_object('confirm', v_n); end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  update public.project_files set folder_id = p_target where id = any (v_ids);
  perform set_config('cely.confirm_expose', '', true);
  delete from public.project_folders where id = f.id;
  perform portal_private.log(f.project_id, 'owner', null, 'folder_deleted', jsonb_build_object('name', f.name, 'moved', coalesce(array_length(v_ids, 1), 0)));
  return jsonb_build_object('deleted', true, 'moved', coalesce(array_length(v_ids, 1), 0));
end; $$;

-- ---------------------------------------------------------------------------
-- Portail : seuls les dossiers partagés et leurs documents existent pour le client
-- ---------------------------------------------------------------------------

create or replace function public.portal_files(p_server_key text, p_session_hash text, p_project uuid, p_limit int default 200, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return jsonb_build_object(
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id,
                                                             'upload', portal_private.folder_uploadable(id)) order by name)
                           from public.project_folders where project_id = p_project and portal_private.folder_visible(id)), '[]'),
    'total', (select count(*) from public.project_files pf join public.company_files f on f.id = pf.file_id
               where pf.project_id = p_project and f.status = 'ready' and portal_private.folder_visible(pf.folder_id)),
    'files', coalesce((select jsonb_agg(portal_private.file_json(pf, f, v_person) order by pf.created_at desc)
                         from (select pf.id from public.project_files pf join public.company_files f on f.id = pf.file_id
                                where pf.project_id = p_project and f.status = 'ready' and portal_private.folder_visible(pf.folder_id)
                                order by pf.created_at desc limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)) x
                         join public.project_files pf on pf.id = x.id
                         join public.company_files f on f.id = pf.file_id), '[]'),
    'read_only', (select read_only from portal_private.visible_projects(v_person) where project_id = p_project));
end; $$;

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
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project and portal_private.folder_visible(id)) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  if not portal_private.folder_uploadable(p_folder) then
    raise exception 'Le dépôt n''est pas ouvert dans ce dossier' using errcode = '42501';
  end if;
  if p_task is not null and not exists (select 1 from public.project_tasks where id = p_task and project_id = p_project and visible_to_client) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  if (select count(*) from public.company_files where uploaded_by_person = v_person and created_at > now() - interval '1 hour') >= 50 then
    raise exception 'Trop de dépôts en peu de temps : réessayez dans une heure' using errcode = '22023';
  end if;
  select company_id into v_company from public.projects where id = p_project;
  v_path := v_company::text || '/' || v_id::text || '.' || coalesce(nullif(lower(regexp_replace(coalesce(p_ext, ''), '[^a-zA-Z0-9]', '', 'g')), ''), 'bin');
  insert into public.company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status, uploaded_by_kind, uploaded_by_person)
  values (v_id, v_company, v_path, left(btrim(p_name), 200), p_type, p_size, 'pending', 'client', v_person);
  insert into public.project_files (project_id, file_id, folder_id, task_id, shared_by_kind, shared_by_person)
  values (p_project, v_id, p_folder, p_task, 'client', v_person);
  return jsonb_build_object('file_id', v_id, 'path', v_path);
end; $$;

create or replace function public.portal_file_grant(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  r record;
begin
  select pf.project_id, pf.folder_id, f.storage_path, f.display_name, f.mime_type into r
    from public.project_files pf join public.company_files f on f.id = pf.file_id
   where pf.id = p_project_file and f.status = 'ready';
  if not found or not portal_private.folder_visible(r.folder_id) then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, r.project_id);
  delete from public.portal_storage_grants where expires_at < now() - interval '1 hour';
  insert into public.portal_storage_grants (object_name, action, expires_at) values (r.storage_path, 'read', now() + interval '60 seconds');
  return jsonb_build_object('path', r.storage_path, 'name', r.display_name, 'mime_type', r.mime_type);
end; $$;

create or replace function public.portal_file_update(p_server_key text, p_session_hash text, p_project_file uuid, p_name text, p_folder uuid, p_move boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found or not portal_private.folder_visible(pf.folder_id) then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
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
    if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = pf.project_id and portal_private.folder_visible(id)) then
      raise exception 'Dossier introuvable' using errcode = 'P0002';
    end if;
    if not portal_private.folder_uploadable(p_folder) then raise exception 'Le dépôt n''est pas ouvert dans ce dossier' using errcode = '42501'; end if;
    update public.project_files set folder_id = p_folder where id = pf.id returning * into pf;
  end if;
  return portal_private.file_json(pf, f, v_person);
end; $$;

create or replace function public.portal_file_delete(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found or not portal_private.folder_visible(pf.folder_id) then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id for update;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez supprimer que vos propres dépôts' using errcode = '42501';
  end if;
  update public.company_files set status = 'deleting' where id = f.id;
  insert into public.portal_storage_grants (object_name, action, expires_at)
  values (f.storage_path, 'delete', now() + interval '60 seconds'), (f.storage_path, 'read', now() + interval '60 seconds');
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_deleted', jsonb_build_object('name', f.display_name));
  return jsonb_build_object('path', f.storage_path, 'file_id', f.id);
end; $$;

-- Vue d'administration : emplacement visible ou non du client
create or replace view public.project_file_overview with (security_invoker = true) as
  select pf.id, pf.project_id, pf.file_id, pf.folder_id, pf.task_id, pf.shared_by_kind, pf.created_at as shared_at,
         f.display_name, f.mime_type, f.size_bytes, f.status, f.uploaded_by_kind, f.created_at,
         case when f.uploaded_by_kind = 'client' then btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) else 'Vous' end as author,
         (pf.folder_id is null or (d.visible_to_client and (d.parent_id is null or dp.visible_to_client))) as visible_to_client
    from public.project_files pf
    join public.company_files f on f.id = pf.file_id
    left join public.people pe on pe.id = f.uploaded_by_person
    left join public.project_folders d on d.id = pf.folder_id
    left join public.project_folders dp on dp.id = d.parent_id
   where f.status = 'ready';
revoke all on public.project_file_overview from anon;
grant select on public.project_file_overview to authenticated;

-- ---------------------------------------------------------------------------
-- « Mes prochains points » : points à venir, partagés, de tous les projets visibles (sans doublon :
-- un rendez-vous n'est rattaché qu'à un seul projet). Annulés exclus ; reportés lus en direct.
-- ---------------------------------------------------------------------------
create or replace function public.portal_upcoming_meetings(p_server_key text, p_session_hash text, p_limit int default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  return coalesce((
    select jsonb_agg(x.j order by x.starts_at)
      from (select portal_private.meeting_json(m, b, false) || jsonb_build_object('project_id', p.id, 'project_name', p.name) as j, b.starts_at
              from portal_private.visible_projects(v_person) v
              join public.projects p on p.id = v.project_id
              join public.project_meetings m on m.project_id = p.id and m.visible_to_client
              join public.appt_bookings b on b.id = m.booking_id
             where b.status = 'confirmed' and b.ends_at > now() and b.outcome is distinct from 'done'
             order by b.starts_at
             limit greatest(1, least(coalesce(p_limit, 3), 10))) x), '[]');
end; $$;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'portal_files(text, text, uuid, int, int)', 'portal_file_start(text, text, uuid, uuid, uuid, text, text, bigint, text)',
    'portal_file_grant(text, text, uuid)', 'portal_file_update(text, text, uuid, text, uuid, boolean)',
    'portal_file_delete(text, text, uuid)', 'portal_upcoming_meetings(text, text, int)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['project_folder_save(uuid, uuid, text, uuid, boolean, boolean, boolean)',
                           'project_files_move(uuid, uuid[], uuid, boolean)', 'project_folder_delete(uuid, uuid, boolean)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
