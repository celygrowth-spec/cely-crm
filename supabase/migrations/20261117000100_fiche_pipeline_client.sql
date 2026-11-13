-- Fiche prospect : « Ajouter à une pipeline » et « Passer en client » depuis le menu Actions (et Claude).
-- Migration additive : aucune table modifiée, aucune fonction existante redéfinie. Les deux fonctions enchaînent
-- les mécanismes existants — move_company (étape), sale_confirm (Gagné : vente, revenu, projet, onboarding),
-- create_task (prochaine action) — en UNE transaction : tout est enregistré, ou rien.
--
-- Relances de campagne : la base ne décide jamais seule. Si la fiche a des relances de prospection en cours,
-- l'appel doit dire explicitement « stop » (arrêtées, historique conservé) ou « keep » (elles continuent) ;
-- sans ce choix, elle refuse et l'explique.

-- Relances de prospection en cours sur la fiche (mêmes statuts que move_company).
create or replace function public.company_active_followups(p_company uuid)
returns integer
language sql
stable
as $$
  select count(*)::int from public.campaign_participants
   where company_id = p_company and status in ('a_contacter', 'en_cours', 'a_repondu');
$$;

-- Choix explicite sur les relances en cours : true = les arrêter. Refus si un choix est nécessaire et absent.
create or replace function public.company_followups_choice(p_company uuid, p_choice text)
returns boolean
language plpgsql
stable
as $$
declare v_active int := public.company_active_followups(p_company);
begin
  if p_choice is not null and p_choice not in ('stop', 'keep') then
    raise exception 'Choix des relances invalide (stop ou keep).' using errcode = '22023';
  end if;
  if v_active > 0 and p_choice is null then
    raise exception 'Cette fiche a % relance(s) de prospection en cours : indiquez si elles s''arrêtent ou continuent.', v_active
      using errcode = '22023';
  end if;
  return coalesce(p_choice, 'stop') = 'stop';
end;
$$;

-- Prochaine action facultative : p_next = { task: { title, due_date, person_id? } }. Renvoie la tâche créée.
create or replace function public.company_next_task(p_company uuid, p_next jsonb)
returns uuid
language plpgsql
as $$
declare
  t jsonb := p_next -> 'task';
  v_title text;
  v_due date;
begin
  if t is null or jsonb_typeof(t) <> 'object' then return null; end if;
  v_title := btrim(coalesce(t ->> 'title', ''));
  v_due := nullif(t ->> 'due_date', '')::date;
  if v_title = '' then raise exception 'Indiquez la prochaine action, ou décochez-la.' using errcode = '22023'; end if;
  if char_length(v_title) > 300 then raise exception 'Prochaine action trop longue (300 caractères au plus).' using errcode = '22023'; end if;
  if v_due is null then raise exception 'Indiquez la date de la prochaine action.' using errcode = '22023'; end if;
  return (public.create_task(p_company, v_title, v_due, nullif(t ->> 'person_id', '')::uuid, null) ->> 'id')::uuid;
end;
$$;

-- « Ajouter à une pipeline » : place la fiche (même fiche, aucune copie) dans l'étape choisie, ou la déplace si
-- elle est déjà dans une pipeline. Une opportunité gagnée ou perdue reste clôturée (refus de move_company).
create or replace function public.company_add_to_pipeline(
  p_company uuid,
  p_stage uuid,
  p_followups text default null,
  p_next jsonb default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  c public.companies;
  v_stop boolean;
  v_move jsonb;
  v_task uuid;
  v_stage public.stages;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('company', p_company, 'stage', p_stage, 'followups', p_followups, 'next', p_next));
  if v_prev is not null then return v_prev; end if;

  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if p_stage is null then raise exception 'Choisissez la pipeline et l''étape.' using errcode = '22023'; end if;
  select * into v_stage from public.stages where id = p_stage;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  if c.deal_status = 'won' then
    raise exception 'Cette fiche est déjà cliente : pour une nouvelle mission, utilisez « Nouvelle opportunité » sur la fiche.' using errcode = 'P0001';
  end if;

  v_stop := public.company_followups_choice(p_company, p_followups);
  v_move := public.move_company(p_company, p_stage, v_stop, null);
  v_task := public.company_next_task(p_company, p_next);

  return public.idem_put(p_idempotency_key, 'company_add_to_pipeline', jsonb_build_object(
    'status', v_move ->> 'status', 'stopped_followups', coalesce((v_move ->> 'stopped_followups')::int, 0),
    'kept_followups', case when v_stop then 0 else public.company_active_followups(p_company) end,
    'pipeline_id', v_stage.pipeline_id, 'stage_id', v_stage.id, 'task_id', v_task));
