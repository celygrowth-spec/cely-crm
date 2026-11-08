-- Diagnostic, phase 4 : retour sur une version et demande de la version suivante, dans le même dossier.
-- Migration additive. Versions, fichiers et retours précédents restent conservés.

alter table public.diagnostics drop constraint diagnostics_status_check;
alter table public.diagnostics add constraint diagnostics_status_check check (status in (
  'waiting_claude', 'researching', 'questions_ready', 'answers_sent', 'generating', 'version_ready', 'revision_requested', 'failed'
));
alter table public.diagnostics drop constraint diagnostics_trigger_stage_check;
alter table public.diagnostics add constraint diagnostics_trigger_stage_check check (trigger_stage in ('start', 'answers', 'revision'));

-- Le retour porte sur la version à réviser : la suivante est produite à partir de ce fichier et de ce texte.
alter table public.diagnostic_versions
  add column feedback text check (feedback is null or char_length(feedback) between 1 and 10000),
  add column feedback_at timestamptz;

-- Seule la dernière version reçue se révise ; un double clic ne crée pas une seconde demande.
create or replace function public.diagnostic_request_revision(p_id uuid, p_version integer, p_feedback text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_latest integer;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Demande de nouvelle version');
  select status into v_status from public.diagnostics where id = p_id for update;
  if v_status is null then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if v_status = 'revision_requested' then return v_status; end if;
  if v_status <> 'version_ready' then raise exception 'Aucune version prête à réviser' using errcode = '22023'; end if;
  select max(version) into v_latest from public.diagnostic_versions where diagnostic_id = p_id and status = 'ready';
  if v_latest is distinct from p_version then raise exception 'Seule la dernière version reçue peut être révisée' using errcode = '22023'; end if;
  if nullif(btrim(p_feedback), '') is null then raise exception 'Décrivez ce qu''il faut changer' using errcode = '22023'; end if;
  update public.diagnostic_versions set feedback = btrim(p_feedback), feedback_at = now() where diagnostic_id = p_id and version = p_version;
  update public.diagnostics set status = 'revision_requested', trigger_stage = null, last_error = null where id = p_id;
  return 'revision_requested';
end;
$$;

-- Déclenchement : la révision s'ajoute au lancement et à la génération. Un dossier en échec repart de son étape.
create or replace function public.diagnostic_claim_trigger(p_id uuid, p_stage text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Déclenchement d''un diagnostic');
  update public.diagnostics d
     set trigger_stage = p_stage, triggered_at = now(), trigger_error = null,
         status = case p_stage when 'start' then 'waiting_claude' when 'answers' then 'answers_sent' else 'revision_requested' end,
         last_error = case when d.status = 'failed' then null else d.last_error end
   where d.id = p_id
     and (d.trigger_stage is distinct from p_stage or d.status = 'failed')
     and ((p_stage = 'start' and d.answers_sent_at is null and d.status in ('waiting_claude', 'failed'))
       or (p_stage = 'answers' and d.answers_sent_at is not null and d.status in ('answers_sent', 'failed'))
       or (p_stage = 'revision' and d.status in ('revision_requested', 'failed') and exists (
             select 1 from public.diagnostic_versions v
              where v.diagnostic_id = d.id and v.feedback is not null
                and v.version = (select max(version) from public.diagnostic_versions where diagnostic_id = d.id and status = 'ready'))));
  return found;
end;
$$;

revoke all on function public.diagnostic_request_revision(uuid, integer, text) from public, anon;
