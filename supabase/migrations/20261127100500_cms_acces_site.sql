-- CMS (lot 5) : accès en lecture seule pour le site celygrowth.com. Migration additive.
--  * Appelé uniquement par le serveur du CRM (route /api/site/cms/v1/…), après contrôle de la clé du site
--    (CMS_SITE_API_KEY) ; la base exige en plus la clé serveur (comme les autres fonctions publiques).
--  * Ne renvoie jamais un brouillon, un article programmé dans le futur, un article dépublié ou à la corbeille :
--    seule exception, l'aperçu avec un jeton valide (non expiré, 24 h au plus).
--  * Limite d'abus en base : par empreinte d'adresse et au total, par minute (site_private.rate_ok du Tracking).
--  * Aucune écriture hors du compteur d'abus.

create or replace function cms_private.entry_json(e public.cms_entries, p_full boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'type', e.type, 'slug', e.slug, 'title', e.title, 'excerpt', e.excerpt,
    'cover_image_url', e.cover_image_url, 'cover_alt', e.cover_alt, 'category', e.category, 'author', e.author,
    'seo_title', e.seo_title, 'seo_description', e.seo_description, 'og_title', e.og_title, 'og_image_url', e.og_image_url,
    'canonical_url', e.canonical_url, 'focus_keyword', e.focus_keyword,
    'published_at', e.publish_at, 'first_published_at', e.first_published_at, 'updated_at', e.content_updated_at,
    'reading_minutes', e.reading_minutes,
    'body_md', case when p_full then e.body_md end))
  || jsonb_build_object('tags', to_jsonb(e.tags), 'secondary_keywords', to_jsonb(e.secondary_keywords), 'noindex', e.noindex,
                        'extra', case when p_full then e.extra else '{}'::jsonb end);
$$;

create or replace function cms_private.site_visible(e public.cms_entries)
returns boolean language sql stable set search_path = '' as $$
  select cms_private.is_visible(e.status, e.publish_at) and not public.in_trash('cms_entries', e.id);
$$;

-- Lecture du site. p_what : list | entry | redirects | pages | sitemap | preview. p_rate : empreinte de l'adresse.
create or replace function public.cms_site_read(p_server_key text, p_what text, p_args jsonb default '{}', p_rate text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_type text := coalesce(nullif(p_args ->> 'type', ''), 'article');
  v_limit int; v_offset int; v_e public.cms_entries; v_target public.cms_entries; v_out jsonb;
begin
  perform appt_private.assert_server(p_server_key);
  if not site_private.rate_ok('cms:' || coalesce(p_rate, '?'), 600) or not site_private.rate_ok('cms:all', 3000) then
    return jsonb_build_object('error', 'rate_limited');
  end if;
  if not exists (select 1 from cms_private.types where type = v_type) then return jsonb_build_object('error', 'unknown_type'); end if;

  if p_what = 'list' then
    v_limit := least(greatest(coalesce((p_args ->> 'limit')::int, 20), 1), 100);
    v_offset := least(greatest(coalesce((p_args ->> 'offset')::int, 0), 0), 100000);
    with vis as (
      select e from public.cms_entries e
       where e.type = v_type and cms_private.site_visible(e)
         and (p_args ->> 'category' is null or lower(e.category) = lower(p_args ->> 'category'))
         and (p_args ->> 'tag' is null or exists (select 1 from unnest(e.tags) t where lower(t) = lower(p_args ->> 'tag'))))
    select jsonb_build_object(
      'total', (select count(*) from vis),
      'items', coalesce((select jsonb_agg(cms_private.entry_json(x.e, false) order by (x.e).publish_at desc, (x.e).slug)
                           from (select e from vis order by (e).publish_at desc, (e).slug limit v_limit offset v_offset) x), '[]'))
      into v_out;
    -- prochaine apparition prévue (heure seulement, aucun contenu) : le site peut caler son rafraîchissement dessus
    return v_out || jsonb_build_object('next_change_at', (select min(publish_at) from public.cms_entries
      where type = v_type and status in ('scheduled', 'published') and publish_at > now() and not public.in_trash('cms_entries', id)));

  elsif p_what = 'entry' then
    select * into v_e from public.cms_entries where type = v_type and slug = p_args ->> 'slug';
    if found and cms_private.site_visible(v_e) then return jsonb_build_object('entry', cms_private.entry_json(v_e, true)); end if;
    select t.* into v_target from public.cms_redirects r join public.cms_entries t on t.id = r.entry_id
     where r.type = v_type and r.from_slug = p_args ->> 'slug';
    if found and cms_private.site_visible(v_target) then return jsonb_build_object('redirect', v_target.slug); end if;
    return jsonb_build_object('not_found', true);

  elsif p_what = 'redirects' then
    return jsonb_build_object('redirects', coalesce((
      select jsonb_agg(jsonb_build_object('type', r.type, 'from', r.from_slug, 'to', t.slug) order by r.from_slug)
        from public.cms_redirects r join public.cms_entries t on t.id = r.entry_id
       where r.type = v_type and cms_private.site_visible(t)), '[]'));

  elsif p_what = 'pages' then
    return jsonb_build_object('pages', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('path', p.path, 'seo_title', p.seo_title, 'seo_description', p.seo_description,
               'og_title', p.og_title, 'og_image_url', p.og_image_url, 'canonical_url', p.canonical_url, 'noindex', p.noindex)) order by p.path)
        from public.cms_pages p), '[]'));

  elsif p_what = 'sitemap' then
    return jsonb_build_object('entries', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('type', e.type, 'slug', e.slug, 'updated_at', e.content_updated_at,
                       'published_at', e.publish_at, 'canonical_url', e.canonical_url)) order by e.publish_at desc)
        from public.cms_entries e where cms_private.site_visible(e) and not e.noindex), '[]'),
      'noindex_pages', coalesce((select jsonb_agg(p.path order by p.path) from public.cms_pages p where p.noindex is true), '[]'));

  elsif p_what = 'preview' then
    select e.* into v_e from public.cms_preview_tokens k join public.cms_entries e on e.id = k.entry_id
     where k.token_hash = p_args ->> 'token_hash' and k.expires_at > now() and not public.in_trash('cms_entries', e.id);
    if not found then return jsonb_build_object('not_found', true); end if;
    return jsonb_build_object('entry', cms_private.entry_json(v_e, true), 'status', v_e.status,
      'expires_at', (select expires_at from public.cms_preview_tokens where token_hash = p_args ->> 'token_hash'));
  end if;
  return jsonb_build_object('error', 'unknown_request');
end; $$;

-- Requête refusée (clé du site absente ou fausse) : compteur d'abus par adresse. Faux = trop d'essais (429).
create or replace function public.cms_site_denied(p_server_key text, p_rate text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform appt_private.assert_server(p_server_key);
  return site_private.rate_ok('cms-denied:' || coalesce(p_rate, '?'), 20);
end; $$;

revoke all on function cms_private.entry_json(public.cms_entries, boolean), cms_private.site_visible(public.cms_entries) from public, anon, authenticated;
revoke all on function public.cms_site_read(text, text, jsonb, text), public.cms_site_denied(text, text) from public;
grant execute on function public.cms_site_read(text, text, jsonb, text), public.cms_site_denied(text, text) to anon, authenticated;
