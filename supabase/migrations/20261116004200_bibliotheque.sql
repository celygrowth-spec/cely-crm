-- Bibliothèque générale : dossiers et sous-dossiers, fichiers et prompts, réservée au propriétaire.
--
-- La bibliothèque de diagnostic existante devient le dossier système « Bibliothèque diagnostic » :
--   * la table diagnostic_library_files est conservée et étendue (mêmes identifiants, mêmes chemins de
--     stockage, même bucket privé « diagnostic-library ») : rien n'est copié, rien n'est perdu ;
--   * toutes ses lignes actuelles sont rangées dans ce dossier ; une ligne insérée sans dossier (ancien
--     code, autre branche) y est rangée aussi ;
--   * le diagnostic lit les fichiers de ce dossier et de ses sous-dossiers ; le reste de la bibliothèque
--     n'est lu par Claude (connecteur MCP) que sur demande, en lecture seule.
--
-- Migration additive : aucune colonne retirée, aucune ligne supprimée, aucun nom modifié (les doublons
-- de nom déjà présents sont conservés tels quels). Le code déjà en ligne continue de fonctionner pendant
-- et après son application.
-- Droits : lecture pour le propriétaire (application et Claude), écritures dans l'application seulement.
-- Aucun accès anonyme ni portail : aucune fonction portal_* n'y touche.

