-- Diagnostic : le CRM déclenche lui-même la tâche Claude Code (abonnement Claude, pas d'API facturée).
-- Migration additive. Une étape d'un dossier ne déclenche qu'une seule session, même en cas de double clic.

alter table public.diagnostics
  add column trigger_stage text check (trigger_stage in ('start', 'answers')),
  add column triggered_at timestamptz,
  add column trigger_error text check (trigger_error is null or char_length(trigger_error) <= 500);

-- Réserve le déclenchement d'une étape : vrai pour un seul appelant tant que l'étape n'a pas échoué.
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
     and ((p_stage = 'start' and status = 'waiting_claude') or (p_stage = 'answers' and status = 'answers_sent'));
  return found;
end;
$$;

-- Résultat du déclenchement : l'adresse de la session, ou l'erreur, qui rend l'étape relançable.
create or replace function public.diagnostic_trigger_result(p_id uuid, p_session_url text, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Déclenchement d''un diagnostic');
  if p_error is not null then
    update public.diagnostics set trigger_stage = null, trigger_error = left(p_error, 500) where id = p_id;
  else
    update public.diagnostics set chat_url = coalesce(p_session_url, chat_url), trigger_error = null where id = p_id;
  end if;
end;
$$;

revoke all on function public.diagnostic_claim_trigger(uuid, text), public.diagnostic_trigger_result(uuid, text, text) from public, anon;
