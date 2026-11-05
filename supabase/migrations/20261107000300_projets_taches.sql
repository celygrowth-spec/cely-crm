-- Projets et portail client — phase 3 : tâches de projet et commentaires. Migration additive.
-- Une action = une seule ligne, quelle que soit la vue (tableau du projet, « Mes tâches », point associé).
-- Règles client (vérifiées en base) : il ne voit que les tâches explicitement visibles ; il ne modifie que le
-- statut et l'explication d'un blocage des tâches qui lui sont attribuées (à lui, ou à l'équipe client) ;
-- il commente les tâches visibles. Il ne crée ni ne supprime de tâche et ne touche jamais au planning.

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  description text check (description is null or char_length(description) <= 5000),
  status text not null default 'a_faire' check (status in ('a_faire','en_cours','bloque','termine')),
  -- responsable : moi (owner) ou le client (une personne précise, ou l'équipe client si person_id est vide)
  assignee_kind text not null default 'owner' check (assignee_kind in ('owner','client')),
  assignee_person_id uuid references public.people (id) on delete set null,
  visible_to_client boolean not null default false,
  due_date date,
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 1000),
  meeting_id uuid references public.project_meetings (id) on delete set null,
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 10),
  position int not null default 0,
  created_by_kind text not null default 'owner' check (created_by_kind in ('owner','client')),
  created_by_person uuid references public.people (id) on delete set null,
  updated_by_kind text not null default 'owner' check (updated_by_kind in ('owner','client')),
  updated_by_person uuid references public.people (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- une tâche attribuée au client lui est forcément visible
  check (assignee_kind = 'owner' or visible_to_client),
  check (assignee_kind = 'client' or assignee_person_id is null)
);
create index project_tasks_project_idx on public.project_tasks (project_id, status);
create index project_tasks_meeting_idx on public.project_tasks (meeting_id) where meeting_id is not null;

create table public.project_task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.project_tasks (id) on delete cascade,
  author_kind text not null check (author_kind in ('owner','client')),
  person_id uuid references public.people (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index project_task_comments_idx on public.project_task_comments (task_id, created_at);

create or replace function portal_private.tg_task()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.completed_at := case when new.status <> 'termine' then null
                           when tg_op = 'UPDATE' and old.status = 'termine' then old.completed_at else now() end;
  if new.status <> 'bloque' then new.blocked_reason := null; end if;
  if new.assignee_person_id is not null and not exists (
       select 1 from public.project_members m where m.project_id = new.project_id and m.person_id = new.assignee_person_id) then
    raise exception 'Le responsable doit être un contact du projet' using errcode = '22023';
  end if;
  if new.meeting_id is not null and not exists (select 1 from public.project_meetings pm where pm.id = new.meeting_id and pm.project_id = new.project_id) then
    raise exception 'Ce point n''appartient pas au projet' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger project_tasks_rules before insert or update on public.project_tasks for each row execute function portal_private.tg_task();

do $$
declare t text;
begin
  foreach t in array array['project_tasks','project_task_comments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Portail
-- ---------------------------------------------------------------------------

-- La personne peut-elle modifier cette tâche ? (attribuée à elle, ou à l'équipe client ; projet ouvert)
create or replace function portal_private.task_editable(t public.project_tasks, p_person uuid)
returns boolean language sql stable set search_path = '' as $$
  select t.assignee_kind = 'client' and (t.assignee_person_id is null or t.assignee_person_id = p_person)
     and exists (select 1 from portal_private.visible_projects(p_person) v where v.project_id = t.project_id and not v.read_only);
$$;

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
    'comment_count', (select count(*) from public.project_task_comments c where c.task_id = t.id));
$$;

-- Tâches visibles : un projet précis, ou tous les projets autorisés (« Mes tâches »)
create or replace function public.portal_tasks(p_server_key text, p_session_hash text, p_project uuid default null, p_limit int default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  if p_project is not null then perform portal_private.assert_project(v_person, p_project); end if;
  return coalesce((
    select jsonb_agg(portal_private.task_json(t, v_person) order by t.status = 'termine', t.due_date nulls last, t.position, t.created_at)
      from (select t.* from public.project_tasks t
             where t.visible_to_client
               and t.project_id in (select project_id from portal_private.visible_projects(v_person))
               and (p_project is null or t.project_id = p_project)
             order by t.status = 'termine', t.due_date nulls last, t.position, t.created_at
             limit greatest(1, least(p_limit, 500))) t), '[]');
end; $$;

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
      from public.project_task_comments c where c.task_id = t.id), '[]'));
