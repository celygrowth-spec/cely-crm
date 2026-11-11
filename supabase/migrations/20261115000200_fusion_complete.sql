-- Audit, lot 2 — fusion complète (C02). Migration additive : aucune donnée existante n'est modifiée ici (le
-- rattrapage des fusions passées est un script séparé : supabase/maintenance/rattrapage-fusions.sql).
--  * Tout suit la fiche conservée : personnes, historique, tâches, listes, campagnes, ventes (renumérotées en cycles),
--    revenus, factures et règlements, projets (membres, tâches, fichiers partagés, onboarding), rendez-vous, fichiers,
--    emails, appels Fireflies, diagnostics, temps.
--  * Conflits présentés avant confirmation (merge_preview) ; deux ventes en cours sont bloquées avec une explication ;
--    l'issue choisie doit être celle qui porte la vente active.
--  * Une seule transaction ; l'identifiant absorbé reste tracé (companies.merged_into_id, table merges).

-- Ce que chaque fiche apporte, et ce qui bloque ou demande attention.
create or replace function public.merge_preview(p_keep uuid, p_merge uuid)
returns jsonb
language plpgsql
stable
as $$
declare
  v_counts jsonb := '{}'::jsonb;
  v_blocking jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  k public.companies;
  m public.companies;
  ks public.sales;
  ms public.sales;
  side record;
begin
  perform public.assert_owner();
  select * into k from public.companies where id = p_keep;
  select * into m from public.companies where id = p_merge;
  if k.id is null or m.id is null then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  for side in select * from (values ('keep', p_keep), ('merge', p_merge)) as x(label, id) loop
    v_counts := v_counts || jsonb_build_object(side.label, jsonb_build_object(
      'personnes', (select count(*) from public.people where company_id = side.id),
      'historique', (select count(*) from public.interactions where company_id = side.id),
      'taches', (select count(*) from public.tasks where company_id = side.id),
      'campagnes', (select count(*) from public.campaign_participants where company_id = side.id),
      'ventes', (select count(*) from public.sales where company_id = side.id),
      'revenus', (select count(*) from public.finance_missions where company_id = side.id),
      'factures', (select count(*) from public.finance_invoices where company_id = side.id),
      'reglements', (select count(*) from public.finance_payments p join public.finance_invoices i on i.id = p.invoice_id where i.company_id = side.id),
      'projets', (select count(*) from public.projects where company_id = side.id),
      'taches_projet', (select count(*) from public.project_tasks t join public.projects p on p.id = t.project_id where p.company_id = side.id),
      'rendez_vous', (select count(*) from public.appt_bookings where company_id = side.id),
      'fichiers', (select count(*) from public.company_files where company_id = side.id),
      'emails', (select count(*) from public.mail_messages where company_id = side.id),
      'appels', (select count(*) from public.fireflies_calls where company_id = side.id),
      'diagnostics', (select count(*) from public.diagnostics where company_id = side.id),
      'temps', (select count(*) from public.time_entries where company_id = side.id)));
  end loop;

  select * into ks from public.sales where company_id = p_keep and state in ('won', 'reopened');
  select * into ms from public.sales where company_id = p_merge and state in ('won', 'reopened');
  if ks.id is not null and ms.id is not null then
    v_blocking := v_blocking || jsonb_build_array(
      'Les deux fiches ont une vente en cours. Terminez ou marquez perdue l''une des deux (Ventes) avant de fusionner.');
  end if;
  if (ks.id is not null or ms.id is not null) then
    v_warnings := v_warnings || jsonb_build_array(
      'Une vente en cours existe sur « ' || case when ks.id is not null then k.name else m.name end
      || ' » : gardez la position commerciale (pipeline et issue) de cette fiche.');
  end if;
  if exists (select 1 from public.campaign_participants a join public.campaign_participants b on a.campaign_id = b.campaign_id
              where a.company_id = p_keep and b.company_id = p_merge) then
    v_warnings := v_warnings || jsonb_build_array('Les deux fiches sont dans une même campagne : le suivi de la fiche conservée est gardé, l''autre est arrêté et consigné.');
  end if;
  if (select count(*) from public.projects where company_id in (p_keep, p_merge) and status not in ('termine', 'archive')) > 1 then
    v_warnings := v_warnings || jsonb_build_array('Plusieurs projets actifs seront rattachés à la même fiche : vérifiez-les ensuite dans Projets.');
  end if;
  return jsonb_build_object('counts', v_counts, 'blocking', v_blocking, 'warnings', v_warnings,
    'active_sale', case when ks.id is not null then 'keep' when ms.id is not null then 'merge' end);
end;
$$;

