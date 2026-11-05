-- Projets et portail client — phase 5 : boîte à idées. Migration additive.
-- Tout membre autorisé propose et commente ; l'auteur modifie son idée tant qu'elle est « à explorer » ;
-- seul l'administrateur décide du statut (avec une explication) et transforme une idée en tâche.

create table public.project_ideas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text check (description is null or char_length(description) <= 4000),
  status text not null default 'a_explorer' check (status in ('a_explorer','retenue','plus_tard','ecartee')),
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  author_kind text not null check (author_kind in ('owner','client')),
  author_person uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_ideas_idx on public.project_ideas (project_id, created_at desc);

create table public.project_idea_comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.project_ideas (id) on delete cascade,
  author_kind text not null check (author_kind in ('owner','client')),
  person_id uuid references public.people (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index project_idea_comments_idx on public.project_idea_comments (idea_id, created_at);

-- idée transformée en tâche : lien d'origine, une seule tâche par idée
alter table public.project_tasks add column idea_id uuid references public.project_ideas (id) on delete set null;
create unique index project_tasks_idea_uniq on public.project_tasks (idea_id) where idea_id is not null;

create trigger set_updated_at before update on public.project_ideas for each row execute function public.tg_set_updated_at();

do $$
declare t text;
begin
  foreach t in array array['project_ideas','project_idea_comments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create or replace function portal_private.person_name(p uuid)
returns text language sql stable set search_path = '' as $$
  select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = p;
$$;

create or replace function portal_private.idea_json(i public.project_ideas, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'description', i.description, 'status', i.status, 'decision_note', i.decision_note,
    'created_at', i.created_at, 'updated_at', i.updated_at,
    'author', case when i.author_kind = 'owner' then 'Cely Growth' else portal_private.person_name(i.author_person) end,
    'mine', i.author_kind = 'client' and i.author_person = p_person,
    'can_edit', i.author_kind = 'client' and i.author_person = p_person and i.status = 'a_explorer',
    'has_task', exists (select 1 from public.project_tasks t where t.idea_id = i.id),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'created_at', c.created_at,
        'author', case when c.author_kind = 'owner' then 'Cely Growth' else portal_private.person_name(c.person_id) end) order by c.created_at)
      from public.project_idea_comments c where c.idea_id = i.id), '[]'));
$$;

create or replace function public.portal_ideas(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return coalesce((select jsonb_agg(portal_private.idea_json(i, v_person) order by i.created_at desc)
                     from (select * from public.project_ideas where project_id = p_project order by created_at desc limit 200) i), '[]');
end; $$;

create or replace function public.portal_idea_save(p_server_key text, p_session_hash text, p_project uuid, p_idea uuid, p_title text, p_description text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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
    select * into i from public.project_ideas where id = p_idea and project_id = p_project for update;
    if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
    if i.author_kind <> 'client' or i.author_person is distinct from v_person then raise exception 'Seul l''auteur peut modifier cette idée' using errcode = '42501'; end if;
    if i.status <> 'a_explorer' then raise exception 'Une décision a été prise : l''idée n''est plus modifiable, ajoutez plutôt un commentaire' using errcode = '42501'; end if;
    update public.project_ideas set title = btrim(p_title), description = nullif(btrim(coalesce(p_description, '')), '') where id = i.id returning * into i;
  end if;
  return portal_private.idea_json(i, v_person);
end; $$;

create or replace function public.portal_idea_comment(p_server_key text, p_session_hash text, p_project uuid, p_idea uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  i public.project_ideas;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  select * into i from public.project_ideas where id = p_idea and project_id = p_project;
  if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
  if coalesce(btrim(p_body), '') = '' or char_length(p_body) > 1000 then raise exception 'Commentaire vide ou trop long (1 000 caractères)' using errcode = '22023'; end if;
  insert into public.project_idea_comments (idea_id, author_kind, person_id, body) values (i.id, 'client', v_person, btrim(p_body));
  return portal_private.idea_json(i, v_person);
end; $$;

-- Administration : idée → tâche, sans doublon, avec le lien d'origine
create or replace function public.project_idea_to_task(p_idea uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.project_ideas;
  v_id uuid;
begin
  perform portal_private.assert_owner_user();
  select * into i from public.project_ideas where id = p_idea for update;
  if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
  select id into v_id from public.project_tasks where idea_id = p_idea;
  if v_id is not null then return v_id; end if;
  insert into public.project_tasks (project_id, title, description, idea_id, assignee_kind, visible_to_client)
  values (i.project_id, left(i.title, 300), i.description, i.id, 'owner', true) returning id into v_id;
  if i.status = 'a_explorer' then update public.project_ideas set status = 'retenue' where id = i.id; end if;
  perform portal_private.log(i.project_id, 'owner', null, 'idea_to_task', jsonb_build_object('idea_id', i.id, 'task_id', v_id));
  return v_id;
end; $$;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['portal_ideas(text, text, uuid)', 'portal_idea_save(text, text, uuid, uuid, text, text)', 'portal_idea_comment(text, text, uuid, uuid, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  execute 'revoke all on function public.project_idea_to_task(uuid) from public, anon';
  execute 'grant execute on function public.project_idea_to_task(uuid) to authenticated';
end $$;
