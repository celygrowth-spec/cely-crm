-- Audit, lot 1 — ventes protégées (C01, C03, C10, C11, Q05, Q11, K10). Migration additive : aucune donnée réelle
-- n'est modifiée ; les ventes existantes deviennent le cycle 1 de leur fiche, avec tous leurs liens.
--
--  C11  Une clé d'idempotence est liée à l'opération qui l'a utilisée (et, si fourni, à ses paramètres) :
--       réutilisée ailleurs ou avec d'autres paramètres, elle produit une erreur explicite.
--  C01  Une fiche gagnée ou perdue ne change plus d'étape ni de pipeline (sélecteur, « Hors pipeline », campagne,
--       Claude) : la base le refuse ; seule « Rouvrir l'opportunité » (ou « Nouvelle opportunité ») la rouvre.
--  Q05  Une vente par cycle commercial : un client qui revient a une nouvelle vente et une nouvelle mission ; la
--       fiche garde une seule opportunité active et l'accès à ses ventes passées.
--  C10  Un revenu supprimé n'est plus jamais renvoyé ; un revenu lié à une vente ne se supprime pas (on l'arrête).
--  C03  Rouvrir ou perdre une vente qui a un projet, un revenu ou des accès client applique vos décisions
--       (projet, échéances, portail) en une seule opération ; sans décision, la base refuse.
--  Q11  Ventes ne fait plus reculer un projet en cours sans confirmation explicite.
--  K10  L'état de préparation de l'onboarding a une seule source : project_onboarding (lue par Ventes et Projets).

-- ===========================================================================
-- C11 — idempotence : portée (opération appelante) et paramètres
-- ===========================================================================
alter table public.idempotency_keys
  add column if not exists caller text,
  add column if not exists fingerprint text;

-- Opération qui utilise la clé : première fonction de la pile qui n'est pas un utilitaire d'idempotence.
create or replace function public.idem_caller()
returns text
language plpgsql
as $$
declare v_ctx text; v_name text;
begin
  get diagnostics v_ctx = pg_context;
  for v_name in select (regexp_match(l, 'PL/pgSQL function (?:public\.)?([a-z0-9_]+)\('))[1] from regexp_split_to_table(v_ctx, E'\n') with ordinality as t(l, n) order by n
  loop
    if v_name is not null and v_name not in ('idem_caller', 'idem_get', 'idem_begin', 'idem_put', 'lock_keys') then return v_name; end if;
  end loop;
  return null;
end;
$$;

create or replace function public.idem_get(p_key text)
returns jsonb
language plpgsql
as $$
declare r public.idempotency_keys;
begin
  if p_key is null then return null; end if;
  perform public.lock_keys(array['idem:' || p_key]);
  select * into r from public.idempotency_keys where key = p_key;
  if r.key is null then return null; end if;
  if r.caller is not null and r.caller is distinct from public.idem_caller() then
    raise exception 'Clé de requête déjà utilisée par une autre opération (%) : réessayez avec une nouvelle clé.', r.caller using errcode = '22023';
  end if;
  return r.result;
end;
$$;

-- Comme idem_get, avec les paramètres : une même clé avec d'autres paramètres est une erreur explicite.
create or replace function public.idem_begin(p_key text, p_params jsonb)
returns jsonb
language plpgsql
as $$
declare r public.idempotency_keys; v_fp text := md5(coalesce(p_params, 'null'::jsonb)::text);
begin
  if p_key is null then return null; end if;
  perform public.lock_keys(array['idem:' || p_key]);
  perform set_config('cely.idem_fingerprint', v_fp, true);
  select * into r from public.idempotency_keys where key = p_key;
  if r.key is null then return null; end if;
  if r.caller is not null and r.caller is distinct from public.idem_caller() then
    raise exception 'Clé de requête déjà utilisée par une autre opération (%) : réessayez avec une nouvelle clé.', r.caller using errcode = '22023';
  end if;
  if r.fingerprint is not null and r.fingerprint <> v_fp then
    raise exception 'Cette requête a déjà été envoyée avec d''autres informations : rechargez avant de réessayer.' using errcode = '22023';
  end if;
  return r.result;
end;
$$;

create or replace function public.idem_put(p_key text, p_scope text, p_result jsonb)
returns jsonb
language plpgsql
as $$
begin
  if p_key is not null then
    insert into public.idempotency_keys (key, scope, result, caller, fingerprint)
    values (p_key, p_scope, p_result, public.idem_caller(), nullif(current_setting('cely.idem_fingerprint', true), ''))
    on conflict (key) do nothing;
    perform set_config('cely.idem_fingerprint', '', true);
  end if;
  return p_result;
end;
$$;

-- ===========================================================================
-- C01 — une fiche clôturée ne change pas d'étape sans réouverture explicite
-- ===========================================================================
create or replace function public.tg_companies_closed_guard()
returns trigger
language plpgsql
as $$
begin
  if old.deal_status <> 'open' and new.deal_status = old.deal_status
     and (new.stage_id is distinct from old.stage_id or new.pipeline_id is distinct from old.pipeline_id)
     and new.merged_into_id is null then
    raise exception 'Opportunité % : utilisez « Rouvrir l''opportunité » avant de changer d''étape.',
      case old.deal_status when 'won' then 'gagnée' else 'perdue' end using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger companies_closed_guard before update of stage_id, pipeline_id on public.companies
  for each row execute function public.tg_companies_closed_guard();

