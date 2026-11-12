-- Corbeille, lot 3 : Projets (projet client, tâches, idées, phases du planning, points de suivi).
--  * Un projet part avec tout son contenu : tâches et commentaires, idées, planning (phases, jalons), points de
--    suivi et récapitulatifs, dossiers, liens vers les documents, historique, onboarding.
--  * Les documents restent sur la fiche (ce sont des fichiers de la fiche) et dans les autres projets qui les
--    partagent : seul le lien avec ce projet part.
--  * Un projet à la corbeille ferme l'accès de ses contacts à ce projet au portail ; la restauration le rouvre
--    (les accès eux-mêmes ne sont pas modifiés). Le rendez-vous d'un point de suivi reste dans l'agenda.
-- Additif : politiques restrictives ajoutées ; fonctions du portail redéfinies entièrement (définitions en vigueur,
-- seul ajout : l'élément à la corbeille est ignoré).

-- ---------------------------------------------------------------------------
-- Invisibilité imposée par la base (application, Claude)
-- ---------------------------------------------------------------------------
select trash_private.hide('projects', array['id:projects', 'company_id:companies']);
select trash_private.hide('project_members', array['project_id:projects', 'person_id:people']);
select trash_private.hide('project_tasks', array['id:project_tasks', 'project_id:projects']);
select trash_private.hide('project_task_comments', array['id:project_task_comments', 'task_id:project_tasks']);
select trash_private.hide('project_ideas', array['id:project_ideas', 'project_id:projects']);
select trash_private.hide('project_idea_comments', array['id:project_idea_comments', 'idea_id:project_ideas']);
select trash_private.hide('project_phases', array['id:project_phases', 'project_id:projects']);
select trash_private.hide('project_milestones', array['id:project_milestones', 'project_id:projects', 'phase_id:project_phases']);
select trash_private.hide('project_meetings', array['id:project_meetings', 'project_id:projects']);
select trash_private.hide('meeting_recaps', array['meeting_id:project_meetings']);
select trash_private.hide('project_folders', array['id:project_folders', 'project_id:projects']);
select trash_private.hide('project_files', array['id:project_files', 'project_id:projects']);
select trash_private.hide('project_activity', array['project_id:projects']);  -- identifiant numérique : suit son projet
select trash_private.hide('project_onboarding', array['project_id:projects']);
select trash_private.hide('project_onboarding_items', array['id:project_onboarding_items', 'project_id:projects']);
select trash_private.hide('project_onboarding_decks', array['id:project_onboarding_decks', 'project_id:projects']);

-- ---------------------------------------------------------------------------
-- Projet
-- ---------------------------------------------------------------------------
create or replace function trash_private.describe_project(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', p.name,
    'context', c.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'companies', 'id', p.company_id)),
    'warnings', to_jsonb(array_remove(array[
      (select case when count(*) > 0 then
         count(*) || ' contact' || case when count(*) > 1 then 's' else '' end || ' du portail ne verr'
         || case when count(*) > 1 then 'ont' else 'a' end || ' plus ce projet ; l''accès est rouvert si vous le restaurez.' end
         from public.project_members m where m.project_id = p.id and p.portal_published),
      case when exists (select 1 from public.project_files f where f.project_id = p.id)
           then 'Les documents restent sur la fiche ' || c.name || ' et dans les autres projets qui les partagent.' end,
      case when exists (select 1 from public.project_meetings m where m.project_id = p.id)
           then 'Les rendez-vous des points de suivi restent dans l''agenda.' end,
      case when exists (select 1 from public.sales s where s.project_id = p.id)
           then 'La vente liée reste, sans ce projet.' end
    ], null)))
    from public.projects p join public.companies c on c.id = p.company_id
   where p.id = p_id;
$$;

