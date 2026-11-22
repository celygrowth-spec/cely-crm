-- CMS (lot 2) : images des contenus du site. Migration additive.
--  * Bucket « cms-media » PUBLIC en lecture : les images sont affichées par le site (couverture, partage, corps).
--    Les noms de fichiers sont aléatoires ; une image d'un brouillon n'est trouvable que par qui connaît son adresse.
--    Formats d'image seulement, sans SVG (un SVG peut porter du script). 10 Mo au plus.
--  * Envoi, liste et suppression réservés au propriétaire dans l'application.
--  * Registre cms_media : une ligne par image (nom d'origine, type, taille), pour la page Images et l'import.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cms-media', 'cms-media', true, 10485760, array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy cms_media_select on storage.objects for select to authenticated
  using (bucket_id = 'cms-media' and (select public.is_app_owner()));
create policy cms_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'cms-media' and (select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'cms-media' and (select public.is_app_owner()) and public.current_actor() = 'user');

create table public.cms_media (
  id uuid primary key default gen_random_uuid(),
  path text not null unique check (path ~ '^[0-9a-f-]{36}\.(png|jpg|jpeg|webp|gif|avif)$'),
  filename text not null check (char_length(filename) between 1 and 200),
  mime text not null check (mime in ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif')),
  size integer not null check (size > 0 and size <= 10485760),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_at timestamptz not null default now()
);
create index cms_media_created_idx on public.cms_media (created_at desc);
alter table public.cms_media enable row level security;
revoke all on public.cms_media from anon;
create policy cms_media_owner_read on public.cms_media for select to authenticated using ((select public.is_app_owner()));
create policy cms_media_owner_insert on public.cms_media for insert to authenticated
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_media_owner_update on public.cms_media for update to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy cms_media_owner_delete on public.cms_media for delete to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user');