-- ---------------------------------------------------------------------------
-- Dossiers
-- ---------------------------------------------------------------------------
create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references public.library_folders (id),
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name)),
  -- 'diagnostic' : dossier système, toujours présent, à la racine, sous ce nom
  system_key text unique check (system_key in ('diagnostic')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (system_key is null or parent_id is null)
);
-- deux dossiers du même nom au même endroit : refusé (casse ignorée)
create unique index if not exists library_folders_name_uidx
  on public.library_folders (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
create index if not exists library_folders_parent_idx on public.library_folders (parent_id);

drop trigger if exists set_updated_at on public.library_folders;
create trigger set_updated_at before update on public.library_folders
  for each row execute function public.tg_set_updated_at();

insert into public.library_folders (name, system_key)
select 'Bibliothèque diagnostic', 'diagnostic'
where not exists (select 1 from public.library_folders where system_key = 'diagnostic');

create or replace function public.library_diagnostic_folder()
returns uuid language sql stable set search_path = '' as $$
  select id from public.library_folders where system_key = 'diagnostic';
$$;

-- Le dossier système ne se renomme pas, ne se déplace pas et ne se supprime pas ; un dossier ne peut pas
-- être rangé dans lui-même ni dans un de ses sous-dossiers (vérifié ici, quel que soit le chemin d'écriture).
create or replace function public.tg_library_folder_guard()
returns trigger language plpgsql set search_path = '' as $$
declare v_cursor uuid; v_depth int := 0;
begin
  if tg_op = 'DELETE' then
    if old.system_key is not null then
      raise exception 'Le dossier « % » est permanent : il ne se supprime pas', old.name using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.system_key is not null
     and (new.name is distinct from old.name or new.parent_id is distinct from old.parent_id or new.system_key is distinct from old.system_key) then
    raise exception 'Le dossier « % » est permanent : il ne se renomme pas et ne se déplace pas', old.name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.system_key is distinct from old.system_key then
    raise exception 'Dossier système non modifiable' using errcode = '42501';
  end if;
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    -- un seul déplacement de dossier à la fois : deux déplacements croisés ne peuvent pas créer de boucle
    perform pg_advisory_xact_lock(hashtext('cely_library_folder_tree'));
    v_cursor := new.parent_id;
    while v_cursor is not null loop
      if v_cursor = new.id then
        raise exception 'Un dossier ne peut pas être rangé dans lui-même ni dans un de ses sous-dossiers' using errcode = '22023';
      end if;
      v_depth := v_depth + 1;
      if v_depth > 30 then raise exception 'Arborescence trop profonde (30 niveaux au maximum)' using errcode = '22023'; end if;
      select parent_id into v_cursor from public.library_folders where id = v_cursor;
    end loop;
  end if;
  return new;
end; $$;
drop trigger if exists library_folder_guard on public.library_folders;
create trigger library_folder_guard before insert or update or delete on public.library_folders
  for each row execute function public.tg_library_folder_guard();

-- Dossier et tous ses sous-dossiers
create or replace function public.library_subtree(p_folder uuid)
returns setof uuid language sql stable set search_path = '' as $$
  with recursive t(id) as (
    select id from public.library_folders where id = p_folder
    union
    select f.id from public.library_folders f join t on f.parent_id = t.id
  )
  select id from t;
$$;

-- ---------------------------------------------------------------------------
-- Éléments : la table de la bibliothèque de diagnostic, étendue aux prompts et aux dossiers
-- ---------------------------------------------------------------------------
alter table public.diagnostic_library_files
  add column if not exists folder_id uuid references public.library_folders (id),
  add column if not exists kind text not null default 'file' check (kind in ('file', 'prompt')),
  add column if not exists content text check (content is null or char_length(content) <= 200000),
  add column if not exists updated_at timestamptz not null default now();

-- un prompt n'a ni objet de stockage ni taille de fichier
alter table public.diagnostic_library_files alter column storage_path drop not null;
alter table public.diagnostic_library_files drop constraint if exists diagnostic_library_files_size_bytes_check;
alter table public.diagnostic_library_files drop constraint if exists diagnostic_library_files_kind_shape;
alter table public.diagnostic_library_files add constraint diagnostic_library_files_kind_shape check (
  (kind = 'file' and storage_path is not null and size_bytes > 0 and content is null)
  or (kind = 'prompt' and storage_path is null and content is not null and size_bytes >= 0)
);

-- Rangement des documents existants (diagnostic en cours compris : identifiants et chemins inchangés)
update public.diagnostic_library_files set folder_id = public.library_diagnostic_folder() where folder_id is null;

-- Une ligne insérée sans dossier (ancien écran de diagnostic, autre branche) va dans le dossier diagnostic
create or replace function public.tg_library_item_defaults()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.folder_id is null then new.folder_id := public.library_diagnostic_folder(); end if;
  return new;
end; $$;
drop trigger if exists library_item_defaults on public.diagnostic_library_files;
create trigger library_item_defaults before insert on public.diagnostic_library_files
  for each row execute function public.tg_library_item_defaults();
alter table public.diagnostic_library_files alter column folder_id set not null;
create index if not exists diagnostic_library_files_folder_idx on public.diagnostic_library_files (folder_id, display_name);

drop trigger if exists set_updated_at on public.diagnostic_library_files;
create trigger set_updated_at before update on public.diagnostic_library_files
  for each row execute function public.tg_set_updated_at();

-- Deux éléments du même nom dans un dossier : refusé pour toute nouvelle écriture (les doublons déjà
-- présents avant cette migration restent intacts). Le dépôt de fichiers choisit lui-même un nom libre.
create or replace function public.tg_library_item_unique_name()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.display_name = old.display_name and new.folder_id = old.folder_id then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('cely_library_folder:' || new.folder_id::text, 0));
  if exists (select 1 from public.diagnostic_library_files
              where folder_id = new.folder_id and id <> new.id and lower(display_name) = lower(new.display_name)) then
    raise exception 'Un élément s''appelle déjà « % » dans ce dossier', new.display_name using errcode = '22023';
  end if;
  return new;
end; $$;
drop trigger if exists library_item_unique_name on public.diagnostic_library_files;
create trigger library_item_unique_name before insert or update of display_name, folder_id on public.diagnostic_library_files
  for each row execute function public.tg_library_item_unique_name();

-- ---------------------------------------------------------------------------
-- Droits (base) : propriétaire seulement ; Claude lit, n'écrit pas
-- ---------------------------------------------------------------------------
alter table public.library_folders enable row level security;
revoke all on public.library_folders from public, anon, authenticated;
grant select, insert, update, delete on public.library_folders to authenticated;
drop policy if exists owner_select on public.library_folders;
drop policy if exists owner_insert on public.library_folders;
drop policy if exists owner_update on public.library_folders;
drop policy if exists owner_delete on public.library_folders;
create policy owner_select on public.library_folders for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.library_folders for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy owner_update on public.library_folders for update to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user') with check ((select public.is_app_owner()));
create policy owner_delete on public.library_folders for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
-- diagnostic_library_files : politiques d'origine inchangées (lecture propriétaire, écritures application)

-- ---------------------------------------------------------------------------
-- Actions de l'application (droits de l'appelant : RLS appliquée en plus des contrôles)
-- ---------------------------------------------------------------------------
create or replace function public.library_assert_writer()
returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Modification de la bibliothèque');
end; $$;

create or replace function public.library_clean_name(p_name text, p_max int)
returns text language plpgsql immutable set search_path = '' as $$
declare v text := btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]/\\]+', ' ', 'g'));
begin
  if v = '' then raise exception 'Nom obligatoire' using errcode = '22023'; end if;
  if char_length(v) > p_max then raise exception 'Nom trop long (% caractères au maximum)', p_max using errcode = '22023'; end if;
  return v;
end; $$;

