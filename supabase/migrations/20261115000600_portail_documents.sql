-- Audit, lot 6 — Portail et documents (C06, Q08, K11). Migration additive.

-- ===========================================================================
-- C06 — partage d'un document de la fiche avec le projet : jamais visible du client sans confirmation explicite
-- (dossier choisi, nombre de documents exposés) ; {"confirm": n} sans rien modifier tant que ce n'est pas confirmé.
-- ===========================================================================
create or replace function public.project_files_share(p_project uuid, p_files uuid[], p_folder uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare p public.projects; v_n int; v_added int;
begin
  perform portal_private.assert_owner_user();
  select * into p from public.projects where id = p_project;
  if not found then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(p_files) f(id) where not exists (
       select 1 from public.company_files cf where cf.id = f.id and cf.company_id = p.company_id and cf.status = 'ready')) then
    raise exception 'Un document n''appartient pas à la fiche de ce projet' using errcode = '22023';
  end if;
  v_n := case when portal_private.folder_visible(p_folder) and p.portal_published
              then (select count(*)::int from unnest(p_files) f(id) where not exists (select 1 from public.project_files x where x.project_id = p_project and x.file_id = f.id))
              else 0 end;
  if v_n > 0 and not coalesce(p_confirm, false) then return jsonb_build_object('confirm', v_n); end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  insert into public.project_files (project_id, file_id, folder_id)
  select p_project, f.id, p_folder from unnest(p_files) f(id)
  on conflict (project_id, file_id) do nothing;
  get diagnostics v_added = row_count;
  perform set_config('cely.confirm_expose', '', true);
  if v_added > 0 then
    perform portal_private.log(p_project, 'owner', null, 'files_shared', jsonb_build_object('count', v_added, 'folder_id', p_folder, 'visible', portal_private.folder_visible(p_folder)));
  end if;
  return jsonb_build_object('shared', v_added, 'visible', portal_private.folder_visible(p_folder) and p.portal_published);
end; $$;

-- Commentaires écrits sur une tâche interne : ils restent privés, même si la tâche devient visible ensuite.
alter table public.project_task_comments add column if not exists internal boolean not null default false;
create or replace function public.tg_task_comment_internal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.author_kind = 'owner' and not exists (select 1 from public.project_tasks where id = new.task_id and visible_to_client) then
    new.internal := true;
  end if;
  return new;
end; $$;
drop trigger if exists task_comment_internal on public.project_task_comments;
create trigger task_comment_internal before insert on public.project_task_comments
  for each row execute function public.tg_task_comment_internal();

create or replace function portal_private.task_json(t public.project_tasks, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'project_id', t.project_id, 'project_name', (select name from public.projects where id = t.project_id),
    'title', t.title, 'status', t.status, 'due_date', t.due_date, 'blocked_reason', t.blocked_reason,
    'assignee', case when t.assignee_kind = 'owner' then jsonb_build_object('kind', 'owner', 'name', 'Cely Growth')
                     when t.assignee_person_id is null then jsonb_build_object('kind', 'team', 'name', 'Équipe client')
                     else jsonb_build_object('kind', case when t.assignee_person_id = p_person then 'me' else 'person' end,
                                             'name', (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = t.assignee_person_id)) end,
    'meeting', (select jsonb_build_object('id', pm.id, 'title', coalesce(pm.title, b.event_snapshot ->> 'name'), 'starts_at', b.starts_at)
                  from public.project_meetings pm join public.appt_bookings b on b.id = pm.booking_id
                 where pm.id = t.meeting_id and pm.visible_to_client and b.status in ('confirmed','cancelled')),
    'updated_at', t.updated_at, 'can_edit', portal_private.task_editable(t, p_person),
    'comment_count', (select count(*) from public.project_task_comments c where c.task_id = t.id and not c.internal));
$$;


create or replace function public.portal_task(p_server_key text, p_session_hash text, p_task uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client;
  if not found or not exists (select 1 from portal_private.visible_projects(v_person) where project_id = t.project_id) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  return portal_private.task_json(t, v_person) || jsonb_build_object(
    'description', t.description, 'links', t.links,
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'created_at', c.created_at, 'mine', c.person_id = v_person,
        'author', case when c.author_kind = 'owner' then 'Cely Growth'
                       else (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = c.person_id) end) order by c.created_at)
      from public.project_task_comments c where c.task_id = t.id and not c.internal), '[]'));
end; $$;