create or replace function trash_private.collect_project(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'projects', id from public.projects where id = p_id
  union all select 'project_tasks', id from public.project_tasks where project_id = p_id
  union all select 'project_task_comments', c.id from public.project_task_comments c join public.project_tasks t on t.id = c.task_id where t.project_id = p_id
  union all select 'project_ideas', id from public.project_ideas where project_id = p_id
  union all select 'project_idea_comments', c.id from public.project_idea_comments c join public.project_ideas i on i.id = c.idea_id where i.project_id = p_id
  union all select 'project_phases', id from public.project_phases where project_id = p_id
  union all select 'project_milestones', id from public.project_milestones where project_id = p_id
  union all select 'project_meetings', id from public.project_meetings where project_id = p_id
  union all select 'project_folders', id from public.project_folders where project_id = p_id
  union all select 'project_files', id from public.project_files where project_id = p_id
  union all select 'project_onboarding_items', id from public.project_onboarding_items where project_id = p_id
  union all select 'project_onboarding_decks', id from public.project_onboarding_decks where project_id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- Tâche, idée, phase, point de suivi
-- ---------------------------------------------------------------------------
create or replace function trash_private.describe_project_task(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', t.title, 'context', 'Projet ' || p.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'projects', 'id', t.project_id)),
    'warnings', case when t.visible_to_client and p.portal_published
                     then jsonb_build_array('Visible au portail : elle en disparaît aussi.') else '[]'::jsonb end)
    from public.project_tasks t join public.projects p on p.id = t.project_id where t.id = p_id;
$$;
create or replace function trash_private.collect_project_task(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'project_tasks', id from public.project_tasks where id = p_id
  union all select 'project_task_comments', id from public.project_task_comments where task_id = p_id;
$$;

create or replace function trash_private.describe_project_idea(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', i.title, 'context', 'Projet ' || p.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'projects', 'id', i.project_id)),
    'warnings', to_jsonb(array_remove(array[
      case when p.portal_published then 'Les idées sont visibles au portail : elle en disparaît aussi.' end,
      case when exists (select 1 from public.project_tasks t where t.idea_id = i.id) then 'La tâche créée à partir de cette idée reste.' end
    ], null)))
    from public.project_ideas i join public.projects p on p.id = i.project_id where i.id = p_id;
$$;
create or replace function trash_private.collect_project_idea(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'project_ideas', id from public.project_ideas where id = p_id
  union all select 'project_idea_comments', id from public.project_idea_comments where idea_id = p_id;
$$;

create or replace function trash_private.describe_project_phase(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', ph.name, 'context', 'Planning du projet ' || p.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'projects', 'id', ph.project_id)),
    'warnings', case when p.portal_published then jsonb_build_array('Le planning est visible au portail : la phase en disparaît aussi.') else '[]'::jsonb end)
    from public.project_phases ph join public.projects p on p.id = ph.project_id where ph.id = p_id;
$$;
create or replace function trash_private.collect_project_phase(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'project_phases', id from public.project_phases where id = p_id
  union all select 'project_milestones', id from public.project_milestones where phase_id = p_id;
$$;

create or replace function trash_private.describe_project_meeting(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', coalesce(m.title, b.event_snapshot ->> 'name', 'Point de suivi') || ' du ' || to_char(b.starts_at at time zone 'Europe/Paris', 'DD/MM/YYYY'),
    'context', 'Projet ' || p.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'projects', 'id', m.project_id)),
    'warnings', to_jsonb(array_remove(array[
      'Le rendez-vous reste dans l''agenda : seul le point de suivi du projet part.',
      case when exists (select 1 from public.meeting_recaps r where r.meeting_id = m.id) then 'Son récapitulatif part avec lui.' end
    ], null)))
    from public.project_meetings m join public.projects p on p.id = m.project_id join public.appt_bookings b on b.id = m.booking_id
   where m.id = p_id;
$$;
create or replace function trash_private.collect_project_meeting(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'project_meetings', id from public.project_meetings where id = p_id;
$$;

revoke all on function trash_private.describe_project(uuid), trash_private.collect_project(uuid),
  trash_private.describe_project_task(uuid), trash_private.collect_project_task(uuid),
  trash_private.describe_project_idea(uuid), trash_private.collect_project_idea(uuid),
  trash_private.describe_project_phase(uuid), trash_private.collect_project_phase(uuid),
  trash_private.describe_project_meeting(uuid), trash_private.collect_project_meeting(uuid) from public, anon;
grant execute on function trash_private.describe_project(uuid), trash_private.collect_project(uuid),
  trash_private.describe_project_task(uuid), trash_private.collect_project_task(uuid),
  trash_private.describe_project_idea(uuid), trash_private.collect_project_idea(uuid),
  trash_private.describe_project_phase(uuid), trash_private.collect_project_phase(uuid),
  trash_private.describe_project_meeting(uuid), trash_private.collect_project_meeting(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Portail client (fonctions privilégiées : le filtre y est explicite)
-- ---------------------------------------------------------------------------
-- portal_private.session_person
CREATE OR REPLACE FUNCTION portal_private.session_person(p_server_key text, p_session_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_person uuid;
  v_session uuid;
begin
  perform portal_private.assert_server(p_server_key);
  select a.person_id, s.id into v_person, v_session
    from public.portal_sessions s
    join public.portal_accesses a on a.id = s.access_id
   where s.token_hash = p_session_hash and s.revoked_at is null and s.expires_at > now()
     and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
     and not public.in_trash('portal_accesses', a.id) and not public.in_trash('people', a.person_id);
  if v_person is null then
    raise exception 'Session expirée' using errcode = '28000';
  end if;
  update public.portal_sessions set last_seen_at = now() where id = v_session and last_seen_at < now() - interval '5 minutes';
  return v_person;
end;
$function$;

-- portal_private.visible_projects
CREATE OR REPLACE FUNCTION portal_private.visible_projects(p_person uuid)
 RETURNS TABLE(project_id uuid, read_only boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select p.id, p.status = 'archive'
    from public.project_members m
    join public.projects p on p.id = m.project_id
   where m.person_id = p_person and p.portal_published
     and not public.in_trash('projects', p.id) and not public.in_trash('people', p_person)
     and (p.status <> 'archive' or p.archived_portal = 'read_only');
$function$;

-- portal_private.project_view
CREATE OR REPLACE FUNCTION portal_private.project_view(p_project uuid, p_person uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'status', p.status,
    'start_date', p.start_date, 'end_date', p.end_date, 'client_update', p.client_update,
    'read_only', p.status = 'archive', 'company', c.name, 'updated_at', p.updated_at,
    'today', (now() at time zone 'Europe/Paris')::date,
    'phases', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ph.id, 'name', ph.name, 'description', ph.description, 'deliverables', ph.deliverables,
        'start_date', ph.start_date, 'end_date', ph.end_date, 'color', ph.color, 'status', ph.status,
        'completed_at', ph.completed_at) order by ph.position, ph.start_date nulls last)
      from public.project_phases ph where ph.project_id = p.id and not public.in_trash('project_phases', ph.id)), '[]'),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ms.id, 'title', ms.title, 'due_date', ms.due_date, 'done', ms.done_at is not null, 'phase_id', ms.phase_id) order by ms.due_date)
      from public.project_milestones ms where ms.project_id = p.id and ms.visible_to_client and not public.in_trash('project_milestones', ms.id)), '[]'),
    'meetings', coalesce((select jsonb_agg(portal_private.meeting_json(m, b, false) order by b.starts_at)
      from public.project_meetings m join public.appt_bookings b on b.id = m.booking_id
     where m.project_id = p.id and m.visible_to_client and not public.in_trash('project_meetings', m.id) and b.status in ('confirmed','cancelled')), '[]'))
    from public.projects p join public.companies c on c.id = p.company_id
   where p.id = p_project and not public.in_trash('projects', p.id);
