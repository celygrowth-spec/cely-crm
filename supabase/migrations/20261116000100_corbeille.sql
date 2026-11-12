-- Corbeille, lot 1 : mécanisme commun (mise à la corbeille, restauration, purge après 30 jours).
--
-- Principe : un élément mis à la corbeille RESTE en base, inchangé. Ses lignes (et celles de ses éléments liés) sont
-- inscrites dans trash_rows ; une politique d'accès restrictive, posée par les lots suivants sur chaque table
-- concernée, les rend invisibles à toute lecture de l'API (listes, recherche, Aujourd'hui, totaux, exports, MCP).
-- Les fonctions privilégiées du portail filtrent explicitement (lot Projets).
--  * Restaurer = retirer l'inscription : l'élément revient exactement dans son état d'avant (aucune ligne réécrite,
--    aucun déclencheur rejoué, numéro de facture conservé puisqu'il n'a jamais quitté la base).
--  * Purger = supprimer physiquement l'élément, ses liés et leurs fichiers stockés (file d'attente trash_file_queue,
--    retirés du stockage par l'application ou par la tâche planifiée).
--  * Aucune action externe : ni mail, ni agenda, ni appel à un service.
-- Additif : aucune table existante n'est modifiée par ce lot.

create schema if not exists trash_private;
revoke all on schema trash_private from public, anon;
grant usage on schema trash_private to authenticated;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.trash_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('company', 'person', 'project', 'project_task', 'project_idea', 'project_phase',
                                     'project_meeting', 'finance_mission', 'finance_invoice', 'finance_payment')),
  row_table text not null,
  row_id uuid not null,
  label text not null check (char_length(label) between 1 and 300),
  context text check (context is null or char_length(context) <= 300),
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),   -- éléments liés, par table
  parents jsonb not null default '[]' check (jsonb_typeof(parents) = 'array'),    -- [{t, id}] : parents directs
  actor text not null default 'user' check (actor in ('user', 'claude')),
  deleted_at timestamptz not null default now(),
  purge_after timestamptz not null default now() + interval '30 days',
  purge_error text check (purge_error is null or char_length(purge_error) <= 500),
  purge_attempts integer not null default 0,
  unique (row_table, row_id)
);
create index trash_items_purge_idx on public.trash_items (purge_after);

-- Une ligne n'appartient qu'à un seul élément de la corbeille.
create table public.trash_rows (
  trash_id uuid not null references public.trash_items (id) on delete cascade,
  row_table text not null,
  row_id uuid not null,
  primary key (row_table, row_id)
);
create index trash_rows_trash_idx on public.trash_rows (trash_id);

-- Fichiers à retirer du stockage après une purge (réessayés tant qu'ils n'ont pas été retirés).
create table public.trash_file_queue (
  path text primary key,
  bucket text not null default 'company-files' check (bucket in ('company-files')),
  queued_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text check (last_error is null or char_length(last_error) <= 500)
);

alter table public.trash_items enable row level security;
alter table public.trash_rows enable row level security;
alter table public.trash_file_queue enable row level security;
-- Réservé au propriétaire ; jamais au portail (anon) ni à un autre compte.
create policy owner_select on public.trash_items for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.trash_items for insert to authenticated with check ((select public.is_app_owner()));
create policy owner_delete on public.trash_items for delete to authenticated using ((select public.is_app_owner()));
create policy owner_select on public.trash_rows for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.trash_rows for insert to authenticated with check ((select public.is_app_owner()));
create policy owner_select on public.trash_file_queue for select to authenticated using ((select public.is_app_owner()));
revoke all on public.trash_items, public.trash_rows, public.trash_file_queue from anon;
revoke update on public.trash_items, public.trash_rows from authenticated;
revoke insert, update, delete on public.trash_file_queue from authenticated;

-- ---------------------------------------------------------------------------
-- Outils
-- ---------------------------------------------------------------------------

