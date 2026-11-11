-- Audit, lot 4 — « Aujourd'hui » (Q01, K01, Q04, K06). Migration additive : la vue todo_items gagne les tâches de
-- projet qui me sont attribuées (colonnes ajoutées en fin de vue), le compteur du menu suit les mêmes règles, et les
-- résultats de prospection laissent toujours une suite, enregistrés une seule fois.

-- ===========================================================================
-- Q01 — tâches de projet attribuées à moi dans la file du jour, le compteur et la « prochaine action » de la fiche.
-- Les deux tables restent séparées : la validation se fait sur la tâche d'origine (projet).
-- ===========================================================================
create or replace view public.todo_items with (security_invoker = true) as
  select 'task'::text as item_type, t.id, t.company_id, c.name as company_name, t.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as person_name,
         t.title, t.due_date, null::uuid as campaign_id, null::text as campaign_name, null::text as channel,
         null::int as step_position, null::text as step_message,
         null::text as step_type, null::text as step_subject, null::text as step_instructions, null::int as sequence_version,
         null::int as step_count,
         null::uuid as project_id, null::text as project_name, null::text as task_status
    from public.tasks t
    join public.companies c on c.id = t.company_id
    left join public.people p on p.id = t.person_id
   where t.done_at is null and c.merged_into_id is null and c.archived_at is null
  union all
  select 'followup', cp.id, cp.company_id, c.name, cp.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         cs.name, cp.next_due_date, ca.id, ca.name, cs.channel, cs.position, cs.message,
         cs.step_type, cs.subject, cs.instructions, cp.sequence_version,
         (select count(*)::int from public.campaign_steps x where x.campaign_id = ca.id and x.version = cp.sequence_version),
         null::uuid, null::text, null::text
    from public.campaign_participants cp
    join public.campaigns ca on ca.id = cp.campaign_id and ca.status = 'active'
    join public.companies c on c.id = cp.company_id
    join public.campaign_steps cs on cs.campaign_id = cp.campaign_id and cs.version = cp.sequence_version and cs.position = cp.current_step
    left join public.people p on p.id = cp.person_id
   where cp.status in ('a_contacter','en_cours') and cp.next_due_date is not null
     and c.merged_into_id is null and c.archived_at is null and not c.do_not_contact
  union all
  -- tâches de projet qui me sont attribuées (projets actifs) ; sans échéance : visibles dans « Tout »
  select 'project_task', pt.id, pr.company_id, c.name, null::uuid, null::text,
         pt.title, pt.due_date, null, null, null, null, null, null, null, null, null, null,
         pr.id, pr.name, pt.status
    from public.project_tasks pt
    join public.projects pr on pr.id = pt.project_id and pr.status not in ('termine', 'archive')
    join public.companies c on c.id = pr.company_id
   where pt.assignee_kind = 'owner' and pt.status <> 'termine' and c.merged_into_id is null;

-- Compteur du menu : mêmes règles que la page (dû aujourd'hui ou en retard), plus les réponses et les appels à rattacher.
create or replace function public.nav_counters(p_today date)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'todo', (select count(*) from public.todo_items where due_date <= p_today),
    'due', (select count(*) from public.todo_items where item_type = 'followup' and due_date <= p_today),
    'replies', (select count(*) from public.campaign_participants where status = 'a_repondu' and outcome in ('none', 'replied')),
    'calls', (select count(*) from public.fireflies_calls where link_state = 'to_link'));
$$;

-- ===========================================================================
-- Q04 + K06 — un résultat « Rendez-vous obtenu » ou « Intéressé » laisse toujours une suite visible (étape du
-- pipeline, rendez-vous lié à venir, ou tâche de suivi) ; réponse et résultat s'enregistrent en UNE opération,
-- protégée contre le double clic et les reprises réseau (clé liée à l'opération et à ses paramètres).
-- p_next : { stage_id?, task?: { title, due_date } }
-- ===========================================================================
create or replace function public.prospect_has_next(p_company uuid)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.companies c where c.id = p_company and c.stage_id is not null and c.deal_status = 'open')
      or exists (select 1 from public.appt_bookings b where b.company_id = p_company and b.status in ('pending', 'confirmed') and b.starts_at >= now())
      or exists (select 1 from public.tasks t where t.company_id = p_company and t.done_at is null);
$$;