end; $$;

-- Modification par le client : statut et explication d'un blocage uniquement.
create or replace function public.portal_task_update(p_server_key text, p_session_hash text, p_task uuid, p_status text, p_blocked_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client for update;
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
end; $$;

create or replace function public.portal_task_comment(p_server_key text, p_session_hash text, p_task uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
  v_id uuid;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client;
  if not found then raise exception 'Tâche introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, t.project_id, true);
  if coalesce(btrim(p_body), '') = '' or char_length(p_body) > 1000 then raise exception 'Commentaire vide ou trop long (1 000 caractères)' using errcode = '22023'; end if;
  insert into public.project_task_comments (task_id, author_kind, person_id, body) values (p_task, 'client', v_person, btrim(p_body)) returning id into v_id;
  perform portal_private.log(t.project_id, 'client', v_person, 'task_comment', jsonb_build_object('task_id', t.id));
  return jsonb_build_object('id', v_id);
end; $$;

-- Ce qui attend le client sur un projet (vue d'ensemble) : ses tâches ouvertes
create or replace function portal_private.my_open_tasks(p_project uuid, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(portal_private.task_json(t, p_person) order by t.due_date nulls last, t.position), '[]')
    from (select * from public.project_tasks t
           where t.project_id = p_project and t.visible_to_client and t.assignee_kind = 'client'
             and (t.assignee_person_id is null or t.assignee_person_id = p_person) and t.status <> 'termine'
           order by t.due_date nulls last, t.position limit 5) t;
$$;

create or replace function public.portal_project(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return portal_private.project_view(p_project, v_person) || jsonb_build_object('my_tasks', portal_private.my_open_tasks(p_project, v_person));
end; $$;

create or replace function public.portal_preview_project(p_project uuid, p_person uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.project_members where project_id = p_project and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  return portal_private.project_view(p_project, p_person) || jsonb_build_object('my_tasks', portal_private.my_open_tasks(p_project, p_person));
end; $$;

-- Vue d'administration : compteur des tâches client ouvertes
create or replace view public.project_overview with (security_invoker = true) as
  select p.*, c.name as company_name,
         (select count(*) from public.project_members m where m.project_id = p.id)::int as member_count,
         (select ph.name from public.project_phases ph where ph.project_id = p.id and ph.status = 'en_cours' order by ph.position limit 1) as current_phase_name,
         (select min(b.starts_at) from public.project_meetings pm join public.appt_bookings b on b.id = pm.booking_id
           where pm.project_id = p.id and b.status = 'confirmed' and b.starts_at > now()) as next_meeting_at,
         (select count(*) from public.project_tasks t where t.project_id = p.id and t.assignee_kind = 'client' and t.status <> 'termine')::int as open_client_tasks,
         (select count(*) from public.project_tasks t where t.project_id = p.id and t.status = 'bloque')::int as blocked_tasks
    from public.projects p
    join public.companies c on c.id = p.company_id;
revoke all on public.project_overview from anon;
grant select on public.project_overview to authenticated;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'portal_tasks(text, text, uuid, int)', 'portal_task(text, text, uuid)', 'portal_task_update(text, text, uuid, text, text)',
    'portal_task_comment(text, text, uuid, text)', 'portal_project(text, text, uuid)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  execute 'revoke all on function public.portal_preview_project(uuid, uuid) from public, anon';
  execute 'grant execute on function public.portal_preview_project(uuid, uuid) to authenticated';
end $$;