end;
$$;

-- « Passer en client » : raccourci du parcours Prospection → Pipeline → Vente, même résultat final.
-- 1. hors pipeline : la fiche entre dans l'étape choisie (move_company), comme dans le parcours normal ;
-- 2. sale_confirm (p_sale = mêmes données que « Marquer comme gagné ») : fiche Gagné, vente, revenu, projet
--    « à préparer » et sa préparation d'onboarding (déclencheur existant) ;
-- 3. relances : arrêtées ou conservées selon votre choix ; 4. prochaine action facultative.
create or replace function public.company_make_client(
  p_company uuid,
  p_stage uuid default null,
  p_followups text default null,
  p_sale jsonb default '{}'::jsonb,
  p_next jsonb default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  c public.companies;
  v_stop boolean;
  v_stopped int := 0;
  v_moved boolean := false;
  v_sale jsonb;
  v_task uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('company', p_company, 'stage', p_stage, 'followups', p_followups, 'sale', p_sale, 'next', p_next));
  if v_prev is not null then return v_prev; end if;

  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.deal_status = 'won' then
    raise exception 'Cette fiche est déjà cliente.' using errcode = 'P0001';
  end if;
  if c.deal_status = 'lost' then
    raise exception 'Opportunité perdue : rouvrez-la depuis la fiche avant de la passer en client.' using errcode = 'P0001';
  end if;
  if c.pipeline_id is null and p_stage is null then
    raise exception 'Choisissez la pipeline et l''étape par lesquelles passe la vente.' using errcode = '22023';
  end if;

  v_stop := public.company_followups_choice(p_company, p_followups);

  -- 1. la vente passe par une pipeline, comme dans le parcours normal
  if p_stage is not null and p_stage is distinct from c.stage_id then
    v_stopped := coalesce((public.move_company(p_company, p_stage, v_stop, null) ->> 'stopped_followups')::int, 0);
    v_moved := true;
  end if;
  -- déjà dans une pipeline : les relances encore en cours suivent le même choix
  if v_stop and not v_moved then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null, stop_reason = 'Passage en client'
     where company_id = p_company and status in ('a_contacter', 'en_cours', 'a_repondu');
    get diagnostics v_stopped = row_count;
    if v_stopped > 0 then
      perform public.log_event(p_company, 'prospecting', v_stopped || ' relance(s) de prospection arrêtée(s) suite au passage en client');
    end if;
  end if;

  -- 2. exactement « Marquer comme gagné »
  v_sale := public.sale_confirm(p_company, coalesce(p_sale, '{}'::jsonb), null);

  -- 4. la prochaine chose à faire
  v_task := public.company_next_task(p_company, p_next);

  return public.idem_put(p_idempotency_key, 'company_make_client', v_sale || jsonb_build_object(
    'moved', v_moved, 'stopped_followups', v_stopped,
    'kept_followups', case when v_stop then 0 else public.company_active_followups(p_company) end,
    'task_id', v_task));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.company_active_followups(uuid)', 'public.company_followups_choice(uuid, text)',
    'public.company_next_task(uuid, jsonb)',
    'public.company_add_to_pipeline(uuid, uuid, text, jsonb, text)',
    'public.company_make_client(uuid, uuid, text, jsonb, jsonb, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
