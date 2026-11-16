-- Diagnostic : capture du site du prospect par le serveur du CRM, au lancement du dossier.
-- La session Claude la lit par le connecteur, sans dépendre de son propre accès réseau.
-- Migration additive : une table, deux fonctions. Chaque lancement ou relance ajoute une capture datée ;
-- la plus récente fait foi. Pas de journal d'activité sur cette table : il recopierait le texte des pages.

create table public.diagnostic_site_captures (
  id uuid primary key default gen_random_uuid(),
  diagnostic_id uuid not null references public.diagnostics (id) on delete cascade,
  -- pending : capture en cours ; ok : tout est lu ; partial : lu en partie ; failed : rien de lu ; none : pas de site sur la fiche
  status text not null default 'pending' check (status in ('pending', 'ok', 'partial', 'failed', 'none')),
  site_url text check (site_url is null or char_length(site_url) <= 1000),
  error text check (error is null or char_length(error) <= 2000),
  -- [{ url, titre, texte, tronque, capture_le }] ; le serveur borne le nombre et la taille des pages
  pages jsonb not null default '[]' check (jsonb_typeof(pages) = 'array'),
  created_at timestamptz not null default now(),
  captured_at timestamptz
);
create index diagnostic_site_captures_idx on public.diagnostic_site_captures (diagnostic_id, created_at desc);

alter table public.diagnostic_site_captures enable row level security;
create policy owner_select on public.diagnostic_site_captures for select to authenticated using ((select public.is_app_owner()));
revoke all on public.diagnostic_site_captures from public, anon, authenticated;
grant select on public.diagnostic_site_captures to authenticated;

-- Réserve une capture : un double clic n'en lance qu'une. p_only_if_none : seulement si le dossier n'en a encore aucune.
-- Une capture restée « en cours » plus de deux minutes (serveur interrompu) ne bloque plus.
create or replace function public.diagnostic_site_capture_claim(p_id uuid, p_only_if_none boolean)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Capture du site d''un diagnostic');
  perform 1 from public.diagnostics where id = p_id for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if exists (select 1 from public.diagnostic_site_captures
              where diagnostic_id = p_id
                and (p_only_if_none or (status = 'pending' and created_at > now() - interval '2 minutes'))) then
    return null;
  end if;
  insert into public.diagnostic_site_captures (diagnostic_id) values (p_id) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.diagnostic_site_capture_save(p_capture uuid, p_status text, p_site_url text, p_error text, p_pages jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Capture du site d''un diagnostic');
  if p_status not in ('ok', 'partial', 'failed', 'none') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  if jsonb_typeof(p_pages) <> 'array' or jsonb_array_length(p_pages) > 10 or octet_length(p_pages::text) > 2000000 then
    raise exception 'Capture trop volumineuse' using errcode = '22023';
  end if;
  update public.diagnostic_site_captures
     set status = p_status, site_url = left(p_site_url, 1000), error = left(p_error, 2000), pages = p_pages, captured_at = now()
   where id = p_capture and status = 'pending';
  if not found then raise exception 'Capture introuvable' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.diagnostic_site_capture_claim(uuid, boolean), public.diagnostic_site_capture_save(uuid, text, text, text, jsonb) from public, anon;