$function$;

-- portal_private.meeting_view
CREATE OR REPLACE FUNCTION portal_private.meeting_view(p_project uuid, p_meeting uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select portal_private.meeting_json(m, b, true) || jsonb_build_object(
    'recap', (select jsonb_build_object('summary', r.summary, 'decisions', r.decisions, 'actions', r.actions,
                                        'next_step', r.next_step, 'links', r.links, 'published_at', r.published_at)
                from public.meeting_recaps r where r.meeting_id = m.id and r.status = 'published'))
    from public.project_meetings m join public.appt_bookings b on b.id = m.booking_id
   where m.id = p_meeting and m.project_id = p_project and not public.in_trash('project_meetings', m.id) and m.visible_to_client and b.status in ('confirmed','cancelled');
$function$;

-- public.portal_tasks
CREATE OR REPLACE FUNCTION public.portal_tasks(p_server_key text, p_session_hash text, p_project uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 300)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  if p_project is not null then perform portal_private.assert_project(v_person, p_project); end if;
  return coalesce((
    select jsonb_agg(portal_private.task_json(t, v_person) order by t.status = 'termine', t.due_date nulls last, t.position, t.created_at)
      from (select t.* from public.project_tasks t
             where t.visible_to_client and not public.in_trash('project_tasks', t.id)
               and t.project_id in (select project_id from portal_private.visible_projects(v_person))
               and (p_project is null or t.project_id = p_project)
             order by t.status = 'termine', t.due_date nulls last, t.position, t.created_at
             limit greatest(1, least(p_limit, 500))) t), '[]');
end; $function$;

-- portal_private.task_json
CREATE OR REPLACE FUNCTION portal_private.task_json(t public.project_tasks, p_person uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', t.id, 'project_id', t.project_id, 'project_name', (select name from public.projects where id = t.project_id),
    'title', t.title, 'status', t.status, 'due_date', t.due_date, 'blocked_reason', t.blocked_reason,
    'assignee', case when t.assignee_kind = 'owner' then jsonb_build_object('kind', 'owner', 'name', 'Cely Growth')
                     when t.assignee_person_id is null then jsonb_build_object('kind', 'team', 'name', 'Équipe client')
                     else jsonb_build_object('kind', case when t.assignee_person_id = p_person then 'me' else 'person' end,
                                             'name', (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = t.assignee_person_id)) end,
    'meeting', (select jsonb_build_object('id', pm.id, 'title', coalesce(pm.title, b.event_snapshot ->> 'name'), 'starts_at', b.starts_at)
                  from public.project_meetings pm join public.appt_bookings b on b.id = pm.booking_id
                 where pm.id = t.meeting_id and pm.visible_to_client and not public.in_trash('project_meetings', pm.id) and b.status in ('confirmed','cancelled')),
    'updated_at', t.updated_at, 'can_edit', portal_private.task_editable(t, p_person),
    'comment_count', (select count(*) from public.project_task_comments c where c.task_id = t.id and not c.internal and not public.in_trash('project_task_comments', c.id)));
$function$;

-- portal_private.my_open_tasks
CREATE OR REPLACE FUNCTION portal_private.my_open_tasks(p_project uuid, p_person uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(portal_private.task_json(t, p_person) order by t.due_date nulls last, t.position), '[]')
    from (select * from public.project_tasks t
           where t.project_id = p_project and t.visible_to_client and not public.in_trash('project_tasks', t.id) and t.assignee_kind = 'client'
             and (t.assignee_person_id is null or t.assignee_person_id = p_person) and t.status <> 'termine'
           order by t.due_date nulls last, t.position limit 5) t;
$function$;

-- public.portal_task
CREATE OR REPLACE FUNCTION public.portal_task(p_server_key text, p_session_hash text, p_task uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client and not public.in_trash('project_tasks', p_task);
  if not found or not exists (select 1 from portal_private.visible_projects(v_person) where project_id = t.project_id) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  return portal_private.task_json(t, v_person) || jsonb_build_object(
    'description', t.description, 'links', t.links,
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'created_at', c.created_at, 'mine', c.person_id = v_person,
        'author', case when c.author_kind = 'owner' then 'Cely Growth'
                       else (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = c.person_id) end) order by c.created_at)
      from public.project_task_comments c where c.task_id = t.id and not c.internal and not public.in_trash('project_task_comments', c.id)), '[]'));