-- Vrai si la ligne est inscrite à la corbeille (utilisé par les fonctions privilégiées du portail).
create or replace function public.in_trash(p_table text, p_id uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_id is not null and exists (select 1 from public.trash_rows r where r.row_table = p_table and r.row_id = p_id);
$$;

create or replace function trash_private.kind_table(p_kind text)
returns text language plpgsql immutable set search_path = '' as $$
begin
  return case p_kind
    when 'company' then 'companies' when 'person' then 'people' when 'project' then 'projects'
    when 'project_task' then 'project_tasks' when 'project_idea' then 'project_ideas'
    when 'project_phase' then 'project_phases' when 'project_meeting' then 'project_meetings'
    when 'finance_mission' then 'finance_missions' when 'finance_invoice' then 'finance_invoices'
    when 'finance_payment' then 'finance_payments'
    else null end;
end; $$;

-- Pose la politique restrictive « invisible si à la corbeille » sur une table.
-- p_refs : couples colonne:table vérifiés (la ligne elle-même, et ses parents directs).
-- Exemple : trash_private.hide('project_tasks', array['id:project_tasks', 'project_id:projects']).
create or replace function trash_private.hide(p_table text, p_refs text[])
returns void language plpgsql set search_path = '' as $$
declare v_list text; v_expr text;
begin
  select string_agg(format('(%L, %I.%I)', split_part(r, ':', 2), p_table, split_part(r, ':', 1)), ', ')
    into v_list from unnest(p_refs) r;
  v_expr := format('not exists (select 1 from public.trash_rows r where (r.row_table, r.row_id) in (%s))', v_list);
  execute format('drop policy if exists trash_hidden on public.%I', p_table);
  execute format('create policy trash_hidden on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
                 p_table, v_expr, v_expr);
end; $$;
revoke all on function trash_private.hide(text, text[]) from public, authenticated;

-- Description d'un élément (fonction trash_private.describe_<kind>, définie par le lot du module) :
-- {label, context, parents: [{t, id}], warnings: [texte]} ; null si l'élément est introuvable (ou déjà caché).
create or replace function trash_private.describe(p_kind text, p_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v jsonb;
begin
  if trash_private.kind_table(p_kind) is null then raise exception 'Type d''élément inconnu' using errcode = '22023'; end if;
  if to_regprocedure(format('trash_private.describe_%s(uuid)', p_kind)) is null then
    raise exception 'Ce type d''élément ne se met pas encore à la corbeille' using errcode = '0A000';
  end if;
  execute format('select trash_private.describe_%s($1)', p_kind) into v using p_id;
  return v;
end; $$;

-- Lignes qui partent avec l'élément (lui compris) : fonction trash_private.collect_<kind>.
-- Lue avec les droits de l'appelant : une ligne déjà à la corbeille n'est pas reprise.
create or replace function trash_private.collect(p_kind text, p_id uuid)
returns table (row_table text, row_id uuid) language plpgsql stable set search_path = '' as $$
begin
  return query execute format('select c.row_table, c.row_id from trash_private.collect_%s($1) c', p_kind) using p_id;
end; $$;

create or replace function trash_private.summary(p_rows jsonb, p_table text, p_id uuid)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_object_agg(t, n), '{}') from (
    select r ->> 't' as t, count(*) as n from jsonb_array_elements(p_rows) r
     where not (r ->> 't' = p_table and (r ->> 'id')::uuid = p_id) group by 1) s;
$$;

-- ---------------------------------------------------------------------------
-- Aperçu (fenêtre de confirmation), mise à la corbeille, restauration
-- ---------------------------------------------------------------------------

create or replace function public.trash_preview(p_kind text, p_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_desc jsonb; v_rows jsonb; v_table text := trash_private.kind_table(p_kind);
begin
  perform public.assert_owner();
  v_desc := trash_private.describe(p_kind, p_id);
  if v_desc is null then raise exception 'Élément introuvable (déjà à la corbeille ?)' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('t', c.row_table, 'id', c.row_id)), '[]') into v_rows from trash_private.collect(p_kind, p_id) c;
  return v_desc || jsonb_build_object('kind', p_kind, 'summary', trash_private.summary(v_rows, v_table, p_id));
end; $$;

