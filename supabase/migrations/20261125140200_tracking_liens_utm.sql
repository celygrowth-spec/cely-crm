-- Tracking site · lot 2 : liens UTM créés dans le Générateur de liens UTM.
-- Chaque lien garde un nom lisible ; le même lien enregistré deux fois n'en crée qu'un (son nom est mis à jour).
-- Les visites sont rapprochées d'un lien par leurs UTM normalisés : aucune redirection, aucun identifiant dans le lien.
-- Rejouable.

create table if not exists public.site_utm_links (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  path text not null check (char_length(path) between 1 and 300 and path ~ '^/'),
  utm_source text not null check (utm_source ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(utm_source) <= 80),
  utm_medium text not null check (utm_medium ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(utm_medium) <= 80),
  utm_campaign text not null check (utm_campaign ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(utm_campaign) <= 80),
  utm_content text check (utm_content is null or (utm_content ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(utm_content) <= 80)),
  utm_term text check (utm_term is null or (utm_term ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(utm_term) <= 80)),
  url text not null check (char_length(url) <= 1000),
  created_at timestamptz not null default now(),
  demo boolean not null default false
);
create unique index if not exists site_utm_links_url on public.site_utm_links (url);
create index if not exists site_utm_links_campaign on public.site_utm_links (utm_campaign);

alter table public.site_utm_links enable row level security;
revoke all on public.site_utm_links from anon, authenticated;
grant select on public.site_utm_links to authenticated;
drop policy if exists owner_select on public.site_utm_links;
create policy owner_select on public.site_utm_links for select to authenticated using ((select public.is_app_owner()));

-- La convention de nommage est imposée ici aussi (contraintes ci-dessus) : une valeur non conforme est refusée,
-- même si l'appel ne vient pas du générateur.
create or replace function public.site_utm_link_save(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v public.site_utm_links;
begin
  perform public.assert_owner();
  insert into public.site_utm_links (name, path, utm_source, utm_medium, utm_campaign, utm_content, utm_term, url)
  values (btrim(p ->> 'name'), p ->> 'path', p ->> 'utm_source', p ->> 'utm_medium', p ->> 'utm_campaign',
    nullif(p ->> 'utm_content', ''), nullif(p ->> 'utm_term', ''), p ->> 'url')
  on conflict (url) do update set name = excluded.name
  returning * into v;
  return to_jsonb(v);
exception when check_violation or not_null_violation then
  raise exception 'Lien invalide : nom, page, source, support et campagne sont obligatoires (minuscules, sans accents, tirets).' using errcode = '22023';
end;
$$;

create or replace function public.site_utm_link_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then raise exception 'Suppression réservée à l''application' using errcode = '42501'; end if;
  delete from public.site_utm_links where id = p_id;
end;
$$;

revoke execute on function public.site_utm_link_save(jsonb), public.site_utm_link_delete(uuid) from public, anon;
grant execute on function public.site_utm_link_save(jsonb), public.site_utm_link_delete(uuid) to authenticated;
