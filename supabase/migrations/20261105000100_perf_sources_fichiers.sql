-- Performance (index, pagination serveur), sources personnalisables, fichiers des fiches.
-- Migration additive : aucune donnée supprimée.

-- ---------------------------------------------------------------------------
-- Index justifiés par les filtres, tris et relations réellement utilisés
-- ---------------------------------------------------------------------------

create index if not exists companies_active_created_idx on public.companies (created_at desc) where merged_into_id is null;
create index if not exists companies_source_idx on public.companies (source_id) where merged_into_id is null;
create index if not exists companies_status_idx on public.companies (prospect_status) where merged_into_id is null;
create index if not exists companies_pipeline_deal_idx on public.companies (pipeline_id, deal_status) where merged_into_id is null;
create index if not exists companies_domain_trgm on public.companies using gin (domain_norm extensions.gin_trgm_ops);
create index if not exists people_name_trgm on public.people using gin (full_name_norm extensions.gin_trgm_ops);
create index if not exists people_email_trgm on public.people using gin (email_norm extensions.gin_trgm_ops);
create index if not exists tasks_company_open_idx on public.tasks (company_id, due_date) where done_at is null;
create index if not exists interactions_participant_idx on public.interactions (campaign_participant_id) where campaign_participant_id is not null;
create index if not exists participants_replies_idx on public.campaign_participants (status, outcome);

-- ---------------------------------------------------------------------------
-- Sources du contact : couleur, ordre, archivage (évolution de lead_sources)
-- ---------------------------------------------------------------------------

alter table public.lead_sources
  add column color text not null default 'slate'
    check (color in ('slate','violet','blue','green','amber','red','pink','teal')),
  add column archived_at timestamptz;

update public.lead_sources set color = case lower(name)
  when 'linkedin' then 'blue' when 'email sortant' then 'violet' when 'recommandation' then 'green'
  when 'site web' then 'teal' when 'événement' then 'amber' else 'slate' end;

insert into public.lead_sources (name, position, color) values
  ('Ancien client', 7, 'pink'), ('Partenaire', 8, 'teal')
on conflict do nothing;

create or replace function public.reorder_sources(p_ids uuid[])
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.lead_sources s set position = o.ord
    from unnest(p_ids) with ordinality o(id, ord) where s.id = o.id;
end;
$$;

-- Suppression définitive : les fiches sont réaffectées ou leur source est vidée, jamais supprimées.
create or replace function public.delete_source(p_id uuid, p_replacement uuid default null)
returns jsonb
language plpgsql
as $$
declare v_moved int;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression de source');
  if p_replacement = p_id then raise exception 'Choisissez une autre source' using errcode = '22023'; end if;
  if p_replacement is not null and not exists (select 1 from public.lead_sources where id = p_replacement) then
    raise exception 'Source de remplacement introuvable' using errcode = 'P0002';
  end if;
  update public.companies set source_id = p_replacement where source_id = p_id;
  get diagnostics v_moved = row_count;
  delete from public.lead_sources where id = p_id;
  if not found then raise exception 'Source introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('moved', v_moved);
end;
$$;

-- Modification groupée
create or replace function public.set_companies_source(p_ids uuid[], p_source uuid)
returns int
language plpgsql
as $$
declare n int;
begin
  perform public.assert_owner();
  if public.current_actor() = 'claude' and cardinality(p_ids) > 1 then
    perform public.assert_not_claude('Modification groupée');
  end if;
  update public.companies set source_id = p_source where id = any (p_ids) and merged_into_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Base de prospects : pagination, filtres et tri côté serveur.
-- Seules les lignes de la page sont enrichies (contact, listes, prochaine action).
-- ---------------------------------------------------------------------------

create or replace function public.companies_page(
  p_filters jsonb default '{}', p_sort text default 'created', p_asc boolean default false,
  p_limit int default 50, p_offset int default 0, p_ids_only boolean default false)
returns jsonb
language plpgsql
stable
as $$
declare
  v_q text := nullif(lower(btrim(coalesce(p_filters ->> 'q', ''))), '');
  v_qn text := public.norm_company_name(p_filters ->> 'q');
  v_qp text := public.norm_person_name(p_filters ->> 'q', null);
  v_list uuid := nullif(p_filters ->> 'list', '')::uuid;
  v_source text := nullif(p_filters ->> 'source', '');
  v_tag text := nullif(p_filters ->> 'tag', '');
  v_status text := nullif(p_filters ->> 'status', '');
  v_pipeline text := nullif(p_filters ->> 'pipeline', '');
  v_archived boolean := coalesce((p_filters ->> 'archived')::boolean, false);
  v_order text;
  v_where text := $w$
    c.merged_into_id is null
    and (case when $5 then c.archived_at is not null else c.archived_at is null end)
    and ($1 is null or c.name ilike '%' || $1 || '%' or c.name_norm like '%' || coalesce($2, $1) || '%'
         or c.domain_norm like '%' || $1 || '%'
         or exists (select 1 from public.people p where p.company_id = c.id
                    and (p.full_name_norm like '%' || coalesce($3, $1) || '%' or p.email_norm like '%' || $1 || '%')))
    and ($4 is null or exists (select 1 from public.list_members m where m.company_id = c.id and m.list_id = $4))
    and ($6 is null or ($6 = 'none' and c.source_id is null) or c.source_id::text = $6)
    and ($7 is null or c.tags @> array[$7])
    and ($8 is null or c.prospect_status = $8)
    and ($9 is null or ($9 = 'yes' and c.pipeline_id is not null) or ($9 = 'no' and c.pipeline_id is null))
  $w$;
  v_res jsonb;