-- Déplace (ou retire) une fiche OUVERTE. Une fiche gagnée ou perdue est refusée avec une explication
-- (interface, campagne « Intéressé + étape », Claude) : jamais de réouverture implicite.
create or replace function public.move_company(
  p_company uuid,
  p_stage uuid,
  p_stop_followups boolean default true,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  c public.companies;
  v_to public.stages;
  v_to_pipeline public.pipelines;
  v_from_stage text;
  v_from_pipeline text;
  v_stopped int := 0;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('company', p_company, 'stage', p_stage, 'stop', p_stop_followups));
  if v_prev is not null then return v_prev; end if;

  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;

  if c.deal_status <> 'open' then
    raise exception 'Opportunité % : elle reste clôturée. Pour la déplacer, utilisez d''abord « Rouvrir l''opportunité » sur la fiche.',
      case c.deal_status when 'won' then 'gagnée' else 'perdue' end using errcode = 'P0001';
  end if;

  if p_stage is not null then
    select * into v_to from public.stages where id = p_stage;
    if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
    select * into v_to_pipeline from public.pipelines where id = v_to.pipeline_id;
  end if;

  if c.stage_id is not distinct from p_stage then
    return jsonb_build_object('status', 'unchanged');
  end if;

  select s.name, p.name into v_from_stage, v_from_pipeline
    from public.stages s join public.pipelines p on p.id = s.pipeline_id where s.id = c.stage_id;

  update public.companies
     set pipeline_id = v_to.pipeline_id, stage_id = v_to.id,
         prospect_status = case when p_stage is not null and prospect_status in ('nouveau','contacte','en_discussion')
                                then 'qualifie' else prospect_status end
   where id = c.id;

  -- l'entrée dans un pipeline arrête par défaut les relances de prospection actives
  if p_stage is not null and p_stop_followups then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null, stop_reason = 'Entrée dans le pipeline ' || v_to_pipeline.name
     where company_id = c.id and status in ('a_contacter','en_cours','a_repondu');
    get diagnostics v_stopped = row_count;
  end if;

  perform public.log_event(c.id, 'stage_change',
    case when p_stage is null then 'Retirée du pipeline ' || coalesce(v_from_pipeline, '')
         when c.pipeline_id is distinct from v_to.pipeline_id and c.pipeline_id is not null
           then 'Transférée de ' || v_from_pipeline || ' › ' || v_from_stage || ' vers ' || v_to_pipeline.name || ' › ' || v_to.name
         when c.pipeline_id is null then 'Entrée dans ' || v_to_pipeline.name || ' › ' || v_to.name
         else v_to_pipeline.name || ' : ' || coalesce(v_from_stage, '—') || ' → ' || v_to.name end,
    jsonb_build_object('from_pipeline_id', c.pipeline_id, 'from_pipeline', v_from_pipeline,
                       'from_stage_id', c.stage_id, 'from_stage', v_from_stage,
                       'to_pipeline_id', v_to.pipeline_id, 'to_pipeline', v_to_pipeline.name,
                       'to_stage_id', v_to.id, 'to_stage', v_to.name,
                       'stopped_followups', v_stopped));

  if v_stopped > 0 then
    perform public.log_event(c.id, 'prospecting',
      v_stopped || ' relance(s) de prospection arrêtée(s) suite à l''entrée dans le pipeline');
  end if;

  return public.idem_put(p_idempotency_key, 'move_company',
    jsonb_build_object('status', 'moved', 'stopped_followups', v_stopped));
end;
$$;

-- ===========================================================================
-- Q05 — une vente par cycle commercial
-- ===========================================================================
alter table public.sales drop constraint if exists sales_company_id_key;
alter table public.sales add column if not exists cycle integer not null default 1 check (cycle >= 1);
alter table public.sales add column if not exists ended_at timestamptz;
-- projet de la vente supprimé : jamais recréé en silence (une recréation demande votre choix)
alter table public.sales add column if not exists project_removed_at timestamptz;
alter table public.sales drop constraint if exists sales_state_check;
alter table public.sales add constraint sales_state_check check (state in ('won', 'reopened', 'lost', 'completed'));
create unique index if not exists sales_company_cycle_idx on public.sales (company_id, cycle);
-- une seule vente active (gagnée ou rouverte) par fiche
create unique index if not exists sales_one_active_idx on public.sales (company_id) where state in ('won', 'reopened');
comment on column public.sales.state is 'won : gagnée, suivie ; reopened : opportunité rouverte (liens conservés) ; lost : cycle perdu après réouverture ; completed : cycle terminé, remplacé par une nouvelle opportunité.';

create or replace function public.tg_sales_project_removed()
returns trigger
language plpgsql
as $$
begin
  update public.sales set project_removed_at = now() where project_id = old.id;
  return old;
end;
$$;
create trigger sales_project_removed before delete on public.projects
  for each row execute function public.tg_sales_project_removed();

-- L'issue commerciale reste la vérité : la vente active suit la fiche (gagnée ↔ rouverte ; perdue clôt le cycle).
create or replace function public.tg_sales_follow_deal()
returns trigger
language plpgsql
as $$
begin
  if new.deal_status = 'won' and old.deal_status <> 'won' then
    update public.sales set state = 'won', ended_at = null where company_id = new.id and state = 'reopened';
  elsif old.deal_status = 'won' and new.deal_status = 'open' then
    update public.sales set state = 'reopened' where company_id = new.id and state = 'won';
  elsif new.deal_status = 'lost' and old.deal_status <> 'lost' then
    update public.sales set state = 'lost', ended_at = now() where company_id = new.id and state in ('won', 'reopened');
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- C10 — un revenu lié à une vente ne se supprime pas (on l'arrête)
-- ===========================================================================
create or replace function public.tg_finance_mission_sale_guard()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.sales where mission_id = old.id) then
    raise exception 'Ce revenu est lié à une vente : arrêtez ses échéances futures plutôt que de le supprimer.' using errcode = 'P0001';
  end if;
  return old;