-- Tout ou rien : une seule transaction. Un double clic retrouve l'élément déjà mis à la corbeille.
create or replace function public.trash_put(p_kind text, p_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_table text := trash_private.kind_table(p_kind);
  v_item public.trash_items;
  v_desc jsonb; v_rows jsonb; v_id uuid;
begin
  perform public.assert_owner();
  if v_table is null then raise exception 'Type d''élément inconnu' using errcode = '22023'; end if;
  if p_id is null then raise exception 'Élément introuvable' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended('trash:' || p_id::text, 0));
  select i.* into v_item from public.trash_rows r join public.trash_items i on i.id = r.trash_id
   where r.row_table = v_table and r.row_id = p_id;
  if found then
    return jsonb_build_object('trash_id', v_item.id, 'already', true, 'label', v_item.label, 'kind', v_item.kind);
  end if;
  v_desc := trash_private.describe(p_kind, p_id);
  if v_desc is null then raise exception 'Élément introuvable' using errcode = 'P0002'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('t', c.row_table, 'id', c.row_id)), '[]') into v_rows from trash_private.collect(p_kind, p_id) c;
  insert into public.trash_items (kind, row_table, row_id, label, context, summary, parents, actor)
  values (p_kind, v_table, p_id, left(coalesce(nullif(btrim(v_desc ->> 'label'), ''), 'Sans nom'), 300),
          left(nullif(btrim(coalesce(v_desc ->> 'context', '')), ''), 300),
          trash_private.summary(v_rows, v_table, p_id), coalesce(v_desc -> 'parents', '[]'), public.current_actor())
  returning id into v_id;
  insert into public.trash_rows (trash_id, row_table, row_id)
  select distinct v_id, r ->> 't', (r ->> 'id')::uuid from jsonb_array_elements(v_rows) r
  on conflict do nothing;
  -- la racine est toujours inscrite, même si la collecte l'omettait
  insert into public.trash_rows (trash_id, row_table, row_id) values (v_id, v_table, p_id) on conflict do nothing;
  return jsonb_build_object('trash_id', v_id, 'already', false, 'label', v_desc ->> 'label', 'kind', p_kind,
                            'summary', trash_private.summary(v_rows, v_table, p_id));
end; $$;

-- Restaure un élément. Si un parent est encore à la corbeille, rien n'est fait : la réponse le nomme
-- (needs_parent) ; avec p_with_parent, le parent est restauré d'abord (avec ses propres liés).
create or replace function public.trash_restore(p_trash uuid, p_with_parent boolean default false)
returns jsonb language plpgsql set search_path = '' as $$
declare v_item public.trash_items; v_parent record; v_blocking jsonb;
begin
  perform public.assert_owner();
  perform pg_advisory_xact_lock(hashtextextended('trash-restore:' || coalesce(p_trash::text, ''), 0));
  select * into v_item from public.trash_items where id = p_trash;
  if not found then return jsonb_build_object('restored', false, 'already', true); end if;
  select coalesce(jsonb_agg(distinct jsonb_build_object('trash_id', i.id, 'label', i.label, 'kind', i.kind)), '[]') into v_blocking
    from jsonb_to_recordset(v_item.parents) p (t text, id uuid)
    join public.trash_rows r on r.row_table = p.t and r.row_id = p.id
    join public.trash_items i on i.id = r.trash_id
   where i.id <> v_item.id;
  if jsonb_array_length(v_blocking) > 0 then
    if not p_with_parent then
      return jsonb_build_object('restored', false, 'needs_parent', v_blocking -> 0, 'parents', v_blocking,
                                'label', v_item.label, 'kind', v_item.kind);
    end if;
    for v_parent in select (x ->> 'trash_id')::uuid as id from jsonb_array_elements(v_blocking) x loop
      perform public.trash_restore(v_parent.id, true);
    end loop;
  end if;
  delete from public.trash_items where id = v_item.id;
  return jsonb_build_object('restored', true, 'trash_id', v_item.id, 'label', v_item.label, 'kind', v_item.kind,
                            'row_table', v_item.row_table, 'row_id', v_item.row_id);
end; $$;