begin
  perform public.assert_owner();
  if p_ids_only then
    execute 'select coalesce(jsonb_agg(c.id), ''[]'') from (select c.id from public.companies c where ' || v_where || ' limit 5000) c'
      into v_res using v_q, v_qn, v_qp, v_list, v_archived, v_source, v_tag, v_status, v_pipeline;
    return v_res;
  end if;

  v_order := case p_sort
    when 'name' then 'c.name_norm'
    when 'contact' then '(select p.full_name_norm from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1)'
    when 'source' then '(select s.position from public.lead_sources s where s.id = c.source_id)'
    when 'status' then 'c.prospect_status'
    when 'last' then 'c.last_interaction_at'
    when 'next' then '(select min(t.due_date) from public.todo_items t where t.company_id = c.id)'
    else 'c.created_at' end;

  execute format($q$
    with filtered as (select c.id from public.companies c where %1$s),
    page as (
      select c.* from public.companies c join filtered f on f.id = c.id
       order by %2$s %3$s nulls last, c.id
       limit greatest(1, least($10, 200)) offset greatest($11, 0)
    )
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(r) from (
        select c.id, c.name, c.website, c.domain_norm, c.source_id, c.tags, c.prospect_status, c.pipeline_id, c.stage_id,
               c.deal_status, c.amount, c.last_interaction_at, c.archived_at, c.do_not_contact, c.created_at, c.updated_at,
               pp.id as primary_person_id,
               nullif(btrim(coalesce(pp.first_name,'') || ' ' || coalesce(pp.last_name,'')), '') as primary_person_name,
               (select count(*) from public.people p where p.company_id = c.id)::int as people_count,
               coalesce((select array_agg(m.list_id) from public.list_members m where m.company_id = c.id), '{}') as list_ids,
               na.title as next_action_title, na.due_date as next_action_due, na.item_type as next_action_type
          from page c
          left join lateral (select * from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1) pp on true
          left join lateral (select t.title, t.due_date, t.item_type from public.todo_items t where t.company_id = c.id order by t.due_date, t.item_type limit 1) na on true
         order by %2$s %3$s nulls last, c.id
      ) r), '[]'))
  $q$, v_where, v_order, case when p_asc then 'asc' else 'desc' end)
  into v_res using v_q, v_qn, v_qp, v_list, v_archived, v_source, v_tag, v_status, v_pipeline, p_limit, p_offset;
  return v_res;
end;
$$;

create or replace function public.company_tags()
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(distinct t order by t), '{}')
    from public.companies c, unnest(c.tags) t where c.merged_into_id is null;
$$;

-- Compteurs de la barre latérale, en une seule requête
create or replace function public.nav_counters(p_today date)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'todo', (select count(*) from public.todo_items where due_date <= p_today),
    'due', (select count(*) from public.todo_items where item_type = 'followup' and due_date <= p_today),
    'replies', (select count(*) from public.campaign_participants where status = 'a_repondu' and outcome in ('none', 'replied')));
$$;

-- ---------------------------------------------------------------------------
-- Fichiers : métadonnées en base, contenu dans un bucket Storage privé
-- ---------------------------------------------------------------------------

create table public.company_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  storage_path text not null unique,          -- nom de stockage unique, distinct du nom affiché
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  category text check (category is null or category in ('Proposition', 'Contrat', 'Brief', 'Présentation', 'Autre')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  -- pending : transfert en cours ; ready : disponible ; deleting : suppression à terminer
  status text not null default 'pending' check (status in ('pending', 'ready', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index company_files_company_idx on public.company_files (company_id, created_at desc);
create index company_files_pending_idx on public.company_files (created_at) where status <> 'ready';
create trigger set_updated_at before update on public.company_files
  for each row execute function public.tg_set_updated_at();

alter table public.company_files enable row level security;
create policy owner_select on public.company_files for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.company_files for insert to authenticated with check ((select public.is_app_owner()));
create policy owner_update on public.company_files for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()));
create policy owner_delete on public.company_files for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.company_files from anon;

-- Une fusion de fiches conserve les fichiers
create or replace function public.tg_companies_merge_files()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.company_files set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger companies_merge_files after update of merged_into_id on public.companies
  for each row execute function public.tg_companies_merge_files();

-- Bucket privé : taille et formats contrôlés par Storage lui-même
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-files', 'company-files', false, 26214400, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy company_files_select on storage.objects for select to authenticated
  using (bucket_id = 'company-files' and (select public.is_app_owner()));
create policy company_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'company-files' and (select public.is_app_owner()));
create policy company_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'company-files' and (select public.is_app_owner()) and public.current_actor() = 'user');

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