end;
$$;
create trigger finance_mission_sale_guard before delete on public.finance_missions
  for each row execute function public.tg_finance_mission_sale_guard();

-- ===========================================================================
-- « Marquer comme gagné » : cycle actif retrouvé, nouveau cycle sinon ; références vérifiées ; idempotence
-- avec paramètres. Une fiche déjà gagnée garde sa clôture ; aucun lien existant n'est remplacé ni dupliqué.
-- p_data : { closed_on, signed_on?, documents_ready?, revenue?: {mode, amount?, date?, end_date?},
--            link_mission_id?, link_invoice_id?, link_project_id?, project_name?, create_project? }
-- ===========================================================================
create or replace function public.sale_confirm(p_company uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  c public.companies;
  s public.sales;
  v_today date := public.today_paris();
  v_closed date := coalesce(nullif(p_data ->> 'closed_on', '')::date, public.today_paris());
  v_signed date := nullif(p_data ->> 'signed_on', '')::date;
  v_rev jsonb := coalesce(p_data -> 'revenue', '{}'::jsonb);
  v_mode text := coalesce(nullif(v_rev ->> 'mode', ''), 'plus_tard');
  v_amount numeric(12,2) := nullif(v_rev ->> 'amount', '')::numeric;
  v_rev_date date := nullif(v_rev ->> 'date', '')::date;
  v_rev_end date := nullif(v_rev ->> 'end_date', '')::date;
  v_link_mission uuid := nullif(p_data ->> 'link_mission_id', '')::uuid;
  v_link_invoice uuid := nullif(p_data ->> 'link_invoice_id', '')::uuid;
  v_link_project uuid := nullif(p_data ->> 'link_project_id', '')::uuid;
  v_inv public.finance_invoices;
  v_mission uuid;
  v_project uuid;
  v_people uuid[];
  v_created jsonb := '{}'::jsonb;
  v_was_open boolean;
  m public.finance_missions;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('company', p_company, 'data', p_data));
  if v_prev is not null then return v_prev; end if;

  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if v_mode not in ('mensuel', 'ponctuel', 'plus_tard') then raise exception 'Type de revenu invalide' using errcode = '22023'; end if;
  if v_closed > v_today then raise exception 'La date de clôture ne peut pas être dans le futur.' using errcode = '22023'; end if;
  if v_signed is not null and v_signed > v_today then raise exception 'La date de signature ne peut pas être dans le futur.' using errcode = '22023'; end if;
  if v_mode <> 'plus_tard' and v_link_mission is null then
    if v_amount is null or v_amount <= 0 then raise exception 'Indiquez un montant positif, ou choisissez « Renseigner plus tard ».' using errcode = '22023'; end if;
    if v_rev_date is null then
      raise exception '%', case v_mode when 'mensuel' then 'Indiquez la date de début du revenu mensuel.' else 'Indiquez la date d''encaissement prévue.' end using errcode = '22023';
    end if;
    if v_rev_end is not null and v_rev_end < v_rev_date then raise exception 'La date de fin précède la date de début.' using errcode = '22023'; end if;
  end if;

  -- 1. la fiche passe Gagné ; une fiche déjà gagnée garde sa clôture
  if c.deal_status = 'lost' then raise exception 'Opportunité perdue : rouvrez-la avant de la marquer gagnée.' using errcode = '22023'; end if;
  v_was_open := c.deal_status = 'open';
  if v_was_open then
    perform public.set_deal_status(p_company, 'won', null, v_closed, case when v_mode = 'ponctuel' then v_amount end);
  end if;

  -- 2. la vente active (gagnée ou rouverte) de ce cycle, sinon un nouveau cycle
  select * into s from public.sales where company_id = p_company and state in ('won', 'reopened') for update;
  if s.id is null then
    insert into public.sales (company_id, cycle, state, closed_on, signed_on, revenue_mode, documents_ready)
    values (p_company, coalesce((select max(cycle) from public.sales where company_id = p_company), 0) + 1, 'won',
            case when not v_was_open and c.deal_closed_at is not null then (c.deal_closed_at at time zone 'Europe/Paris')::date else v_closed end,
            v_signed, v_mode, coalesce((p_data ->> 'documents_ready')::boolean, false))
    returning * into s;
    v_created := v_created || '{"sale": true}';
  else
    update public.sales
       set state = 'won', ended_at = null,
           closed_on = case when v_was_open then v_closed else closed_on end,
           signed_on = coalesce(v_signed, signed_on),
           documents_ready = case when p_data ? 'documents_ready' then (p_data ->> 'documents_ready')::boolean else documents_ready end
     where id = s.id
    returning * into s;
  end if;

  -- 3. le revenu : lier l'existant, ou créer le revenu prévu ; une référence disparue n'est jamais renvoyée
  v_mission := s.mission_id;
  if v_mission is not null and not exists (select 1 from public.finance_missions where id = v_mission) then v_mission := null; end if;
  if v_link_mission is not null then
    select * into m from public.finance_missions where id = v_link_mission and company_id = p_company;
    if not found then raise exception 'Ce revenu n''appartient pas à cette fiche.' using errcode = '22023'; end if;
    if exists (select 1 from public.sales x where x.mission_id = v_link_mission and x.id <> s.id) then
      raise exception 'Ce revenu est déjà lié à une autre vente.' using errcode = '22023';
    end if;
    if v_mission is not null and v_mission <> v_link_mission then
      raise exception 'Cette vente a déjà un revenu lié.' using errcode = '22023';
    end if;
    v_mission := v_link_mission;
    update public.sales set mission_id = v_mission, revenue_mode = case when m.kind = 'recurrent' then 'mensuel' else 'ponctuel' end where id = s.id;
  elsif v_mission is null and v_mode <> 'plus_tard' then
    -- la vente est verrouillée (for update) : pas de doublon possible, pas besoin de clé fixe
    v_mission := (public.finance_add_revenue(jsonb_build_object(
      'company_id', p_company, 'label', left('Vente ' || c.name || case when s.cycle > 1 then ' (' || s.cycle || ')' else '' end, 200),
      'kind', v_mode, 'amount', v_amount, 'date', v_rev_date, 'end_date', v_rev_end), null) ->> 'id')::uuid;
    update public.sales set mission_id = v_mission, revenue_mode = v_mode where id = s.id;
    v_created := v_created || '{"revenue": true}';
  end if;

  -- facture déjà enregistrée : rattachée au revenu de la vente (créé depuis elle s'il n'y en a pas)
  if v_link_invoice is not null then
    select * into v_inv from public.finance_invoices where id = v_link_invoice and company_id = p_company and kind = 'facture' and cancelled_at is null for update;
    if not found then raise exception 'Facture introuvable pour cette fiche.' using errcode = '22023'; end if;
    if v_inv.mission_id is not null and v_inv.mission_id is distinct from v_mission then
      if v_mission is null and not exists (select 1 from public.sales x where x.mission_id = v_inv.mission_id) then
        v_mission := v_inv.mission_id;
        update public.sales set mission_id = v_mission,
               revenue_mode = (select case when kind = 'recurrent' then 'mensuel' else 'ponctuel' end from public.finance_missions where id = v_mission)
         where id = s.id;
      else
        raise exception 'Cette facture est déjà rattachée à un autre revenu.' using errcode = '22023';
      end if;
    end if;
    if v_mission is null then
      v_mission := (public.finance_add_revenue(jsonb_build_object(
        'company_id', p_company, 'label', left('Vente ' || c.name, 200), 'kind', 'ponctuel', 'amount', v_inv.amount_ht,
        'date', coalesce(v_inv.due_date, v_inv.issue_date)), null) ->> 'id')::uuid;
      update public.sales set mission_id = v_mission, revenue_mode = 'ponctuel' where id = s.id;
      v_created := v_created || '{"revenue": true}';
    end if;
    update public.finance_invoices set mission_id = v_mission,
           forecast_due_date = coalesce(forecast_due_date, (select coalesce(next_due_date, start_date) from public.finance_missions where id = v_mission and kind = 'ponctuel'))
     where id = v_inv.id;
  end if;

  -- 4. le projet : lier un projet en cours ou à préparer, sinon le créer une fois ; jamais un projet terminé
  --    réutilisé automatiquement ; un projet supprimé n'est recréé que sur demande explicite (create_project)
  select * into s from public.sales where id = s.id;
  v_project := s.project_id;
  if v_project is null and v_link_project is not null then
    if not exists (select 1 from public.projects where id = v_link_project and company_id = p_company) then
      raise exception 'Ce projet n''appartient pas à cette fiche.' using errcode = '22023';
    end if;
    -- jamais un projet terminé ou archivé, ni celui d'une autre vente (même passée) : un nouveau gain = une nouvelle mission
    if exists (select 1 from public.projects where id = v_link_project and status in ('termine', 'archive')) then
      raise exception 'Ce projet est terminé ou archivé : un nouveau gain crée une nouvelle mission.' using errcode = '22023';
    end if;
    if exists (select 1 from public.sales x where x.project_id = v_link_project and x.id <> s.id) then
      raise exception 'Ce projet appartient à une autre vente de cette fiche.' using errcode = '22023';
    end if;
    v_project := v_link_project;
    update public.sales set project_id = v_project, project_removed_at = null where id = s.id;
  elsif v_project is null and (s.project_removed_at is null or coalesce((p_data ->> 'create_project')::boolean, false)) then
    select array_agg(p.id) into v_people from (
      select id from public.people where company_id = p_company order by is_primary desc, created_at limit 1) p;
    select * into m from public.finance_missions where id = v_mission;
    v_project := public.project_create(jsonb_build_object(
      'company_id', p_company,
      'name', left(coalesce(nullif(btrim(p_data ->> 'project_name'), ''), 'Mission ' || c.name), 160),
      'start_date', coalesce(m.start_date, v_rev_date),
      'end_date', case when m.kind = 'recurrent' then m.end_date else null end,
      'status', 'a_preparer'), coalesce(v_people, '{}'));
    update public.sales set project_id = v_project, project_removed_at = null where id = s.id;
    v_created := v_created || '{"project": true}';
  end if;

  return public.idem_put(p_idempotency_key, 'sale_confirm', jsonb_build_object(
    'sale_id', s.id, 'cycle', s.cycle, 'project_id', v_project, 'mission_id', v_mission, 'created', v_created,
    'project_removed', v_project is null and s.project_removed_at is not null));
