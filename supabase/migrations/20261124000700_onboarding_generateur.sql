-- Générer l'onboarding : le questionnaire du générateur remplit la préparation de projet EXISTANTE (points à
-- compléter, sections, analyse, slides, planning). Aucun circuit parallèle : les slides restent celles de
-- project_onboarding_decks, produites par la tâche Claude des projets.
--
--   * Une version du générateur suit les slides d'onboarding du projet : prête quand elles sont reçues, en échec
--     quand leur génération échoue (déclencheur, sans toucher aux fonctions existantes).
--   * Rien n'est visible du client avant ma validation : les slides d'une version du générateur non validée ne se
--     partagent pas. Le partage reste l'action explicite existante.
-- Migration additive.

create or replace function public.tg_onboarding_deck_generator()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'ready' and new.file_id is not null and old.status is distinct from 'ready' then
    update public.generator_versions v
       set file_id = new.file_id, slides_status = 'ready', ready_at = now(), slides_error = null
      from public.generator_dossiers d
     where d.id = v.dossier_id and d.kind = 'onboarding' and d.project_id = new.project_id
       and v.validated_at is null and v.slides_status in ('pending', 'uploading', 'failed')
       and v.version = (select max(x.version) from public.generator_versions x where x.dossier_id = d.id);
  elsif new.status = 'failed' and old.status is distinct from 'failed' then
    update public.generator_versions v
       set slides_status = 'failed', slides_error = left(coalesce(new.error, 'La génération des slides a échoué.'), 2000)
      from public.generator_dossiers d
     where d.id = v.dossier_id and d.kind = 'onboarding' and d.project_id = new.project_id
       and v.validated_at is null and v.slides_status in ('pending', 'uploading');
  end if;
  return null;
end; $$;
drop trigger if exists onboarding_deck_generator on public.project_onboarding_decks;
create trigger onboarding_deck_generator after update of status on public.project_onboarding_decks
  for each row execute function public.tg_onboarding_deck_generator();

create or replace function public.tg_onboarding_deck_share_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.shared_at is not null and old.shared_at is null and exists (
       select 1 from public.generator_versions v join public.generator_dossiers d on d.id = v.dossier_id
        where d.kind = 'onboarding' and d.project_id = new.project_id and v.file_id = new.file_id and v.validated_at is null) then
    raise exception 'Validez l''onboarding avant de partager ses slides au client' using errcode = '22023';
  end if;
  return new;
end; $$;
drop trigger if exists onboarding_deck_share_guard on public.project_onboarding_decks;
create trigger onboarding_deck_share_guard before update of shared_at on public.project_onboarding_decks
  for each row execute function public.tg_onboarding_deck_share_guard();

revoke all on function public.tg_onboarding_deck_generator() from public, anon, authenticated;
revoke all on function public.tg_onboarding_deck_share_guard() from public, anon, authenticated;
