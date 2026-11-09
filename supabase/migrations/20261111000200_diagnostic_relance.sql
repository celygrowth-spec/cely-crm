-- Diagnostic : un dossier en échec se relance depuis l'application, à l'étape où il s'est arrêté.
-- Migration additive (remplace deux fonctions). Un échec libère l'étape réservée par le déclenchement.

create or replace function public.diagnostic_report_failure(p_id uuid, p_message text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  update public.diagnostics set status = 'failed', last_error = left(p_message, 2000), trigger_stage = null where id = p_id;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
end;
$$;

-- Lancement initial avant les réponses, génération après : un échec repart de la même étape.
create or replace function public.diagnostic_claim_trigger(p_id uuid, p_stage text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Déclenchement d''un diagnostic');
  update public.diagnostics
     set trigger_stage = p_stage, triggered_at = now(), trigger_error = null
   where id = p_id
     and trigger_stage is distinct from p_stage
     and ((p_stage = 'start' and answers_sent_at is null and status in ('waiting_claude', 'failed'))
       or (p_stage = 'answers' and answers_sent_at is not null and status in ('answers_sent', 'failed')));
  return found;
end;
$$;

-- Dossiers déjà en échec : l'étape redevient relançable
update public.diagnostics set trigger_stage = null where status = 'failed';