end;
$$;

-- ===========================================================================
-- C03 — effets d'une réouverture ou d'une perte : décisions explicites, une seule opération
-- ===========================================================================

-- Ce qui est lié à la vente active d'une fiche, pour décider (projet, revenu, accès client).
create or replace function public.deal_links(p_company uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'sale_id', s.id, 'cycle', s.cycle, 'state', s.state,
    'project', case when p.id is not null then jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'published', p.portal_published) end,
    'mission', case when m.id is not null then jsonb_build_object('id', m.id, 'label', m.label, 'kind', m.kind, 'amount', m.amount, 'status', m.status,
      'end_date', m.end_date, 'invoiced', exists (select 1 from public.finance_invoices i where i.mission_id = m.id and i.cancelled_at is null)) end,
    'portal_people', coalesce((
      select jsonb_agg(jsonb_build_object('person_id', pe.id, 'name', btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')),
               'other_projects', (select count(*) from public.project_members pm2 join public.projects p2 on p2.id = pm2.project_id
                                   where pm2.person_id = pe.id and p2.id <> p.id and p2.status not in ('termine', 'archive'))))
        from public.project_members pm join public.people pe on pe.id = pm.person_id
        join public.portal_accesses a on a.person_id = pe.id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
       where pm.project_id = p.id), '[]'::jsonb))
    from public.sales s
    left join public.projects p on p.id = s.project_id
    left join public.finance_missions m on m.id = s.mission_id
   where s.company_id = p_company and s.state in ('won', 'reopened')