create or replace function public.library_assert_folder(p_folder uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_folder is null or not exists (select 1 from public.library_folders where id = p_folder) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
end; $$;

create or replace function public.library_folder_create(p_parent uuid, p_name text)
returns uuid language plpgsql set search_path = '' as $$
declare v_name text := public.library_clean_name(p_name, 120); v_id uuid;
begin
  perform public.library_assert_writer();
  if p_parent is not null then perform public.library_assert_folder(p_parent); end if;
  if exists (select 1 from public.library_folders where parent_id is not distinct from p_parent and lower(name) = lower(v_name)) then
    raise exception 'Un dossier s''appelle déjà « % » à cet endroit', v_name using errcode = '22023';
  end if;
  insert into public.library_folders (parent_id, name) values (p_parent, v_name) returning id into v_id;
  return v_id;
end; $$;

create or replace function public.library_folder_rename(p_folder uuid, p_name text)
returns void language plpgsql set search_path = '' as $$
declare v_name text := public.library_clean_name(p_name, 120); f public.library_folders;
begin
  perform public.library_assert_writer();
  select * into f from public.library_folders where id = p_folder for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if f.name = v_name then return; end if;
  if exists (select 1 from public.library_folders where id <> f.id and parent_id is not distinct from f.parent_id and lower(name) = lower(v_name)) then
    raise exception 'Un dossier s''appelle déjà « % » à cet endroit', v_name using errcode = '22023';
  end if;
  update public.library_folders set name = v_name where id = f.id;
end; $$;

-- p_parent null : racine de la bibliothèque
create or replace function public.library_folder_move(p_folder uuid, p_parent uuid)
returns void language plpgsql set search_path = '' as $$
declare f public.library_folders;
begin
  perform public.library_assert_writer();
  select * into f from public.library_folders where id = p_folder for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if p_parent is not null then perform public.library_assert_folder(p_parent); end if;
  if f.parent_id is not distinct from p_parent then return; end if;
  if exists (select 1 from public.library_folders where id <> f.id and parent_id is not distinct from p_parent and lower(name) = lower(f.name)) then
    raise exception 'Un dossier s''appelle déjà « % » à cet endroit', f.name using errcode = '22023';
  end if;
  update public.library_folders set parent_id = p_parent where id = f.id; -- boucle refusée par le déclencheur
end; $$;

-- Contenu d'un dossier (sous-dossiers compris) : ce que la confirmation de suppression annonce
create or replace function public.library_folder_counts(p_folder uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'folders', (select greatest(count(*)::int - 1, 0) from public.library_subtree(p_folder)),
    'items', (select count(*)::int from public.diagnostic_library_files where folder_id in (select public.library_subtree(p_folder)) and status = 'ready'));
$$;

-- Suppression définitive (la corbeille n'existe pas encore sur la branche principale). Rien n'est supprimé
-- tant que le nombre d'éléments confirmé ne correspond pas au contenu réel : {"confirm": {...}}.
-- Sinon {"deleted": true, "paths": [...]} : le serveur retire ensuite ces objets du stockage.
create or replace function public.library_folder_delete(p_folder uuid, p_confirmed_items int)
returns jsonb language plpgsql set search_path = '' as $$
declare f public.library_folders; v_counts jsonb; v_paths text[]; v_ids uuid[];
begin
  perform public.library_assert_writer();
  select * into f from public.library_folders where id = p_folder for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if f.system_key is not null then
    raise exception 'Le dossier « % » est permanent : il ne se supprime pas', f.name using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('cely_library_folder_tree'));
  v_counts := public.library_folder_counts(f.id);
  if p_confirmed_items is null or p_confirmed_items <> (v_counts ->> 'items')::int then
    return jsonb_build_object('confirm', v_counts);
  end if;
  v_ids := array(select public.library_subtree(f.id));
  with gone as (delete from public.diagnostic_library_files where folder_id = any (v_ids) returning storage_path)
  select coalesce(array_agg(storage_path) filter (where storage_path is not null), '{}') into v_paths from gone;
  delete from public.library_folders where id = any (v_ids);
  return jsonb_build_object('deleted', true, 'paths', to_jsonb(v_paths), 'counts', v_counts);
end; $$;

-- Dépôt d'un fichier : la ligne est créée « en attente » avec un nom libre dans le dossier
-- (« Devis.pdf », puis « Devis (2).pdf »…). Type et taille validés ici, comme par le bucket.
create or replace function public.library_file_start(p_folder uuid, p_name text, p_mime text, p_size bigint, p_ext text, p_category text default 'other')
returns jsonb language plpgsql set search_path = '' as $$
declare
  v_folder uuid := coalesce(p_folder, public.library_diagnostic_folder());
  v_name text := public.library_clean_name(p_name, 200);
  v_base text; v_ext text := ''; v_try text; v_n int := 1;
  v_id uuid := gen_random_uuid();
  -- mêmes types que le bucket privé « diagnostic-library » (20261109000100_diagnostic.sql)
  v_allowed constant text[] := array[
    'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain', 'text/markdown', 'text/html', 'text/csv'];
begin
  perform public.library_assert_writer();
  perform public.library_assert_folder(v_folder);
  if p_mime is null or not (p_mime = any (v_allowed)) then
    raise exception 'Format non autorisé' using errcode = '22023';
  end if;
  if p_size is null or p_size <= 0 then raise exception 'Ce fichier est vide' using errcode = '22023'; end if;
  if p_size > 26214400 then raise exception 'Fichier trop volumineux (25 Mo maximum)' using errcode = '22023'; end if;
  if p_ext is null or p_ext !~ '^[a-z0-9]{1,10}$' then raise exception 'Extension invalide' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('cely_library_folder:' || v_folder::text, 0));
  if v_name ~ '\.[^. ]{1,10}$' then
    v_ext := substring(v_name from '(\.[^. ]{1,10})$');
    v_base := left(v_name, char_length(v_name) - char_length(v_ext));
  else
    v_base := v_name;
  end if;
  v_try := v_name;
  while exists (select 1 from public.diagnostic_library_files where folder_id = v_folder and lower(display_name) = lower(v_try)) loop
    v_n := v_n + 1;
    v_try := left(v_base, 200 - char_length(v_ext) - 8) || ' (' || v_n || ')' || v_ext;
  end loop;
  insert into public.diagnostic_library_files (id, folder_id, kind, category, display_name, mime_type, size_bytes, storage_path)
  values (v_id, v_folder, 'file', case when p_category in ('example', 'brand', 'guide') then p_category else 'other' end,
          v_try, p_mime, p_size, v_id::text || '.' || p_ext);
  return jsonb_build_object('id', v_id, 'name', v_try, 'path', v_id::text || '.' || p_ext);
