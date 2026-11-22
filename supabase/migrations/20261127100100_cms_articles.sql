-- CMS (lot 1) : contenus du site celygrowth.com, dont le CRM est la source de vérité. Migration additive.
--  * Une seule table pour tous les contenus (cms_entries), distingués par « type ». Seuls les articles existent
--    aujourd'hui ; un futur type (étude de cas, témoignage, FAQ) s'ajoute au registre cms_private.types et range
--    ses champs propres dans « extra » : ni nouvelle table, ni refonte des accès.
--  * Statuts : draft (Brouillon), scheduled (Programmé), published (Publié), unpublished (Dépublié).
--    Visible sur le site si et seulement si : programmé ou publié, et date de publication passée
--    (cms_private.is_visible). La visibilité est calculée à la lecture : elle ne dépend d'aucun passage planifié.
--  * Slug unique par type ; un slug changé sur un article déjà publié une fois devient une redirection 301
--    (cms_redirects), sans chaîne : toutes les anciennes adresses visent l'article, jamais un ancien slug.
--  * Temps de lecture et date de mise à jour calculés par la base.
--  * Écriture réservée au propriétaire dans l'application (ni un autre compte, ni Claude, ni le portail).
--  * Corbeille : type 'cms_entry' ; un article visible ou programmé doit d'abord être dépublié.

create schema if not exists cms_private;
revoke all on schema cms_private from public, anon;
grant usage on schema cms_private to authenticated;

-- ---------------------------------------------------------------------------
-- Registre des types de contenus
-- ---------------------------------------------------------------------------
create table if not exists cms_private.types (
  type text primary key check (type ~ '^[a-z][a-z_]{0,30}$'),
  label text not null
);
revoke all on cms_private.types from public, anon;
grant select on cms_private.types to authenticated;
insert into cms_private.types (type, label) values ('article', 'Article') on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Contenus
-- ---------------------------------------------------------------------------
create table public.cms_entries (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'article' references cms_private.types (type),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  slug text not null check (char_length(slug) between 1 and 120 and slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  excerpt text check (char_length(excerpt) <= 1000),
  body_md text not null default '' check (char_length(body_md) <= 400000),
  cover_image_url text check (char_length(cover_image_url) <= 1000 and cover_image_url ~ '^https?://'),
  cover_alt text check (char_length(cover_alt) <= 300),
  category text check (char_length(category) <= 100),
  tags text[] not null default '{}' check (cardinality(tags) <= 30),
  author text check (char_length(author) <= 120),
  focus_keyword text check (char_length(focus_keyword) <= 120),
  secondary_keywords text[] not null default '{}' check (cardinality(secondary_keywords) <= 30),
  seo_title text check (char_length(seo_title) <= 200),
  seo_description text check (char_length(seo_description) <= 400),
  og_title text check (char_length(og_title) <= 200),
  og_image_url text check (char_length(og_image_url) <= 1000 and og_image_url ~ '^https?://'),
  canonical_url text check (char_length(canonical_url) <= 1000 and canonical_url ~ '^https?://'),
  noindex boolean not null default false,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'published', 'unpublished')),
  publish_at timestamptz,
  first_published_at timestamptz,
  content_updated_at timestamptz not null default now(),
  reading_minutes integer not null default 1,
  extra jsonb not null default '{}' check (jsonb_typeof(extra) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cms_entries_slug_key unique (type, slug),
  constraint cms_entries_date_check check (status in ('draft', 'unpublished') or publish_at is not null)
);
create index cms_entries_publish_idx on public.cms_entries (type, publish_at desc) where status in ('scheduled', 'published');