$$;

-- Une vente a-t-elle des liens qui demandent une décision ? (projet non terminé, revenu actif, accès client)
create or replace function public.deal_links_need_decision(p_company uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.sales s
      left join public.projects p on p.id = s.project_id
      left join public.finance_missions m on m.id = s.mission_id
     where s.company_id = p_company and s.state in ('won', 'reopened')
       and ((p.id is not null and p.status not in ('termine', 'archive')) or (m.id is not null and m.status <> 'termine')))
$$;

-- Gagné / perdu / rouvert : la fiche garde son dernier pipeline et sa dernière étape (redéfinition complète).
-- Rouvrir ou perdre une vente qui a encore un projet ou un revenu actif passe par deal_transition (décisions).
create or replace function public.set_deal_status(
  p_company uuid,
  p_status text,
  p_lost_reason text default null,
  p_closed_on date default null,
  p_amount numeric default null)
returns jsonb
language plpgsql
as $$
declare
  c public.companies;
  v_today date := (now() at time zone 'Europe/Paris')::date;
  v_closed timestamptz;
  v_stage public.stages;
  v_pipeline text;
  v_projects text;
  v_reason text := nullif(btrim(coalesce(p_lost_reason, '')), '');
  v_text text;
begin
  perform public.assert_owner();
  if p_status not in ('open','won','lost') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.pipeline_id is null then
    raise exception 'La fiche doit être dans un pipeline pour être marquée gagnée ou perdue.' using errcode = '22023';
  end if;
  if c.deal_status = p_status then
    return jsonb_build_object('status', 'unchanged', 'deal_status', c.deal_status);
  end if;
  if p_status <> 'open' and c.deal_status <> 'open' then
    raise exception 'Opportunité déjà clôturée : rouvrez-la d''abord.' using errcode = '22023';
  end if;
  if p_status in ('open', 'lost') and coalesce(current_setting('cely.deal_effects', true), '') <> '1'
     and public.deal_links_need_decision(p_company) then
    raise exception 'Cette vente a un projet ou un revenu actif : choisissez ce qu''ils deviennent (projet, échéances, accès client) avant de %.',
      case p_status when 'open' then 'la rouvrir' else 'la marquer perdue' end using errcode = 'P0001';
  end if;
  if p_amount is not null and p_amount < 0 then raise exception 'Montant invalide' using errcode = '22023'; end if;
  if v_reason is not null and char_length(v_reason) > 500 then raise exception 'Motif trop long (500 caractères au plus)' using errcode = '22023'; end if;

  select p.name into v_pipeline from public.pipelines p where p.id = c.pipeline_id;

  if p_status = 'won' then
    if p_closed_on is not null and p_closed_on > v_today then
      raise exception 'La date de signature ne peut pas être dans le futur.' using errcode = '22023';
    end if;
    v_closed := case when p_closed_on is null or p_closed_on = v_today then now()
                     else (p_closed_on + time '12:00') at time zone 'Europe/Paris' end;
    update public.companies
       set deal_status = 'won', deal_closed_at = v_closed, amount = coalesce(p_amount, amount)
     where id = c.id;
    v_text := 'Opportunité gagnée : signée le ' || to_char((v_closed at time zone 'Europe/Paris')::date, 'DD/MM/YYYY')
           || coalesce(' · ' || regexp_replace(replace(to_char(coalesce(p_amount, c.amount), 'FM999999999990.00'), '.', ','), ',00$', '') || ' €', '');

  elsif p_status = 'lost' then
    v_closed := now();
    update public.companies
       set deal_status = 'lost', deal_closed_at = v_closed, lost_reason = v_reason
     where id = c.id;
    v_text := 'Opportunité perdue' || coalesce(' : ' || v_reason, '');

  else
    select * into v_stage from public.stages where id = c.stage_id;
    if not found then
      select * into v_stage from public.stages where pipeline_id = c.pipeline_id order by position limit 1;
    end if;
    select string_agg(pr.name, ', ' order by pr.created_at) into v_projects
      from public.projects pr where pr.company_id = c.id and pr.status <> 'archive';
    -- la réouverture explicite est la seule à pouvoir changer l'étape d'une fiche clôturée (même instruction)
    update public.companies
       set deal_status = 'open', deal_closed_at = null, stage_id = coalesce(v_stage.id, stage_id)
     where id = c.id;
    v_text := 'Opportunité rouverte : était ' || case c.deal_status when 'won' then 'gagnée' else 'perdue' end
           || coalesce(' · retour à l''étape ' || v_pipeline || ' › ' || v_stage.name, '')
           || coalesce(' · projet conservé : ' || v_projects, '');
  end if;

  perform public.log_event(c.id, 'deal_status', v_text,
    jsonb_build_object(
      'from', c.deal_status, 'to', p_status,
      'closed_at', v_closed,
      'amount', case when p_status = 'won' then coalesce(p_amount, c.amount) end,
      'lost_reason', case when p_status = 'lost' then v_reason end,
      'pipeline', v_pipeline,
      'stage', coalesce(v_stage.name, (select s.name from public.stages s where s.id = c.stage_id)),
      'projects', v_projects));

  return jsonb_build_object(
    'status', 'ok', 'deal_status', p_status, 'deal_closed_at', v_closed,
    'stage_id', coalesce(v_stage.id, c.stage_id), 'projects', v_projects);