end; $$;

create or replace function public.library_prompt_create(p_folder uuid, p_title text, p_content text)
returns uuid language plpgsql set search_path = '' as $$
declare v_id uuid; v_title text := public.library_clean_name(p_title, 200);
begin
  perform public.library_assert_writer();
  perform public.library_assert_folder(p_folder);
  if p_content is null or char_length(p_content) > 200000 then raise exception 'Contenu trop long (200 000 caractères au maximum)' using errcode = '22023'; end if;
  insert into public.diagnostic_library_files (folder_id, kind, category, display_name, mime_type, size_bytes, content, status)
  values (p_folder, 'prompt', 'other', v_title, 'text/plain', octet_length(p_content), p_content, 'ready')
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.library_prompt_update(p_id uuid, p_title text, p_content text)
returns void language plpgsql set search_path = '' as $$
declare v_title text := public.library_clean_name(p_title, 200);
begin
  perform public.library_assert_writer();
  if p_content is null or char_length(p_content) > 200000 then raise exception 'Contenu trop long (200 000 caractères au maximum)' using errcode = '22023'; end if;
  update public.diagnostic_library_files
     set display_name = v_title, content = p_content, size_bytes = octet_length(p_content)
   where id = p_id and kind = 'prompt';
  if not found then raise exception 'Prompt introuvable' using errcode = 'P0002'; end if;
end; $$;

create or replace function public.library_item_rename(p_id uuid, p_name text)
returns void language plpgsql set search_path = '' as $$
declare v_name text := public.library_clean_name(p_name, 200);
begin
  perform public.library_assert_writer();
  update public.diagnostic_library_files set display_name = v_name where id = p_id and status = 'ready';
  if not found then raise exception 'Élément introuvable' using errcode = 'P0002'; end if;
end; $$;

create or replace function public.library_item_move(p_id uuid, p_folder uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.library_assert_writer();
  perform public.library_assert_folder(p_folder);
  update public.diagnostic_library_files set folder_id = p_folder where id = p_id and status = 'ready';
  if not found then raise exception 'Élément introuvable' using errcode = 'P0002'; end if;
end; $$;

-- Ni anonyme ni portail : ces fonctions n'existent que pour le compte connecté (les contrôles internes
-- refusent de toute façon tout autre compte que le propriétaire).
do $$
declare r record;
begin
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('library_diagnostic_folder', 'library_subtree', 'library_assert_writer', 'library_clean_name',
                                'library_assert_folder', 'library_folder_create', 'library_folder_rename', 'library_folder_move',
                                'library_folder_counts', 'library_folder_delete', 'library_file_start', 'library_prompt_create',
                                'library_prompt_update', 'library_item_rename', 'library_item_move',
                                'tg_library_folder_guard', 'tg_library_item_defaults', 'tg_library_item_unique_name') loop
    execute format('revoke execute on function %s from public, anon', r.sig);
    execute format('grant execute on function %s to authenticated', r.sig);
  end loop;
end $$;