drop function if exists public.set_participant_outcome(uuid, text, uuid, text);
create or replace function public.set_participant_outcome(
  p_participant uuid, p_outcome text, p_stage uuid default null, p_note text default null,
  p_next jsonb default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  v_prev jsonb;
  v_stopped int := 0;
  v_move jsonb;
  v_stage uuid := coalesce(p_stage, nullif(p_next ->> 'stage_id', '')::uuid);
  v_task uuid;
  v_task_title text := nullif(btrim(p_next -> 'task' ->> 'title'), '');
  v_task_due date := nullif(p_next -> 'task' ->> 'due_date', '')::date;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('p', p_participant, 'o', p_outcome, 's', v_stage, 'n', p_note, 'x', p_next));
  if v_prev is not null then return v_prev; end if;
  if p_outcome not in ('replied', 'interested', 'not_interested', 'meeting', 'do_not_contact') then
    raise exception 'Résultat invalide' using errcode = '22023';
  end if;
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;

  update public.campaign_participants set outcome = p_outcome, outcome_at = now() where id = cp.id;

  if p_outcome in ('not_interested', 'do_not_contact') then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null,
           stop_reason = case p_outcome when 'not_interested' then 'Pas intéressé' else 'Ne plus contacter' end
     where company_id = cp.company_id and status in ('a_preparer', 'a_contacter', 'en_cours', 'a_repondu');
    get diagnostics v_stopped = row_count;
    update public.companies set prospect_status = 'pas_interesse' where id = cp.company_id;
  end if;
  if p_outcome = 'do_not_contact' then
    update public.companies set do_not_contact = true, do_not_contact_at = now(),
           do_not_contact_reason = coalesce(nullif(btrim(p_note), ''), do_not_contact_reason)
     where id = cp.company_id;
  end if;
  if p_outcome in ('interested', 'meeting') then
    update public.companies set prospect_status = 'qualifie'
     where id = cp.company_id and prospect_status in ('nouveau', 'contacte', 'en_discussion');
    if v_stage is not null then
      v_move := public.move_company(cp.company_id, v_stage, true, null);
    end if;
    if v_task_title is not null then
      insert into public.tasks (company_id, person_id, title, due_date, source)
      values (cp.company_id, cp.person_id, left(v_task_title, 300), coalesce(v_task_due, public.today_paris() + 2),
              case when public.current_actor() = 'claude' then 'claude' else 'user' end)
      returning id into v_task;
    end if;
    if not public.prospect_has_next(cp.company_id) then
      raise exception 'Choisissez la suite : une étape du pipeline, un rendez-vous à venir ou une tâche de suivi. Sinon la fiche ne serait plus dans aucune liste.'
        using errcode = '22023';
    end if;
  end if;

  perform public.log_event(cp.company_id, 'prospecting',
    case p_outcome
      when 'replied' then 'Résultat : a répondu'
      when 'interested' then 'Résultat : intéressé'
      when 'not_interested' then 'Résultat : pas intéressé — prospection arrêtée'
      when 'meeting' then 'Résultat : rendez-vous obtenu'
      else 'Ne plus contacter' || coalesce(' : ' || nullif(btrim(p_note), ''), '') end,
    jsonb_build_object('campaign_id', cp.campaign_id, 'participant_id', cp.id, 'outcome', p_outcome, 'task_id', v_task));

  return public.idem_put(p_idempotency_key, 'set_participant_outcome',
    jsonb_build_object('status', 'ok', 'stopped', v_stopped, 'moved', v_move is not null, 'task_id', v_task));
end;
$$;

-- Réponse reçue (et, en option, son résultat) : une seule opération, une seule entrée d'historique.
drop function if exists public.record_reply(uuid, text, timestamptz, uuid, text);
create or replace function public.record_reply(
  p_participant uuid, p_content text, p_received_at timestamptz default null, p_person uuid default null, p_channel text default null,
  p_outcome text default null, p_next jsonb default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  st public.campaign_steps;
  v_prev jsonb;
  v_res jsonb;
  v_out jsonb;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('p', p_participant, 'c', p_content, 'at', p_received_at,
    'person', p_person, 'ch', p_channel, 'o', p_outcome, 'x', p_next));
  if v_prev is not null then return v_prev; end if;
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  select * into st from public.campaign_steps
   where campaign_id = cp.campaign_id and version = cp.sequence_version and position = greatest(cp.current_step - 1, 1);
  -- add_interaction suspend les relances actives de toute l'entreprise (tous ses contacts)
  v_res := public.add_interaction(cp.company_id, 'message_in', p_content, p_received_at,
                                  coalesce(p_person, cp.person_id), coalesce(p_channel, st.channel));
  update public.interactions set campaign_participant_id = cp.id where id = (v_res ->> 'id')::uuid;
  update public.campaign_participants set status = 'a_repondu', next_due_date = null
   where id = cp.id and status not in ('arrete');
  if p_outcome is not null and p_outcome <> 'none' then
    v_out := public.set_participant_outcome(cp.id, p_outcome, null, null, p_next, null);
  end if;
  return public.idem_put(p_idempotency_key, 'record_reply',
    jsonb_build_object('status', 'paused', 'paused_followups', (v_res ->> 'paused_followups')::int, 'outcome', v_out));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.nav_counters(date)', 'public.prospect_has_next(uuid)',
    'public.set_participant_outcome(uuid, text, uuid, text, jsonb, text)',
    'public.record_reply(uuid, text, timestamptz, uuid, text, text, jsonb, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on public.todo_items from anon;
grant select on public.todo_items to authenticated;
