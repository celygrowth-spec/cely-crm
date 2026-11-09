-- Diagnostic : un dossier en échec se relance toujours, même si la session précédente s'est arrêtée sans le signaler.
-- La relance le fait sortir de l'échec : un double clic ne lance donc qu'une session. Migration additive (remplace une fonction).
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
     set trigger_stage = p_stage, triggered_at = now(), trigger_error = null,
         status = case when p_stage = 'start' then 'waiting_claude' else 'answers_sent' end,
         last_error = case when status = 'failed' then null else last_error end
   where id = p_id
     and (trigger_stage is distinct from p_stage or status = 'failed')
     and ((p_stage = 'start' and answers_sent_at is null and status in ('waiting_claude', 'failed'))
       or (p_stage = 'answers' and answers_sent_at is not null and status in ('answers_sent', 'failed')));
  return found;
end;
$$;