-- ---------------------------------------------------------------------------
-- Purge (droits d'administration : l'élément est invisible pour l'API)
-- ---------------------------------------------------------------------------

-- Supprime des lignes et tout ce qui les référence sans suppression en cascade (restrict / no action).
-- Les fichiers des fiches sont mis en file d'attente pour être retirés du stockage.
create or replace function trash_private.delete_rows(p_table text, p_ids uuid[])
returns void language plpgsql set search_path = '' as $$
declare
  v_rel regclass := to_regclass('public.' || p_table);
  fk record; v_child uuid[]; v_has_id boolean;
begin
  if v_rel is null or p_ids is null or cardinality(p_ids) = 0 then return; end if;
  if p_table = 'company_files' then
    insert into public.trash_file_queue (path) select f.storage_path from public.company_files f where f.id = any (p_ids) on conflict do nothing;
  end if;
  if p_table = 'finance_missions' then
    -- une vente qui reste garde sa fiche, sans le revenu purgé (garde-fou de suppression des revenus vendus)
    update public.sales set mission_id = null where mission_id = any (p_ids);
  end if;
  for fk in
    select c.conrelid::regclass::text as child_rel, cl.relname as child, a.attname as col, c.confdeltype as del
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = v_rel and cardinality(c.conkey) = 1
       and cl.relnamespace = 'public'::regnamespace
       and (c.confdeltype in ('r', 'a') or (c.confdeltype = 'c' and cl.relname = 'company_files'))
  loop
    select exists (select 1 from pg_attribute where attrelid = fk.child_rel::regclass and attname = 'id' and atttypid = 'uuid'::regtype and not attisdropped)
      into v_has_id;
    if v_has_id then
      execute format('select array_agg(id) from %s where %I = any ($1) and not (%L = %L and id = any ($1))', fk.child_rel, fk.col, fk.child, p_table)
        into v_child using p_ids;
      perform trash_private.delete_rows(fk.child, v_child);
    else
      execute format('delete from %s where %I = any ($1)', fk.child_rel, fk.col) using p_ids;
    end if;
  end loop;
  execute format('delete from %s where id = any ($1)', v_rel) using p_ids;
end; $$;

-- Retire les éléments dont la ligne principale n'existe plus (purgée avec un parent).
create or replace function trash_private.cleanup()
returns void language plpgsql set search_path = '' as $$
declare t text;
begin
  for t in select distinct row_table from public.trash_items loop
    if to_regclass('public.' || t) is not null then
      execute format('delete from public.trash_items i where i.row_table = %L and not exists (select 1 from public.%I x where x.id = i.row_id)', t, t);
    end if;
  end loop;
  delete from public.trash_rows r where not exists (select 1 from public.trash_items i where i.id = r.trash_id);
end; $$;

create or replace function trash_private.purge_item(p_trash uuid)
returns boolean language plpgsql set search_path = '' as $$
declare v_item public.trash_items; t record;
begin
  select * into v_item from public.trash_items where id = p_trash for update;
  if not found then return false; end if;
  perform trash_private.delete_rows(v_item.row_table, array[v_item.row_id]);
  for t in select r.row_table, array_agg(r.row_id) as ids from public.trash_rows r
            where r.trash_id = p_trash and r.row_table <> v_item.row_table group by r.row_table loop
    perform trash_private.delete_rows(t.row_table, t.ids);
  end loop;
  -- lignes de la même table que la racine (ex. avoirs d'une facture)
  perform trash_private.delete_rows(v_item.row_table,
    array(select r.row_id from public.trash_rows r where r.trash_id = p_trash and r.row_table = v_item.row_table));
  delete from public.trash_items where id = p_trash;
  perform trash_private.cleanup();
  return true;
end; $$;

-- « Supprimer définitivement » (propriétaire, depuis l'application uniquement : jamais par Claude).
-- Renvoie les fichiers à retirer du stockage (l'application les retire avec la session du propriétaire).
create or replace function public.trash_purge(p_trash uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_done boolean;
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then
    raise exception 'La suppression définitive se fait depuis la Corbeille de l''application' using errcode = '42501';
  end if;
  v_done := trash_private.purge_item(p_trash);
  return jsonb_build_object('purged', v_done,
    'files', coalesce((select jsonb_agg(q.path order by q.queued_at) from public.trash_file_queue q), '[]'));
end; $$;

-- Fichiers retirés (ou déjà absents) : sortis de la file. Un échec est noté pour le prochain passage.
create or replace function public.trash_files_done(p_paths text[], p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  if p_error is null then
    delete from public.trash_file_queue where path = any (p_paths);
  else
    update public.trash_file_queue set attempts = attempts + 1, last_error = left(p_error, 500) where path = any (p_paths);
  end if;
end; $$;

-- Purge automatique (tâche planifiée, clé serveur) : éléments arrivés à échéance, un par un ; un échec est noté
-- sur l'élément et n'empêche pas les suivants. Les fichiers en attente reçoivent une autorisation de suppression
-- de 10 minutes (même mécanisme que le portail) pour être retirés du stockage par la tâche.
create or replace function public.trash_purge_due(p_server_key text, p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v record; v_ok integer := 0; v_ko integer := 0; v_files jsonb;
begin
  perform appt_private.assert_server(p_server_key);
  for v in select id from public.trash_items where purge_after <= now()
            order by purge_after limit greatest(1, least(coalesce(p_limit, 50), 200)) loop
    begin
      if trash_private.purge_item(v.id) then v_ok := v_ok + 1; end if;
    exception when others then
      v_ko := v_ko + 1;
      update public.trash_items set purge_attempts = purge_attempts + 1, purge_error = left(sqlerrm, 500) where id = v.id;
    end;
  end loop;
  select coalesce(jsonb_agg(q.path order by q.queued_at), '[]') into v_files from (select path, queued_at from public.trash_file_queue order by queued_at limit 200) q;
  insert into public.portal_storage_grants (object_name, action, expires_at)
  select f #>> '{}', a.action, now() + interval '10 minutes' from jsonb_array_elements(v_files) f cross join (values ('read'), ('delete')) a (action);
  return jsonb_build_object('purged', v_ok, 'failed', v_ko, 'files', v_files);
end; $$;

create or replace function public.trash_files_done_server(p_server_key text, p_paths text[], p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.assert_server(p_server_key);
  if p_error is null then
    delete from public.trash_file_queue where path = any (p_paths);
    delete from public.portal_storage_grants where object_name = any (p_paths);
  else
    update public.trash_file_queue set attempts = attempts + 1, last_error = left(p_error, 500) where path = any (p_paths);
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- Droits : propriétaire connecté (application et Claude) ; purge planifiée par clé serveur. Jamais le portail.
-- ---------------------------------------------------------------------------
revoke all on function public.in_trash(text, uuid), public.trash_preview(text, uuid), public.trash_put(text, uuid),
  public.trash_restore(uuid, boolean), public.trash_purge(uuid), public.trash_files_done(text[], text) from public, anon;
grant execute on function public.in_trash(text, uuid), public.trash_preview(text, uuid), public.trash_put(text, uuid),
  public.trash_restore(uuid, boolean), public.trash_purge(uuid), public.trash_files_done(text[], text) to authenticated;
revoke all on function public.trash_purge_due(text, integer), public.trash_files_done_server(text, text[], text) from public, authenticated;
grant execute on function public.trash_purge_due(text, integer), public.trash_files_done_server(text, text[], text) to anon;
revoke all on all functions in schema trash_private from public, anon, authenticated;
grant execute on function trash_private.kind_table(text), trash_private.describe(text, uuid), trash_private.collect(text, uuid),
  trash_private.summary(jsonb, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Passage planifié « corbeille » (purge des éléments arrivés à 30 jours), suivi comme les autres tâches.
-- La liste autorisée est complétée sans retirer une tâche ajoutée entre-temps par une autre migration.
-- ---------------------------------------------------------------------------
do $$
declare v text;
begin
  select pg_get_constraintdef(oid) into v from pg_constraint
   where conrelid = 'public.scheduled_jobs'::regclass and conname = 'scheduled_jobs_job_check';
  if v is not null and v not like '%''corbeille''%' and v like '%ARRAY[%' then
    alter table public.scheduled_jobs drop constraint scheduled_jobs_job_check;
    execute 'alter table public.scheduled_jobs add constraint scheduled_jobs_job_check ' || replace(v, 'ARRAY[', 'ARRAY[''corbeille''::text, ');
  end if;
end $$;