end;
$$;

-- Rouvrir ou perdre, avec les décisions sur les éléments liés, en une seule opération (tout ou rien).
-- p_options : { project?: 'continue'|'en_attente'|'archive', revenue?: 'continue'|'stop', revenue_stop_on?: date,
--               portal?: 'keep'|'revoke', lost_reason?: text }
-- Sans décision alors qu'un projet ou un revenu est actif : refus explicite (rien n'est changé).
create or replace function public.deal_transition(p_company uuid, p_status text, p_options jsonb default '{}', p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_links jsonb;
  v_project uuid;
  v_mission public.finance_missions;
  v_opt jsonb := coalesce(p_options, '{}'::jsonb);
  v_project_choice text := v_opt ->> 'project';
  v_revenue_choice text := v_opt ->> 'revenue';
  v_portal_choice text := coalesce(v_opt ->> 'portal', 'keep');
  v_stop date := coalesce(nullif(v_opt ->> 'revenue_stop_on', '')::date, public.today_paris());
  v_effects jsonb := '[]'::jsonb;
  v_revoked int := 0;
  v_skipped int := 0;
  v_res jsonb;
  r record;
begin
  perform public.assert_owner();
  if p_status not in ('open', 'lost') then raise exception 'Transition invalide' using errcode = '22023'; end if;
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('company', p_company, 'status', p_status, 'options', v_opt));
  if v_prev is not null then return v_prev; end if;
  perform 1 from public.companies where id = p_company for update;

  v_links := public.deal_links(p_company);
  if public.deal_links_need_decision(p_company) then
    if (v_links -> 'project') is not null and (v_links -> 'project' ->> 'status') not in ('termine', 'archive')
       and coalesce(v_project_choice, '') not in ('continue', 'en_attente', 'archive') then
      raise exception 'Choisissez ce que devient le projet « % » : continuer, mettre en attente ou archiver.', v_links -> 'project' ->> 'name' using errcode = 'P0001';
    end if;
    if (v_links -> 'mission') is not null and (v_links -> 'mission' ->> 'status') <> 'termine'
       and coalesce(v_revenue_choice, '') not in ('continue', 'stop') then
      raise exception 'Choisissez si les échéances futures du revenu « % » continuent ou s''arrêtent.', v_links -> 'mission' ->> 'label' using errcode = 'P0001';
    end if;
  end if;
  if v_portal_choice not in ('keep', 'revoke') then raise exception 'Choix du portail invalide' using errcode = '22023'; end if;

  -- projet
  v_project := nullif(v_links -> 'project' ->> 'id', '')::uuid;
  if v_project is not null and v_project_choice in ('en_attente', 'archive') then
    update public.projects set status = v_project_choice, archived_at = case when v_project_choice = 'archive' then now() else archived_at end
     where id = v_project and status not in ('termine', 'archive');
    v_effects := v_effects || jsonb_build_array(case v_project_choice when 'archive' then 'Projet archivé' else 'Projet mis en attente' end);
  end if;

  -- revenu : les factures et règlements gardent leur historique ; seules les échéances futures s'arrêtent
  select * into v_mission from public.finance_missions where id = nullif(v_links -> 'mission' ->> 'id', '')::uuid for update;
  if v_mission.id is not null and v_revenue_choice = 'stop' and v_mission.status <> 'termine' then
    if v_mission.kind = 'recurrent' then
      if v_mission.start_date is not null and v_stop < v_mission.start_date then v_stop := v_mission.start_date; end if;
      update public.finance_missions set end_date = v_stop,
             status = case when v_stop <= public.today_paris() then 'termine' else status end
       where id = v_mission.id;
      v_effects := v_effects || jsonb_build_array('Revenu mensuel arrêté au ' || to_char(v_stop, 'DD/MM/YYYY'));
    else
      update public.finance_missions set status = 'termine' where id = v_mission.id;
      v_effects := v_effects || jsonb_build_array('Prévision du revenu ponctuel retirée');
    end if;
  end if;

  -- accès client : révoqués seulement pour les personnes sans autre projet actif
  if v_portal_choice = 'revoke' then
    for r in select (x ->> 'person_id')::uuid as person_id, (x ->> 'other_projects')::int as other from jsonb_array_elements(v_links -> 'portal_people') x loop
      if r.other = 0 then
        -- fonction du portail (droits et journal du portail) ; seuls les accès effectivement révoqués sont comptés
        perform public.portal_access_revoke(r.person_id);
        if exists (select 1 from public.portal_accesses where person_id = r.person_id and revoked_at is not null) then
          v_revoked := v_revoked + 1;
        end if;
      else
        v_skipped := v_skipped + 1;
      end if;
    end loop;
    if v_revoked > 0 then v_effects := v_effects || jsonb_build_array(v_revoked || ' accès client révoqué(s)'); end if;
  end if;

  perform set_config('cely.deal_effects', '1', true);
  v_res := public.set_deal_status(p_company, p_status, v_opt ->> 'lost_reason');
  perform set_config('cely.deal_effects', '', true);

  if jsonb_array_length(v_effects) > 0 then
    perform public.log_event(p_company, 'system',
      case p_status when 'open' then 'Réouverture' else 'Perte' end || ' : ' || (select string_agg(e, ' · ') from jsonb_array_elements_text(v_effects) e),
      jsonb_build_object('effects', v_effects, 'sale_id', v_links ->> 'sale_id'));
  end if;
  return public.idem_put(p_idempotency_key, 'deal_transition', v_res || jsonb_build_object(
    'effects', v_effects, 'portal_kept_other_projects', v_skipped));
