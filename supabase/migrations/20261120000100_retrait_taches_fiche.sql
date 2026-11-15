-- Navigation et Accueil, lot 3 — retrait des tâches de fiche. Migration additive, aucune donnée supprimée :
-- la table public.tasks et son contenu restent en base, mais plus rien ne les crée, ne les compte ni ne les affiche.
-- Les suites (prospection « Intéressé / RDV obtenu », « Ajouter au pipeline », « Devenir client ») deviennent un
-- élément de la To do list relié à la fiche (même titre, urgence « moyen »).

-- ===========================================================================
-- File du jour (Accueil, compteur du menu, MCP list_followups) : relances de prospection et tâches de projet
-- attribuées à moi. Les tâches de fiche n'y figurent plus (mêmes colonnes, dans le même ordre).
-- ===========================================================================
create or replace view public.todo_items with (security_invoker = true) as
  select 'followup'::text as item_type, cp.id, cp.company_id, c.name as company_name, cp.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as person_name,
         cs.name as title, cp.next_due_date as due_date, ca.id as campaign_id, ca.name as campaign_name, cs.channel,
         cs.position as step_position, cs.message as step_message,
         cs.step_type, cs.subject as step_subject, cs.instructions as step_instructions, cp.sequence_version,
         (select count(*)::int from public.campaign_steps x where x.campaign_id = ca.id and x.version = cp.sequence_version) as step_count,
         null::uuid as project_id, null::text as project_name, null::text as task_status
    from public.campaign_participants cp
    join public.campaigns ca on ca.id = cp.campaign_id and ca.status = 'active'
    join public.companies c on c.id = cp.company_id
    join public.campaign_steps cs on cs.campaign_id = cp.campaign_id and cs.version = cp.sequence_version and cs.position = cp.current_step
    left join public.people p on p.id = cp.person_id
   where cp.status in ('a_contacter','en_cours') and cp.next_due_date is not null
     and c.merged_into_id is null and c.archived_at is null and not c.do_not_contact
  union all
  -- tâches de projet qui me sont attribuées (projets actifs)
  select 'project_task', pt.id, pr.company_id, c.name, null::uuid, null::text,
         pt.title, pt.due_date, null, null, null, null, null, null, null, null, null, null,
         pr.id, pr.name, pt.status
    from public.project_tasks pt
    join public.projects pr on pr.id = pt.project_id and pr.status not in ('termine', 'archive')
    join public.companies c on c.id = pr.company_id
   where pt.assignee_kind = 'owner' and pt.status <> 'termine' and c.merged_into_id is null;

-- ===========================================================================
-- Suite d'une fiche = élément de la To do list relié (même titre, urgence « moyen »). Réservé à l'application,
-- comme la To do list : refus clair si l'appel vient de Claude.
-- ===========================================================================
create or replace function public.company_todo_followup(p_company uuid, p_title text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare v_id uuid; v_title text := btrim(coalesce(p_title, ''));
begin
  if public.current_actor() <> 'user' then
    raise exception 'La suite d''une fiche se crée dans l''application (To do list).' using errcode = '42501';
  end if;
  if v_title = '' then raise exception 'Indiquez la prochaine action, ou décochez-la.' using errcode = '22023'; end if;
  if char_length(v_title) > 300 then raise exception 'Prochaine action trop longue (300 caractères au plus).' using errcode = '22023'; end if;
  insert into public.todo_list_items (title, urgency, company_id) values (v_title, 'moyen', p_company) returning id into v_id;
  return v_id;
end;
$$;

-- « Ajouter au pipeline » et « Devenir client » : p_next = { task: { title } } (date ignorée) → To do list.
create or replace function public.company_next_task(p_company uuid, p_next jsonb)
returns uuid
language plpgsql
as $$
declare t jsonb := p_next -> 'task';
begin
  if t is null or jsonb_typeof(t) <> 'object' then return null; end if;
  return public.company_todo_followup(p_company, t ->> 'title');
end;
$$;

-- « Toujours une suite » : étape de pipeline ouverte, rendez-vous à venir, ou To do ouverte reliée à la fiche.
create or replace function public.prospect_has_next(p_company uuid)
returns boolean
language sql
stable
as $$
  select exists (select 1 from public.companies c where c.id = p_company and c.stage_id is not null and c.deal_status = 'open')
      or exists (select 1 from public.appt_bookings b where b.company_id = p_company and b.status in ('pending', 'confirmed') and b.starts_at >= now())
      or exists (select 1 from public.todo_list_items t where t.company_id = p_company and t.done_at is null);
$$;

-- Résultat de prospection : la suite « tâche » devient un élément de la To do list (reste inchangé).
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
      v_task := public.company_todo_followup(cp.company_id, v_task_title);
    end if;
    if not public.prospect_has_next(cp.company_id) then
      raise exception 'Choisissez la suite : une étape du pipeline, un rendez-vous à venir ou un élément de la To do list. Sinon la fiche ne serait plus dans aucune liste.'
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
-- Création manuelle d'une tâche de fiche : retirée (anciens écrans ou intégrations) avec un message clair.
create or replace function public.create_task(
  p_company uuid, p_title text, p_due date, p_person uuid default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
begin
  raise exception 'Les tâches de fiche ont été retirées : utilisez la To do list (Autres › To do list).' using errcode = '0A000';
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.company_todo_followup(uuid, text)', 'public.company_next_task(uuid, jsonb)', 'public.prospect_has_next(uuid)',
                           'public.set_participant_outcome(uuid, text, uuid, text, jsonb, text)', 'public.create_task(uuid, text, date, uuid, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
