-- Productivité › To do list : tâches simples, classées par urgence, reliées au plus à une fiche. Migration additive.
--  * Nouvelle table todo_list_items, sans lien avec les tâches existantes (tasks, project_tasks, relances) : aucune
--    reprise de données, aucune table existante modifiée.
--  * Urgence imposée par la base : 'urgent', 'moyen' (par défaut), 'pas_urgent'.
--  * Création sans doublon : l'application fournit l'identifiant ; un double clic ou une double validation
--    renvoie la même tâche (todo_list_create).
--  * Fiche liée : une au plus (company_id), jamais une fiche absorbée par une fusion ni une fiche à la corbeille.
--    Fusion (Doublons) : le lien suit la fiche conservée. Fiche archivée ou à la corbeille : la tâche reste, avec
--    son lien. Fiche purgée de la corbeille : le lien se vide (on delete set null), la tâche reste.
--  * Suppression : par la Corbeille (type 'todo_list_item'), restaurable 30 jours.
--  * Réservé au propriétaire dans l'application : ni le portail client (anon), ni un autre compte, ni Claude.
--
-- Corbeille : les types d'éléments sont désormais inscrits dans une table (trash_private.kinds) au lieu d'une
-- liste écrite en dur. Les types déjà présents, y compris ceux qu'une autre branche aurait ajoutés avant celle-ci,
-- y sont recopiés depuis l'état actuel : rien n'est perdu, quel que soit l'ordre des fusions.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.todo_list_items (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  urgency text not null default 'moyen' check (urgency in ('urgent', 'moyen', 'pas_urgent')),
  company_id uuid references public.companies (id) on delete set null,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index todo_list_items_open_idx on public.todo_list_items (created_at desc) where done_at is null;
create index todo_list_items_company_idx on public.todo_list_items (company_id) where company_id is not null;
create trigger set_updated_at before update on public.todo_list_items for each row execute function public.tg_set_updated_at();

alter table public.todo_list_items enable row level security;
create policy owner_all on public.todo_list_items for all to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.todo_list_items from anon;

-- Fiche liée : visible par l'appelant (donc ni à la corbeille ni d'un autre compte) et non absorbée par une fusion.
-- Contrôlée seulement quand le lien change : la fusion et la purge le déplacent ou le vident sans repasser ici.
create or replace function public.tg_todo_list_company_check()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.company_id is not null and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id)
     and pg_trigger_depth() = 1
     and not exists (select 1 from public.companies c where c.id = new.company_id and c.merged_into_id is null) then
    raise exception 'Fiche introuvable : choisissez une autre fiche.' using errcode = 'P0002';
  end if;
  return new;
end; $$;
create trigger todo_list_company_check before insert or update of company_id on public.todo_list_items
  for each row execute function public.tg_todo_list_company_check();

-- Une fusion de fiches emporte les tâches vers la fiche conservée (même principe que le suivi du temps).
create or replace function public.tg_todo_list_follow_merge()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.todo_list_items set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end; $$;
create trigger todo_list_follow_merge after update of merged_into_id on public.companies
  for each row execute function public.tg_todo_list_follow_merge();

-- ---------------------------------------------------------------------------
-- Création sans doublon
-- ---------------------------------------------------------------------------
-- p_id : identifiant choisi par l'application au moment de la saisie. Le même identifiant renvoie la tâche déjà
-- créée, sans rien réécrire (double clic, double validation, « Réessayer » après une coupure).
create or replace function public.todo_list_create(p_id uuid, p_title text, p_urgency text default 'moyen', p_company uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare r public.todo_list_items;
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then raise exception 'To do list réservée à l''application' using errcode = '42501'; end if;
  if p_id is null then raise exception 'Identifiant manquant' using errcode = '22023'; end if;
  insert into public.todo_list_items (id, title, urgency, company_id)
  values (p_id, btrim(coalesce(p_title, '')), coalesce(p_urgency, 'moyen'), p_company)
  on conflict (id) do nothing
  returning * into r;
  if r.id is null then
    select * into r from public.todo_list_items where id = p_id;
    if r.id is null then raise exception 'Identifiant déjà utilisé' using errcode = '23505'; end if;
  end if;
  return to_jsonb(r);
end; $$;
revoke all on function public.todo_list_create(uuid, text, text, uuid) from public, anon;
grant execute on function public.todo_list_create(uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Corbeille : registre des types, puis type 'todo_list_item'
-- ---------------------------------------------------------------------------
create table if not exists trash_private.kinds (
  kind text primary key check (kind ~ '^[a-z][a-z_]{0,40}$'),
  row_table text not null
);
revoke all on trash_private.kinds from public, anon;
grant select on trash_private.kinds to authenticated;

do $$
declare v_def text; k text; t text;
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c where c.conrelid = 'public.trash_items'::regclass and c.conname = 'trash_items_kind_check';
  if v_def is not null then
    for k in select distinct (regexp_matches(v_def, '''([a-z_]+)''', 'g'))[1] loop
      t := trash_private.kind_table(k);
      if t is not null then insert into trash_private.kinds (kind, row_table) values (k, t) on conflict do nothing; end if;
    end loop;
  end if;
end $$;
insert into trash_private.kinds (kind, row_table) values ('todo_list_item', 'todo_list_items') on conflict do nothing;

-- Table d'un type d'élément (null : type inconnu). Redéfinie entièrement : lit le registre.
create or replace function trash_private.kind_table(p_kind text)
returns text language sql stable set search_path = '' as $$
  select k.row_table from trash_private.kinds k where k.kind = p_kind;
$$;

alter table public.trash_items drop constraint if exists trash_items_kind_check;
alter table public.trash_items add constraint trash_items_kind_fkey foreign key (kind) references trash_private.kinds (kind);

select trash_private.hide('todo_list_items', array['id:todo_list_items']);

create or replace function trash_private.describe_todo_list_item(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', t.title,
    'context', 'To do list' || coalesce(' · ' || c.name, ''),
    'parents', '[]'::jsonb,
    'warnings', '[]'::jsonb)
    from public.todo_list_items t left join public.companies c on c.id = t.company_id where t.id = p_id;
$$;
create or replace function trash_private.collect_todo_list_item(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'todo_list_items', id from public.todo_list_items where id = p_id;
$$;
revoke all on function trash_private.describe_todo_list_item(uuid), trash_private.collect_todo_list_item(uuid) from public, anon;
grant execute on function trash_private.describe_todo_list_item(uuid), trash_private.collect_todo_list_item(uuid) to authenticated;
