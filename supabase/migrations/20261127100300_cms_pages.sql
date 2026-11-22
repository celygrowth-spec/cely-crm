-- CMS (lot 3) : réglages SEO des pages du site, identifiées par leur chemin (« / », « /offres »). Migration additive.
--  * Champ vide (null) = le site garde la valeur inscrite dans son code. « Ne pas indexer » a trois états :
--    null (valeur du site), false (indexer), true (ne pas indexer).
--  * site_defaults : valeurs actuelles du code du site, fournies par l'import JSON (format « cely-cms-pages »,
--    voir docs/cms-contrat-site.md) ; affichées comme indications, jamais renvoyées comme réglages.
--  * Import en lot : crée les pages absentes, met à jour libellé et valeurs du site ; ne touche jamais aux réglages
--    saisis dans le CMS et ne supprime aucune page.
--  * Réservé au propriétaire dans l'application.

create table public.cms_pages (
  id uuid primary key default gen_random_uuid(),
  path text not null unique check (char_length(path) <= 300 and (path = '/' or path ~ '^(/[A-Za-z0-9._~%!$&''()*+,;=:@-]+)+$')),
  label text check (char_length(label) <= 200),
  seo_title text check (char_length(seo_title) <= 200),
  seo_description text check (char_length(seo_description) <= 400),
  og_title text check (char_length(og_title) <= 200),
  og_image_url text check (char_length(og_image_url) <= 1000 and og_image_url ~ '^https?://'),
  canonical_url text check (char_length(canonical_url) <= 1000 and canonical_url ~ '^https?://'),
  noindex boolean,
  site_defaults jsonb not null default '{}' check (jsonb_typeof(site_defaults) = 'object' and pg_column_size(site_defaults) <= 8000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function cms_private.tg_pages_before()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.label := nullif(btrim(new.label), '');
  new.seo_title := nullif(btrim(new.seo_title), '');
  new.seo_description := nullif(btrim(new.seo_description), '');
  new.og_title := nullif(btrim(new.og_title), '');
  new.og_image_url := nullif(btrim(new.og_image_url), '');
  new.canonical_url := nullif(btrim(new.canonical_url), '');
  new.updated_at := now();
  return new;
end; $$;
create trigger cms_pages_before before insert or update on public.cms_pages
  for each row execute function cms_private.tg_pages_before();

alter table public.cms_pages enable row level security;
revoke all on public.cms_pages from anon;
create policy cms_pages_owner_read on public.cms_pages for select to authenticated using ((select public.is_app_owner()));
create policy cms_pages_owner_insert on public.cms_pages for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_pages_owner_update on public.cms_pages for update to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_pages_owner_delete on public.cms_pages for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');

-- Import en lot (tout ou rien). p_pages : [{path, label, defaults}] déjà validés par l'application ;
-- la base revérifie le chemin (contrainte) et la taille. Renvoie {created, updated, unchanged}.
create or replace function public.cms_pages_import(p_pages jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare v jsonb; v_created int := 0; v_updated int := 0; v_unchanged int := 0; v_old public.cms_pages;
begin
  perform cms_private.assert_writer();
  if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) > 500 then
    raise exception 'Liste de pages invalide (500 au plus)' using errcode = '22023';
  end if;
  for v in select * from jsonb_array_elements(p_pages) loop
    select * into v_old from public.cms_pages where path = v ->> 'path' for update;
    if not found then
      insert into public.cms_pages (path, label, site_defaults)
      values (v ->> 'path', v ->> 'label', coalesce(nullif(v -> 'defaults', 'null'::jsonb), '{}'));
      v_created := v_created + 1;
    elsif (v_old.label, v_old.site_defaults) is distinct from (nullif(btrim(v ->> 'label'), ''), coalesce(nullif(v -> 'defaults', 'null'::jsonb), '{}')) then
      update public.cms_pages set label = coalesce(nullif(btrim(v ->> 'label'), ''), label),
        site_defaults = coalesce(nullif(v -> 'defaults', 'null'::jsonb), '{}') where id = v_old.id;
      v_updated := v_updated + 1;
    else
      v_unchanged := v_unchanged + 1;
    end if;
  end loop;
  return jsonb_build_object('created', v_created, 'updated', v_updated, 'unchanged', v_unchanged);
end; $$;
revoke all on function public.cms_pages_import(jsonb) from public, anon;
grant execute on function public.cms_pages_import(jsonb) to authenticated;