-- Les rendez-vous ne s'écrivent pas directement (module Rendez-vous) : déplacement dédié, réservé au propriétaire.
create or replace function public.merge_move_bookings(p_from uuid, p_to uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_n int;
begin
  perform public.assert_owner();
  if not exists (select 1 from public.companies where id = p_to and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  update public.appt_bookings set company_id = p_to where company_id = p_from;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Fusion complète (redéfinition entière de merge_companies).
create or replace function public.merge_companies(
  p_keep uuid, p_merge uuid, p_fields jsonb default '{}', p_pipeline_from text default 'keep')
returns jsonb
language plpgsql
as $$
declare
  k public.companies;
  m public.companies;
  r record;
  v_conflicts int := 0;
  v_people int;
  v_moved jsonb := '{}'::jsonb;
  v_n int;
  v_offset int;
  ks public.sales;
  ms public.sales;
  v_active public.sales;
  v_result_status text;
  f text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Fusion');
  if p_keep = p_merge then raise exception 'Impossible de fusionner une fiche avec elle-même' using errcode = '22023'; end if;
  if p_pipeline_from not in ('keep', 'merged') then raise exception 'Choix du pipeline invalide' using errcode = '22023'; end if;
  -- verrouillage dans un ordre stable
  perform 1 from public.companies where id in (p_keep, p_merge) order by id for update;
  select * into k from public.companies where id = p_keep;
  select * into m from public.companies where id = p_merge;
  if k.id is null or m.id is null then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if k.merged_into_id is not null or m.merged_into_id is not null then
    raise exception 'Une des fiches a déjà été fusionnée' using errcode = '22023';
  end if;

  -- ventes : deux ventes en cours sont incompatibles ; l'issue gardée doit être celle de la vente active
  select * into ks from public.sales where company_id = k.id and state in ('won', 'reopened') for update;
  select * into ms from public.sales where company_id = m.id and state in ('won', 'reopened') for update;
  if ks.id is not null and ms.id is not null then
    raise exception 'Fusion impossible : les deux fiches ont une vente en cours. Terminez ou marquez perdue l''une des deux dans Ventes, puis fusionnez.' using errcode = 'P0001';
  end if;
  if ks.id is not null then v_active := ks; else v_active := ms; end if;
  v_result_status := case when p_pipeline_from = 'merged' then m.deal_status else k.deal_status end;
  if v_active.id is not null and v_result_status <> (case v_active.state when 'won' then 'won' else 'open' end) then
    raise exception 'Fusion impossible en l''état : la vente en cours de « % » demande de garder sa position commerciale (pipeline et issue « % »).',
      case when ks.id is not null then k.name else m.name end,
      case v_active.state when 'won' then 'gagnée' else 'ouverte' end using errcode = 'P0001';
  end if;

  insert into public.merges (kept_company_id, merged_company_id, merged_snapshot, field_choices)
  values (k.id, m.id,
          jsonb_build_object('company', to_jsonb(m),
                             'people', coalesce((select jsonb_agg(to_jsonb(p)) from public.people p where p.company_id = m.id), '[]')),
          coalesce(p_fields, '{}') || jsonb_build_object('pipeline_from', p_pipeline_from));

  for f in select jsonb_object_keys(coalesce(p_fields, '{}')) loop
    if f not in ('name','website','description','source_id','amount','expected_close_date','prospect_status','lost_reason') then
      raise exception 'Champ inconnu : %', f using errcode = '22023';
    end if;
  end loop;

  update public.companies set
    name = case when p_fields ->> 'name' = 'merged' then m.name else k.name end,
    website = case when p_fields ->> 'website' = 'merged' then m.website else coalesce(k.website, m.website) end,
    description = case when p_fields ->> 'description' = 'merged' then m.description else coalesce(k.description, m.description) end,
    source_id = case when p_fields ->> 'source_id' = 'merged' then m.source_id else coalesce(k.source_id, m.source_id) end,
    amount = case when p_fields ->> 'amount' = 'merged' then m.amount else coalesce(k.amount, m.amount) end,
    expected_close_date = case when p_fields ->> 'expected_close_date' = 'merged' then m.expected_close_date else coalesce(k.expected_close_date, m.expected_close_date) end,
    prospect_status = case when p_fields ->> 'prospect_status' = 'merged' then m.prospect_status else k.prospect_status end,
    lost_reason = case when p_fields ->> 'lost_reason' = 'merged' then m.lost_reason else coalesce(k.lost_reason, m.lost_reason) end,
    tags = array(select distinct unnest(k.tags || m.tags)),
    pipeline_id = case when p_pipeline_from = 'merged' then m.pipeline_id else k.pipeline_id end,
    stage_id = case when p_pipeline_from = 'merged' then m.stage_id else k.stage_id end,
    deal_status = case when p_pipeline_from = 'merged' then m.deal_status else k.deal_status end,
    deal_closed_at = case when p_pipeline_from = 'merged' then m.deal_closed_at else k.deal_closed_at end,
    archived_at = case when k.archived_at is not null and m.archived_at is null then null else k.archived_at end
  where id = k.id;

  -- personnes : un seul contact principal conservé (leurs accès au portail les suivent)
  if exists (select 1 from public.people where company_id = k.id and is_primary) then
    update public.people set is_primary = false where company_id = m.id;
  end if;
  update public.people set company_id = k.id where company_id = m.id;
  get diagnostics v_people = row_count;

  update public.interactions set company_id = k.id where company_id = m.id;
  update public.tasks set company_id = k.id where company_id = m.id;
  update public.import_row_keys set company_id = k.id where company_id = m.id;

  insert into public.list_members (list_id, company_id, added_at)
  select list_id, k.id, added_at from public.list_members where company_id = m.id
  on conflict do nothing;
  delete from public.list_members where company_id = m.id;

  -- campagnes : sans conflit, le participant est rattaché à la fiche conservée ;
  -- en conflit, celui de la fiche fusionnée est arrêté et son état est consigné.
  for r in
    select cp.*, ca.name as campaign_name
      from public.campaign_participants cp join public.campaigns ca on ca.id = cp.campaign_id
     where cp.company_id = m.id
  loop
    if exists (select 1 from public.campaign_participants where campaign_id = r.campaign_id and company_id = k.id) then
      update public.campaign_participants
         set status = 'arrete', next_due_date = null, stop_reason = 'Fusionné dans la fiche ' || k.name
       where id = r.id;
      perform public.log_event(k.id, 'merge',
        'Campagne « ' || r.campaign_name || ' » : la fiche fusionnée y était aussi (étape ' || r.current_step
        || ', statut ' || r.status || '). Le suivi de cette fiche a été conservé.',
        jsonb_build_object('campaign_id', r.campaign_id, 'merged_participant', to_jsonb(r)));
      v_conflicts := v_conflicts + 1;
    else
      update public.campaign_participants set company_id = k.id where id = r.id;
    end if;
  end loop;

  -- ventes : déplacées et renumérotées après les cycles de la fiche conservée
  select coalesce(max(cycle), 0) into v_offset from public.sales where company_id = k.id;
  update public.sales set company_id = k.id, cycle = cycle + v_offset where company_id = m.id;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('ventes', v_n);
  -- projets (membres, tâches, fichiers partagés, onboarding suivent le projet) et rendez-vous
  update public.projects set company_id = k.id where company_id = m.id;
  get diagnostics v_n = row_count; v_moved := v_moved || jsonb_build_object('projets', v_n);
  v_n := public.merge_move_bookings(m.id, k.id); v_moved := v_moved || jsonb_build_object('rendez_vous', v_n);

  delete from public.duplicate_dismissals where company_a = m.id or company_b = m.id;

  -- la fiche absorbée : archivée, son identifiant pointe vers la fiche conservée. Les déclencheurs déplacent
  -- revenus, factures, fichiers, emails, appels, diagnostics et temps.
  update public.companies
     set merged_into_id = k.id, archived_at = coalesce(archived_at, now()),
         pipeline_id = null, stage_id = null
   where id = m.id;

  perform public.log_event(k.id, 'merge',
    'Fiche « ' || m.name || ' » fusionnée dans cette fiche (ancien identifiant ' || m.id || ')',
    jsonb_build_object('merged_company_id', m.id, 'merged_name', m.name, 'people_moved', v_people,
                       'campaign_conflicts', v_conflicts, 'moved', v_moved,
                       'pipeline_from', p_pipeline_from,
                       'discarded_pipeline', case when p_pipeline_from = 'merged' then k.stage_id else m.stage_id end));

  return jsonb_build_object('status', 'merged', 'kept_id', k.id, 'merged_id', m.id,
                            'people_moved', v_people, 'campaign_conflicts', v_conflicts, 'moved', v_moved);
end;
$$;

-- La vente est désormais déplacée par merge_companies (renumérotée) : le déclencheur ne fait plus rien.
create or replace function public.tg_sales_follow_merge()
returns trigger
language plpgsql
as $$
begin
  return null;
end;
$$;

revoke execute on function public.merge_move_bookings(uuid, uuid) from public, anon;
grant execute on function public.merge_move_bookings(uuid, uuid) to authenticated;
revoke execute on function public.merge_preview(uuid, uuid) from public, anon;
grant execute on function public.merge_preview(uuid, uuid) to authenticated;