-- Anciennes adresses d'un contenu (redirection 301 vers son slug actuel)
create table public.cms_redirects (
  type text not null references cms_private.types (type),
  from_slug text not null check (from_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  entry_id uuid not null references public.cms_entries (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (type, from_slug)
);
create index cms_redirects_entry_idx on public.cms_redirects (entry_id);

-- Visible sur le site : programmé ou publié, et date passée. Seule règle, utilisée partout.
create or replace function cms_private.is_visible(p_status text, p_publish_at timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select p_status in ('scheduled', 'published') and p_publish_at is not null and p_publish_at <= now();
$$;

-- Temps de lecture : 200 mots par minute, une minute au moins.
create or replace function cms_private.reading_minutes(p_md text)
returns integer language sql immutable set search_path = '' as $$
  select greatest(1, ceil(coalesce(array_length(regexp_split_to_array(nullif(btrim(coalesce(p_md, '')), ''), '\s+'), 1), 0) / 200.0)::int);
$$;

create or replace function cms_private.tg_entries_before()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.title := btrim(new.title);
  new.tags := coalesce(array(select distinct btrim(t) from unnest(new.tags) t where btrim(t) <> ''), '{}');
  new.secondary_keywords := coalesce(array(select distinct btrim(t) from unnest(new.secondary_keywords) t where btrim(t) <> ''), '{}');
  new.reading_minutes := cms_private.reading_minutes(new.body_md);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.content_updated_at := now();
  elsif (new.title, new.slug, new.excerpt, new.body_md, new.cover_image_url, new.cover_alt, new.category, new.tags, new.author,
         new.seo_title, new.seo_description, new.og_title, new.og_image_url, new.canonical_url, new.noindex, new.extra)
        is distinct from
        (old.title, old.slug, old.excerpt, old.body_md, old.cover_image_url, old.cover_alt, old.category, old.tags, old.author,
         old.seo_title, old.seo_description, old.og_title, old.og_image_url, old.canonical_url, old.noindex, old.extra) then
    new.content_updated_at := now();
  else
    new.content_updated_at := old.content_updated_at;
  end if;
  if new.status = 'published' and new.publish_at is null then new.publish_at := date_trunc('second', now()); end if;
  if new.first_published_at is null and cms_private.is_visible(new.status, new.publish_at) then
    new.first_published_at := new.publish_at;
  end if;
  -- un slug qui redirige déjà vers un AUTRE contenu reste réservé (l'ancienne adresse ne doit pas changer de cible)
  if exists (select 1 from public.cms_redirects r where r.type = new.type and r.from_slug = new.slug and r.entry_id <> new.id) then
    raise exception 'Ce slug est une ancienne adresse d''un autre contenu : choisissez-en un autre' using errcode = '23505';
  end if;
  return new;
end; $$;
create trigger cms_entries_before before insert or update on public.cms_entries
  for each row execute function cms_private.tg_entries_before();

-- Slug changé sur un contenu déjà publié une fois : l'ancien devient une redirection ; revenir à un ancien slug
-- retire la redirection correspondante. Sécurité : la fonction écrit dans cms_redirects pour le propriétaire.
create or replace function cms_private.tg_entries_slug()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.slug is distinct from old.slug or new.type is distinct from old.type then
    delete from public.cms_redirects where type = new.type and from_slug = new.slug and entry_id = new.id;
    if old.first_published_at is not null or cms_private.is_visible(old.status, old.publish_at) then
      insert into public.cms_redirects (type, from_slug, entry_id) values (old.type, old.slug, new.id)
      on conflict (type, from_slug) do update set entry_id = excluded.entry_id, created_at = now();
    end if;
  end if;
  return null;
end; $$;
revoke all on function cms_private.tg_entries_slug() from public, anon, authenticated;
create trigger cms_entries_slug after update of slug, type on public.cms_entries
  for each row execute function cms_private.tg_entries_slug();

-- ---------------------------------------------------------------------------
-- Droits : lecture et écriture réservées au propriétaire dans l'application
-- ---------------------------------------------------------------------------
alter table public.cms_entries enable row level security;
alter table public.cms_redirects enable row level security;
revoke all on public.cms_entries, public.cms_redirects from anon;
create policy cms_entries_owner_read on public.cms_entries for select to authenticated using ((select public.is_app_owner()));
create policy cms_entries_owner_write on public.cms_entries for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_entries_owner_update on public.cms_entries for update to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_entries_owner_delete on public.cms_entries for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_redirects_owner_read on public.cms_redirects for select to authenticated using ((select public.is_app_owner()));
create policy cms_redirects_owner_delete on public.cms_redirects for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');

-- ---------------------------------------------------------------------------
-- Changements de statut (le propriétaire, dans l'application)
-- ---------------------------------------------------------------------------
create or replace function cms_private.assert_writer()
returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then raise exception 'Accès refusé' using errcode = '42501'; end if;
end; $$;

-- Publier maintenant. Un second appel (double clic) ne change rien et le dit (already = true).
create or replace function public.cms_publish_now(p_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare r public.cms_entries;
begin
  perform cms_private.assert_writer();
  select * into r from public.cms_entries where id = p_id for update;
  if not found then raise exception 'Contenu introuvable' using errcode = 'P0002'; end if;
  if r.status = 'published' and cms_private.is_visible(r.status, r.publish_at) then
    return jsonb_build_object('already', true, 'entry', to_jsonb(r));
  end if;
  update public.cms_entries set status = 'published',
    publish_at = case when publish_at is null or publish_at > now() or status in ('draft', 'unpublished') then date_trunc('second', now()) else publish_at end
   where id = p_id returning * into r;
  return jsonb_build_object('already', false, 'entry', to_jsonb(r));
end; $$;

-- Programmer. Une date passée est refusée (code 'past_date') sauf confirmation explicite : publication immédiate.
create or replace function public.cms_schedule(p_id uuid, p_at timestamptz, p_confirm_now boolean default false)
returns jsonb language plpgsql set search_path = '' as $$
declare r public.cms_entries;
begin
  perform cms_private.assert_writer();
  if p_at is null then raise exception 'Date de publication manquante' using errcode = '22023'; end if;
  if p_at <= now() then
    if not coalesce(p_confirm_now, false) then
      raise exception 'past_date' using errcode = 'P0001', hint = 'La date choisie est passée : confirmer une publication immédiate.';
    end if;
    return public.cms_publish_now(p_id);
  end if;
  update public.cms_entries set status = 'scheduled', publish_at = p_at where id = p_id returning * into r;
  if not found then raise exception 'Contenu introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('already', false, 'entry', to_jsonb(r));
end; $$;

-- Dépublier (disparaît du site et du sitemap) ou repasser en brouillon (annule une programmation).
create or replace function public.cms_set_status(p_id uuid, p_status text)
returns jsonb language plpgsql set search_path = '' as $$
declare r public.cms_entries;
begin
  perform cms_private.assert_writer();
  if p_status not in ('draft', 'unpublished') then raise exception 'Statut non autorisé ici' using errcode = '22023'; end if;
  update public.cms_entries set status = p_status where id = p_id returning * into r;
  if not found then raise exception 'Contenu introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('already', false, 'entry', to_jsonb(r));
end; $$;

-- Programmé dont la date est passée → Publié (passage planifié ; le site, lui, le voit déjà dès la date).
create or replace function cms_private.promote_due()
returns integer language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update public.cms_entries set status = 'published' where status = 'scheduled' and publish_at <= now()
     and not public.in_trash('cms_entries', id);
  get diagnostics n = row_count;
  return n;
end; $$;
revoke all on function cms_private.promote_due() from public, anon, authenticated;

create or replace function public.cms_promote_due()
returns integer language plpgsql set search_path = '' as $$
declare n integer;
begin
  perform cms_private.assert_writer();
  update public.cms_entries set status = 'published' where status = 'scheduled' and publish_at <= now();
  get diagnostics n = row_count;
  return n;
end; $$;

create or replace function public.cms_promote_due_server(p_server_key text)
returns integer language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.assert_server(p_server_key);
  return cms_private.promote_due();
end; $$;

revoke all on function public.cms_publish_now(uuid), public.cms_schedule(uuid, timestamptz, boolean),
  public.cms_set_status(uuid, text), public.cms_promote_due() from public, anon;
grant execute on function public.cms_publish_now(uuid), public.cms_schedule(uuid, timestamptz, boolean),
  public.cms_set_status(uuid, text), public.cms_promote_due() to authenticated;
revoke all on function public.cms_promote_due_server(text) from public;
grant execute on function public.cms_promote_due_server(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Corbeille : type 'cms_entry' (ses redirections partent avec lui à la purge)
-- ---------------------------------------------------------------------------
insert into trash_private.kinds (kind, row_table) values ('cms_entry', 'cms_entries') on conflict do nothing;
select trash_private.hide('cms_entries', array['id:cms_entries']);
select trash_private.hide('cms_redirects', array['entry_id:cms_entries']);

create or replace function trash_private.describe_cms_entry(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', e.title,
    'context', 'CMS · ' || coalesce(t.label, e.type) || ' · /' || e.slug,
    'parents', '[]'::jsonb,
    'warnings', case when e.status in ('scheduled', 'published')
      then jsonb_build_array('Cet article est publié ou programmé : dépubliez-le d''abord.') else '[]'::jsonb end)
    from public.cms_entries e left join cms_private.types t on t.type = e.type where e.id = p_id;
$$;
create or replace function trash_private.collect_cms_entry(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'cms_entries', id from public.cms_entries where id = p_id;
$$;
-- Avant la mise à la corbeille : un article publié ou programmé est refusé (il faut le dépublier d'abord).
create or replace function trash_private.before_cms_entry(p_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.cms_entries where id = p_id and status in ('scheduled', 'published')) then
    raise exception 'Dépubliez d''abord cet article : un article publié ou programmé ne part pas à la corbeille.' using errcode = 'P0001';
  end if;
  return '{}'::jsonb;
end; $$;
revoke all on function trash_private.describe_cms_entry(uuid), trash_private.collect_cms_entry(uuid), trash_private.before_cms_entry(uuid) from public, anon;
grant execute on function trash_private.describe_cms_entry(uuid), trash_private.collect_cms_entry(uuid), trash_private.before_cms_entry(uuid) to authenticated;

-- Fonctions d'aide appelées avec les droits du propriétaire (les fonctions ne sont plus exécutables par défaut)
grant execute on function cms_private.is_visible(text, timestamptz), cms_private.reading_minutes(text),
  cms_private.assert_writer() to authenticated;