-- Demande d'onboarding : titre visible du client choisi au partage (le libellé interne ne sort pas).
drop function if exists public.onboarding_share_request(uuid, text, uuid);
create or replace function public.onboarding_share_request(p_item uuid, p_text text, p_person uuid default null, p_title text default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  i public.project_onboarding_items;
  p public.projects;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_task uuid;
  -- C06 : titre montré au client, distinct du libellé interne (par défaut le libellé, modifiable avant partage)
  v_title text;
begin
  perform public.assert_owner();
  select * into i from public.project_onboarding_items where id = p_item for update;
  if not found then raise exception 'Point introuvable' using errcode = 'P0002'; end if;
  select * into p from public.projects where id = i.project_id;
  v_title := left(coalesce(nullif(btrim(coalesce(p_title, '')), ''), i.label), 300);
  if v_text is null then raise exception 'Rédigez la demande avant de la partager' using errcode = '22023'; end if;
  if char_length(v_text) > 5000 then raise exception '5 000 caractères maximum' using errcode = '22023'; end if;
  if not p.portal_published then
    raise exception 'Le projet n''est pas publié sur le portail : publiez-le (onglet Général) avant de partager une demande. Rien n''a été partagé.' using errcode = '22023';
  end if;
  if p_person is not null and not exists (select 1 from public.project_members where project_id = p.id and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  if i.client_task_id is not null and exists (select 1 from public.project_tasks where id = i.client_task_id) then
    update public.project_tasks set title = v_title, description = v_text, assignee_person_id = p_person, status = case when status = 'termine' then 'a_faire' else status end,
           updated_by_kind = 'owner', updated_by_person = null
     where id = i.client_task_id;
    v_task := i.client_task_id;
  else
    insert into public.project_tasks (project_id, title, description, assignee_kind, assignee_person_id, visible_to_client)
    values (p.id, v_title, v_text, 'client', p_person, true) returning id into v_task;
  end if;
  update public.project_onboarding_items set client_task_id = v_task, request_text = v_text, request_shared_at = now() where id = i.id;
  return jsonb_build_object('task_id', v_task);
end; $$;


-- Slides d'onboarding : partage atomique (une seule version visible, les autres au dossier interne), une transaction.
create or replace function public.onboarding_share_deck(p_project uuid, p_deck uuid, p_share boolean, p_internal_folder uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.project_onboarding_decks; v_pf uuid;
begin
  perform portal_private.assert_owner_user();
  select * into d from public.project_onboarding_decks where id = p_deck and project_id = p_project for update;
  if d.id is null or d.file_id is null or d.status <> 'ready' then raise exception 'Cette version n''est pas prête.' using errcode = '22023'; end if;
  if not exists (select 1 from public.project_folders where id = p_internal_folder and project_id = p_project and not visible_to_client) then
    raise exception 'Dossier interne introuvable' using errcode = '22023';
  end if;
  select id into v_pf from public.project_files where project_id = p_project and file_id = d.file_id;
  if v_pf is null then raise exception 'Le fichier de cette version n''est plus dans le projet.' using errcode = 'P0002'; end if;
  update public.project_files set folder_id = p_internal_folder
   where project_id = p_project and id <> v_pf and file_id in (select file_id from public.project_onboarding_decks where project_id = p_project and file_id is not null);
  perform set_config('cely.confirm_expose', 'on', true);
  update public.project_files set folder_id = case when p_share then null else p_internal_folder end where id = v_pf;
  perform set_config('cely.confirm_expose', '', true);
  update public.project_onboarding_decks set shared_at = case when id = d.id and p_share then now() end where project_id = p_project;
  perform portal_private.log(p_project, 'owner', null, case when p_share then 'deck_shared' else 'deck_unshared' end, jsonb_build_object('deck_id', d.id));
  return jsonb_build_object('shared', p_share);
end; $$;

-- ===========================================================================
-- K11 — un dépôt supprimé par le client disparaît du projet, pas de la fiche CRM (la pièce reste au propriétaire)
-- ===========================================================================
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
  select * into f from public.company_files where id = pf.file_id;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez supprimer que vos propres dépôts' using errcode = '42501';
  end if;
  delete from public.project_files where id = pf.id;
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_removed', jsonb_build_object('name', f.display_name));
  return jsonb_build_object('path', null, 'file_id', f.id, 'removed_from_project', true);
end; $$;

-- K11 — limite de connexion au portail : par connexion (empreinte IP) et par code, plus de plafond global qui
-- permettrait à une personne de bloquer tous les clients.
alter table public.portal_login_attempts add column if not exists code_hash text;
create index if not exists portal_login_attempts_code on public.portal_login_attempts (code_hash, created_at desc);
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
     or (select count(*) from public.portal_login_attempts where code_hash = p_code_hash and not success and created_at > now() - interval '15 minutes') >= 8 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  select * into a from public.portal_accesses where code_hash = p_code_hash;
  if not found or a.revoked_at is not null or (a.expires_at is not null and a.expires_at <= now())
     or not exists (select 1 from portal_private.visible_projects(a.person_id)) then
    insert into public.portal_login_attempts (ip_hash, success, code_hash) values (p_ip_hash, false, p_code_hash);
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.portal_login_attempts (ip_hash, success, code_hash) values (p_ip_hash, true, p_code_hash);
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

do $$
declare f text;
begin
  foreach f in array array['public.project_files_share(uuid, uuid[], uuid, boolean)', 'public.onboarding_share_deck(uuid, uuid, boolean, uuid)',
                           'public.onboarding_share_request(uuid, text, uuid, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function public.tg_task_comment_internal() from public, anon;

-- Une tâche créée depuis un récapitulatif encore en brouillon reste privée ; elle devient visible du client (et lui
-- est attribuée) seulement à la publication du récapitulatif.
create or replace function public.tg_recap_publish_tasks()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and old.status is distinct from 'published' then
    update public.project_tasks t set assignee_kind = 'client', visible_to_client = true, updated_by_kind = 'owner'
     where t.meeting_id = new.meeting_id and not t.visible_to_client
       and t.id in (select (a ->> 'task_id')::uuid from jsonb_array_elements(coalesce(new.actions, '[]')) a where a ->> 'task_id' is not null);
  end if;
  return null;
end; $$;
drop trigger if exists recap_publish_tasks on public.meeting_recaps;
create trigger recap_publish_tasks after update of status on public.meeting_recaps
  for each row execute function public.tg_recap_publish_tasks();
revoke execute on function public.tg_recap_publish_tasks() from public, anon;