end;
$$;

-- Client qui revient : la vente actuelle (gagnée) est terminée et une nouvelle opportunité s'ouvre sur la même
-- fiche. Le projet et le revenu précédents gardent leur historique ; le prochain « Gagné » crée un nouveau cycle.
create or replace function public.deal_new_opportunity(p_company uuid, p_stage uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  c public.companies;
  v_stage public.stages;
  v_sale uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_begin(p_idempotency_key, jsonb_build_object('company', p_company, 'stage', p_stage));
  if v_prev is not null then return v_prev; end if;
  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.deal_status = 'open' then raise exception 'Une opportunité est déjà ouverte sur cette fiche.' using errcode = '22023'; end if;
  select * into v_stage from public.stages where id = p_stage;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;

  update public.sales set state = 'completed', ended_at = now() where company_id = p_company and state in ('won', 'reopened')
  returning id into v_sale;
  perform set_config('cely.deal_effects', '1', true);
  update public.companies
     set deal_status = 'open', deal_closed_at = null, lost_reason = null, amount = null,
         pipeline_id = v_stage.pipeline_id, stage_id = v_stage.id
   where id = c.id;
  perform set_config('cely.deal_effects', '', true);
  perform public.log_event(c.id, 'deal_status',
    'Nouvelle opportunité : ' || (select name from public.pipelines where id = v_stage.pipeline_id) || ' › ' || v_stage.name
      || case when v_sale is not null then ' (la vente précédente reste dans Ventes › Gagnées)' else '' end,
    jsonb_build_object('from', c.deal_status, 'to', 'open', 'new_cycle', true, 'previous_sale_id', v_sale));
  return public.idem_put(p_idempotency_key, 'deal_new_opportunity', jsonb_build_object('status', 'ok', 'previous_sale_id', v_sale));
end;
$$;

-- ===========================================================================
-- Q11 — suivi après-vente : formalités (documents) ≠ préparation ≠ exécution (projet)
-- Faire reculer un projet en cours ou en attente demande une confirmation explicite (p_confirm).
-- ===========================================================================
drop function if exists public.sale_set_stage(uuid, text);
create or replace function public.sale_set_stage(p_sale uuid, p_stage text, p_confirm boolean default false)
returns jsonb
language plpgsql
as $$
declare s public.sales; v_project public.projects; v_label text; v_target text;
begin
  perform public.assert_owner();
  if p_stage not in ('devis_contrat', 'onboarding', 'en_mission', 'termine') then raise exception 'Étape de suivi invalide' using errcode = '22023'; end if;
  select * into s from public.sales where id = p_sale for update;
  if not found then raise exception 'Vente introuvable' using errcode = 'P0002'; end if;
  if s.state <> 'won' then raise exception 'Cette vente n''est pas en cours de suivi (rouverte, perdue ou terminée).' using errcode = '22023'; end if;
  select * into v_project from public.projects where id = s.project_id;
  if p_stage in ('en_mission', 'termine') and v_project.id is null then
    raise exception 'Aucun projet lié : créez ou liez le projet d''abord.' using errcode = '22023';
  end if;
  if p_stage in ('devis_contrat', 'onboarding') and v_project.status in ('en_cours', 'en_attente') and not p_confirm then
    raise exception 'Le projet « % » est %. Le repasser « à préparer » demande votre confirmation.',
      v_project.name, case v_project.status when 'en_cours' then 'en cours' else 'en attente' end using errcode = 'P0001';
  end if;
  update public.sales set documents_ready = p_stage <> 'devis_contrat' where id = s.id;
  v_target := case p_stage when 'en_mission' then 'en_cours' when 'termine' then 'termine' else 'a_preparer' end;
  if v_project.id is not null and v_project.status <> 'archive' and v_project.status is distinct from v_target then
    update public.projects set status = v_target where id = v_project.id;
  end if;
  v_label := case p_stage when 'devis_contrat' then 'Devis / Contrat' when 'onboarding' then 'Onboarding' when 'en_mission' then 'En mission' else 'Mission terminée' end;
  perform public.log_event(s.company_id, 'system', 'Suivi client : ' || v_label, jsonb_build_object('sale_id', s.id, 'stage', p_stage, 'project_id', s.project_id));
  return jsonb_build_object('sale_id', s.id, 'stage', p_stage);
end;
$$;

-- ===========================================================================
-- Vue des ventes : une ligne par cycle gagné (ou terminé), plus les fiches perdues et les anciens dossiers gagnés
-- sans vente. K10 : la préparation vient de project_onboarding_status (même état que Projets).
-- ===========================================================================
drop view if exists public.sales_overview;
create view public.sales_overview with (security_invoker = true) as
  with rows as (
    -- ventes (cycles) gagnées, en cours de suivi ou terminées
    select s.id as row_id, c.id as company_id, s.id as sale_id, s.cycle, s.state as sale_state,
           case when s.state = 'lost' then 'lost' else 'won' end as deal_status,
           s.closed_on, s.signed_on, s.revenue_mode, s.documents_ready, s.mission_id, s.project_id, s.project_removed_at
      from public.sales s join public.companies c on c.id = s.company_id
     where c.merged_into_id is null and s.state in ('won', 'completed')
    union all
    -- fiches perdues (avec la vente du cycle perdu s'il y en a une)
    select c.id, c.id, ls.id, ls.cycle, ls.state, 'lost',
           (c.deal_closed_at at time zone 'Europe/Paris')::date, ls.signed_on, ls.revenue_mode, ls.documents_ready, ls.mission_id, ls.project_id, ls.project_removed_at
      from public.companies c
      left join lateral (select * from public.sales x where x.company_id = c.id and x.state = 'lost' order by x.cycle desc limit 1) ls on true
     where c.merged_into_id is null and c.deal_status = 'lost'
    union all
    -- anciens dossiers gagnés sans vente enregistrée (aucune création automatique)
    select c.id, c.id, null, null, null, 'won',
           (c.deal_closed_at at time zone 'Europe/Paris')::date, null, null, null, null, null, null
      from public.companies c
     where c.merged_into_id is null and c.deal_status = 'won'
       and not exists (select 1 from public.sales x where x.company_id = c.id and x.state in ('won', 'reopened'))
  )
  select r.row_id,
         c.id as company_id,
         c.name,
         r.deal_status,
         c.deal_status as company_deal_status,
         c.deal_closed_at,
         r.closed_on,
         c.lost_reason,
         c.amount as deal_amount,
         c.archived_at,
         pl.name as pipeline_name,
         st.name as stage_name,
         pp.name as primary_person_name,
         r.sale_id,
         r.cycle,
         r.sale_state,
         r.signed_on,
         r.revenue_mode,
         r.documents_ready,
         r.project_removed_at,
         ob.status as prep_status,
         ob.open_required as prep_missing,
         ob.prep_error,
         mo.id as mission_id,
         mo.kind as mission_kind,
         mo.amount as mission_amount,
         mo.start_date as mission_start,
         mo.end_date as mission_end,
         mo.status as mission_status,
         mo.invoiced_ttc,
         mo.received,
         mo.remaining,
         pr.id as project_id,
         pr.name as project_name,
         pr.status as project_status,
         case when r.sale_id is null and r.deal_status = 'won' then lm.mission_id end as candidate_mission_id,
         case when r.sale_id is null and r.deal_status = 'won' then lp.project_id end as candidate_project_id,
         case
           when mo.id is null then 'a_renseigner'
           when mo.invoiced_ttc > 0 and mo.remaining <= 0 and mo.received > 0 then 'encaisse'
           when mo.invoiced_ttc > 0 then 'facture'
           else 'prevu'
         end as billing,
         case
           when r.deal_status <> 'won' then null
           when r.sale_state = 'completed' then 'termine'
           when pr.status in ('termine', 'archive') then 'termine'
           when pr.status in ('en_cours', 'en_attente') then 'en_mission'
           when r.sale_id is null and pr.id is null then null
           when r.sale_id is not null and not r.documents_ready then 'devis_contrat'
           else 'onboarding'
         end as stage
    from rows r
    join public.companies c on c.id = r.company_id
    left join public.pipelines pl on pl.id = c.pipeline_id
    left join public.stages st on st.id = c.stage_id
    left join lateral (
      select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as name
        from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1) pp on true
    left join lateral (
      select case when count(*) = 1 then min(m.id::text)::uuid end as mission_id
        from public.finance_missions m
       where m.company_id = c.id and not exists (select 1 from public.sales x where x.mission_id = m.id)) lm on true
    left join lateral (
      select case when count(*) = 1 then min(p.id::text)::uuid end as project_id
        from public.projects p where p.company_id = c.id and p.status <> 'archive'
         and not exists (select 1 from public.sales x where x.project_id = p.id)) lp on true
    left join public.finance_mission_overview mo on mo.id = r.mission_id
    left join public.projects pr on pr.id = coalesce(r.project_id, case when r.sale_id is null and r.deal_status = 'won' then lp.project_id end)
    left join public.project_onboarding_status ob on ob.project_id = pr.id;
revoke all on public.sales_overview from anon;
grant select on public.sales_overview to authenticated;

-- ===========================================================================
-- Droits d'exécution
-- ===========================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.idem_caller()', 'public.idem_begin(text, jsonb)',
    'public.deal_links(uuid)', 'public.deal_links_need_decision(uuid)',
    'public.deal_transition(uuid, text, jsonb, text)', 'public.deal_new_opportunity(uuid, uuid, text)',
    'public.sale_set_stage(uuid, text, boolean)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- K10 — une nouvelle pièce (proposition, contrat) relance la préparation des ventes suivies de la fiche ; la
-- préparation repart à l'ouverture du projet et conserve vos corrections (sections « owner »). Un contrat ajouté
-- reste une pièce à examiner : il ne vaut pas confirmation des documents (sales.documents_ready reste le vôtre).
-- ===========================================================================
create or replace function public.tg_files_refresh_onboarding()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'ready' and new.category in ('Proposition', 'Contrat')
     and (tg_op = 'INSERT' or old.status is distinct from 'ready' or old.category is distinct from new.category) then
    update public.project_onboarding o set prep_state = 'pending', prep_error = null
      from public.sales s
     where s.company_id = new.company_id and s.state = 'won' and o.project_id = s.project_id and o.prep_state <> 'pending';
  end if;
  return null;
end;
$$;
create trigger files_refresh_onboarding after insert or update of status, category on public.company_files
  for each row execute function public.tg_files_refresh_onboarding();
