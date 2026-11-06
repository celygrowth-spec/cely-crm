-- Fireflies, phase 3 : historique des appels sur la fiche (voir docs/integrations/fireflies.md).

-- Distincte du résumé : un nouvel import n'y touche jamais.
alter table public.fireflies_calls
  add column internal_note text check (internal_note is null or char_length(internal_note) <= 20000);

-- Liste et détail : tout sauf la transcription, chargée seulement à l'ouverture.
create view public.fireflies_call_list with (security_invoker = true) as
select c.id, c.fireflies_id, c.title, c.occurred_at, c.duration_minutes, c.organizer_email, c.participants, c.attendees, c.speakers,
       c.transcript_url, c.silent, c.summary, c.summary_state, c.line_count, c.internal_note, c.created_at,
       c.link_state, c.link_source, c.link_reason, c.link_candidates, c.company_id, c.person_id, c.booking_id,
       co.name as company_name,
       case
         when j.status = 'failed' then 'failed'
         when c.summary_state = 'pending' then 'summary_pending'
         else 'imported'
       end as display_state,
       j.last_error
  from public.fireflies_calls c
  left join public.fireflies_import_jobs j on j.call_id = c.id
  left join public.companies co on co.id = c.company_id;

revoke all on public.fireflies_call_list from public, anon, authenticated;
grant select on public.fireflies_call_list to authenticated;

create or replace function public.fireflies_set_call_note(p_call uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.fireflies_calls set internal_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_call;
  if not found then raise exception 'Appel introuvable' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.fireflies_set_call_note(uuid, text) from public, anon;
grant execute on function public.fireflies_set_call_note(uuid, text) to authenticated;