end; $function$;

-- public.portal_task_update
CREATE OR REPLACE FUNCTION public.portal_task_update(p_server_key text, p_session_hash text, p_task uuid, p_status text, p_blocked_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client and not public.in_trash('project_tasks', p_task) for update;
  if not found or not exists (select 1 from portal_private.visible_projects(v_person) where project_id = t.project_id) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  if not portal_private.task_editable(t, v_person) then
    raise exception 'Cette tâche n''est pas attribuée à vous : vous pouvez la consulter et la commenter.' using errcode = '42501';
  end if;
  if p_status not in ('a_faire','en_cours','bloque','termine') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  if p_status = 'bloque' and coalesce(btrim(p_blocked_reason), '') = '' then
    raise exception 'Expliquez en quelques mots ce qui bloque' using errcode = '22023';
  end if;
  update public.project_tasks set status = p_status, blocked_reason = nullif(btrim(coalesce(p_blocked_reason, '')), ''),
         updated_by_kind = 'client', updated_by_person = v_person
   where id = p_task returning * into t;
  perform portal_private.log(t.project_id, 'client', v_person, 'task_status', jsonb_build_object('task_id', t.id, 'status', p_status));
  return portal_private.task_json(t, v_person);
end; $function$;

-- public.portal_task_comment
CREATE OR REPLACE FUNCTION public.portal_task_comment(p_server_key text, p_session_hash text, p_task uuid, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
  v_id uuid;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client and not public.in_trash('project_tasks', p_task);
  if not found then raise exception 'Tâche introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, t.project_id, true);
  if coalesce(btrim(p_body), '') = '' or char_length(p_body) > 1000 then raise exception 'Commentaire vide ou trop long (1 000 caractères)' using errcode = '22023'; end if;
  insert into public.project_task_comments (task_id, author_kind, person_id, body) values (p_task, 'client', v_person, btrim(p_body)) returning id into v_id;
  perform portal_private.log(t.project_id, 'client', v_person, 'task_comment', jsonb_build_object('task_id', t.id));
  return jsonb_build_object('id', v_id);
end; $function$;

-- public.portal_ideas
CREATE OR REPLACE FUNCTION public.portal_ideas(p_server_key text, p_session_hash text, p_project uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return coalesce((select jsonb_agg(portal_private.idea_json(i, v_person) order by i.created_at desc)
                     from (select * from public.project_ideas where project_id = p_project and not public.in_trash('project_ideas', id) order by created_at desc limit 200) i), '[]');
end; $function$;

-- public.portal_idea_save
CREATE OR REPLACE FUNCTION public.portal_idea_save(p_server_key text, p_session_hash text, p_project uuid, p_idea uuid, p_title text, p_description text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  i public.project_ideas;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  if coalesce(btrim(p_title), '') = '' or char_length(p_title) > 160 then raise exception 'Titre obligatoire (160 caractères maximum)' using errcode = '22023'; end if;
  if char_length(coalesce(p_description, '')) > 4000 then raise exception 'Description trop longue' using errcode = '22023'; end if;
  if p_idea is null then
    if (select count(*) from public.project_ideas where author_person = v_person and created_at > now() - interval '1 hour') >= 20 then
      raise exception 'Beaucoup d''idées en peu de temps : réessayez plus tard' using errcode = '22023';
    end if;
    insert into public.project_ideas (project_id, title, description, author_kind, author_person)
    values (p_project, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), 'client', v_person) returning * into i;
    perform portal_private.log(p_project, 'client', v_person, 'idea_created', jsonb_build_object('idea_id', i.id));
  else
    select * into i from public.project_ideas where id = p_idea and project_id = p_project and not public.in_trash('project_ideas', p_idea) for update;
    if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
    if i.author_kind <> 'client' or i.author_person is distinct from v_person then raise exception 'Seul l''auteur peut modifier cette idée' using errcode = '42501'; end if;
    if i.status <> 'a_explorer' then raise exception 'Une décision a été prise : l''idée n''est plus modifiable, ajoutez plutôt un commentaire' using errcode = '42501'; end if;
    update public.project_ideas set title = btrim(p_title), description = nullif(btrim(coalesce(p_description, '')), '') where id = i.id returning * into i;
  end if;
  return portal_private.idea_json(i, v_person);
end; $function$;

-- public.portal_idea_comment
CREATE OR REPLACE FUNCTION public.portal_idea_comment(p_server_key text, p_session_hash text, p_project uuid, p_idea uuid, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  i public.project_ideas;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  select * into i from public.project_ideas where id = p_idea and project_id = p_project and not public.in_trash('project_ideas', p_idea);
  if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
  if coalesce(btrim(p_body), '') = '' or char_length(p_body) > 1000 then raise exception 'Commentaire vide ou trop long (1 000 caractères)' using errcode = '22023'; end if;
  insert into public.project_idea_comments (idea_id, author_kind, person_id, body) values (i.id, 'client', v_person, btrim(p_body));
  return portal_private.idea_json(i, v_person);
end; $function$;

-- portal_private.idea_json
CREATE OR REPLACE FUNCTION portal_private.idea_json(i public.project_ideas, p_person uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'description', i.description, 'status', i.status, 'decision_note', i.decision_note,
    'created_at', i.created_at, 'updated_at', i.updated_at,
    'author', case when i.author_kind = 'owner' then 'Cely Growth' else portal_private.person_name(i.author_person) end,
    'mine', i.author_kind = 'client' and i.author_person = p_person,
    'can_edit', i.author_kind = 'client' and i.author_person = p_person and i.status = 'a_explorer',
    'has_task', exists (select 1 from public.project_tasks t where t.idea_id = i.id and not public.in_trash('project_tasks', t.id)),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'created_at', c.created_at,
        'author', case when c.author_kind = 'owner' then 'Cely Growth' else portal_private.person_name(c.person_id) end) order by c.created_at)
      from public.project_idea_comments c where c.idea_id = i.id and not public.in_trash('project_idea_comments', c.id)), '[]'));
$function$;

-- public.portal_upcoming_meetings
CREATE OR REPLACE FUNCTION public.portal_upcoming_meetings(p_server_key text, p_session_hash text, p_limit integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  return coalesce((
    select jsonb_agg(x.j order by x.starts_at)
      from (select portal_private.meeting_json(m, b, false) || jsonb_build_object('project_id', p.id, 'project_name', p.name) as j, b.starts_at
              from portal_private.visible_projects(v_person) v
              join public.projects p on p.id = v.project_id
              join public.project_meetings m on m.project_id = p.id and m.visible_to_client and not public.in_trash('project_meetings', m.id)
              join public.appt_bookings b on b.id = m.booking_id
             where b.status = 'confirmed' and b.ends_at > now() and b.outcome is distinct from 'done'
             order by b.starts_at
             limit greatest(1, least(coalesce(p_limit, 3), 10))) x), '[]');
end; $function$;

revoke all on all functions in schema portal_private from public, anon, authenticated;
