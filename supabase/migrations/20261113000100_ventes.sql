-- Ventes : relier la clôture, le projet client et la facturation.
--  * Une vente suivie par fiche (sales.company_id unique) : c'est la référence stable. Un clic répété, une relance
--    après erreur ou une nouvelle victoire après réouverture retrouvent la même vente, donc le même projet et le
--    même revenu.
--  * La source de vérité reste companies.deal_status (open / won / lost) : Ventes la lit telle quelle ; les ventes
--    déjà gagnées ou perdues y apparaissent sans migration de données. Aucun projet ni revenu n'est créé en masse :
--    un ancien dossier gagné se complète à la main.
--  * Suivi après-vente, un seul état partagé avec Projets :
--      Devis / Contrat  = vente gagnée, documents à finaliser (sales.documents_ready = false) ;
--      Onboarding       = documents prêts, projet « à préparer » ;
--      En mission       = projet en cours ou en attente ;
--      terminé          = projet terminé ou archivé (la vente quitte le tableau, reste dans Gagnées).
--  * Facturation : prévue (revenu sans facture), facturée (facture enregistrée), encaissée (réglée) — lue depuis
--    les vues Finance existantes, jamais recopiée.
-- Additif : aucune table existante n'est modifiée.

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null unique references public.companies (id) on delete restrict,
  -- won : vente gagnée suivie ; reopened : opportunité rouverte, liens conservés pour une prochaine victoire
  state text not null default 'won' check (state in ('won', 'reopened')),
  closed_on date not null,
  signed_on date,
  revenue_mode text not null default 'plus_tard' check (revenue_mode in ('mensuel', 'ponctuel', 'plus_tard')),
  mission_id uuid references public.finance_missions (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  documents_ready boolean not null default false,
  -- préparation du projet en arrière-plan (proposition, Fireflies, diagnostic)
  prep_state text not null default 'pending' check (prep_state in ('pending', 'running', 'ready', 'incomplete', 'failed')),
  prep jsonb not null default '{}' check (jsonb_typeof(prep) = 'object'),
  prep_error text check (prep_error is null or char_length(prep_error) <= 500),
  prep_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (signed_on is null or signed_on <= closed_on + 366)
);
create index sales_project_idx on public.sales (project_id);
create index sales_mission_idx on public.sales (mission_id);
create trigger set_updated_at before update on public.sales for each row execute function public.tg_set_updated_at();

alter table public.sales enable row level security;
create policy owner_select on public.sales for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.sales for insert to authenticated with check ((select public.is_app_owner()));
create policy owner_update on public.sales for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()));
revoke all on public.sales from anon;

-- Fusion de fiches : la vente suit la fiche conservée (si celle-ci n'en a pas déjà une).
create or replace function public.tg_sales_follow_merge()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null
     and not exists (select 1 from public.sales where company_id = new.merged_into_id) then
    update public.sales set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger sales_follow_merge after update of merged_into_id on public.companies
  for each row execute function public.tg_sales_follow_merge();

-- L'issue commerciale reste la seule vérité : rouvrir (fiche, Kanban, déplacement d'étape) met la vente en
-- attente sans rien délier ; la regagner, par n'importe quel chemin, la réactive avec les mêmes liens.
create or replace function public.tg_sales_follow_deal()
returns trigger
language plpgsql
as $$
begin
  if new.deal_status = 'won' and old.deal_status <> 'won' then
    update public.sales set state = 'won' where company_id = new.id and state <> 'won';
  elsif old.deal_status = 'won' and new.deal_status <> 'won' then
    update public.sales set state = 'reopened' where company_id = new.id and state <> 'reopened';
  end if;
  return null;
end;
$$;
create trigger sales_follow_deal after update of deal_status on public.companies
  for each row execute function public.tg_sales_follow_deal();

-- ---------------------------------------------------------------------------
-- « Marquer comme gagné » : une seule transaction, rejouable sans doublon
-- ---------------------------------------------------------------------------
-- p_data : {
--   closed_on: date (défaut aujourd'hui), signed_on?: date, documents_ready?: bool,
--   revenue?: { mode: 'mensuel'|'ponctuel'|'plus_tard', amount?, date?, end_date? },
--   link_mission_id?: uuid, link_invoice_id?: uuid, link_project_id?: uuid, project_name?: text
-- }
-- Fiche ouverte : elle passe Gagné (trace datée dans l'activité). Fiche déjà gagnée (ancien dossier, relance) :
-- la clôture n'est pas modifiée, seuls les liens manquants sont complétés. Un revenu ou un projet déjà liés ne
-- sont jamais remplacés ni dupliqués.
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
  v_name text;
  v_created jsonb := '{}'::jsonb;
  m public.finance_missions;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
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

  -- 1. la fiche passe Gagné (même logique que la fiche et le Kanban) ; une fiche déjà gagnée garde sa clôture
  if c.deal_status = 'lost' then raise exception 'Opportunité perdue : rouvrez-la avant de la marquer gagnée.' using errcode = '22023'; end if;
  if c.deal_status = 'open' then
    perform public.set_deal_status(p_company, 'won', null, v_closed, case when v_mode = 'ponctuel' then v_amount end);
  end if;

  -- 2. la vente suivie (une par fiche)
  insert into public.sales (company_id, state, closed_on, signed_on, revenue_mode, documents_ready)
  values (p_company, 'won', case when c.deal_status = 'won' and c.deal_closed_at is not null
                                 then (c.deal_closed_at at time zone 'Europe/Paris')::date else v_closed end,
          v_signed, v_mode, coalesce((p_data ->> 'documents_ready')::boolean, false))
  on conflict (company_id) do update
     set state = 'won',
         closed_on = case when c.deal_status = 'open' then excluded.closed_on else sales.closed_on end,
         signed_on = coalesce(excluded.signed_on, sales.signed_on),
         documents_ready = case when p_data ? 'documents_ready' then excluded.documents_ready else sales.documents_ready end
  returning * into s;
  if s.created_at = s.updated_at then v_created := v_created || '{"sale": true}'; end if;

  -- 3. le revenu : lier l'existant, ou créer le revenu prévu (clé stable : rejoué, il renvoie le même)
  v_mission := s.mission_id;
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
    v_name := 'Vente ' || c.name;
    v_mission := (public.finance_add_revenue(jsonb_build_object(
      'company_id', p_company, 'label', left(v_name, 200), 'kind', v_mode, 'amount', v_amount,
      'date', v_rev_date, 'end_date', v_rev_end), 'sale-revenue:' || s.id) ->> 'id')::uuid;
    update public.sales set mission_id = v_mission, revenue_mode = v_mode where id = s.id;
    v_created := v_created || '{"revenue": true}';
  end if;

  -- une facture déjà enregistrée : rattachée au revenu de la vente (créé depuis la facture s'il n'y en a pas)
  if v_link_invoice is not null then
    select * into v_inv from public.finance_invoices where id = v_link_invoice and company_id = p_company and kind = 'facture' and cancelled_at is null for update;
    if not found then raise exception 'Facture introuvable pour cette fiche.' using errcode = '22023'; end if;
    if v_inv.mission_id is not null and v_inv.mission_id is distinct from v_mission then
      if v_mission is null and not exists (select 1 from public.sales x where x.mission_id = v_inv.mission_id) then
        v_mission := v_inv.mission_id;   -- la facture porte déjà un revenu libre : on lie ce revenu
        update public.sales set mission_id = v_mission, revenue_mode = (select case when kind = 'recurrent' then 'mensuel' else 'ponctuel' end from public.finance_missions where id = v_mission) where id = s.id;
      else
        raise exception 'Cette facture est déjà rattachée à un autre revenu.' using errcode = '22023';
      end if;
    end if;
    if v_mission is null then
      v_mission := (public.finance_add_revenue(jsonb_build_object(
        'company_id', p_company, 'label', left('Vente ' || c.name, 200), 'kind', 'ponctuel', 'amount', v_inv.amount_ht,
        'date', coalesce(v_inv.due_date, v_inv.issue_date)), 'sale-revenue:' || s.id) ->> 'id')::uuid;
      update public.sales set mission_id = v_mission, revenue_mode = 'ponctuel' where id = s.id;
      v_created := v_created || '{"revenue": true}';
    end if;
    update public.finance_invoices set mission_id = v_mission,
           forecast_due_date = coalesce(forecast_due_date, (select coalesce(next_due_date, start_date) from public.finance_missions where id = v_mission and kind = 'ponctuel'))
     where id = v_inv.id;
  end if;

  -- 4. le projet : lier l'existant, sinon le créer une seule fois (à préparer = onboarding)
  v_project := s.project_id;
  if v_project is null and v_link_project is not null then
    if not exists (select 1 from public.projects where id = v_link_project and company_id = p_company) then
      raise exception 'Ce projet n''appartient pas à cette fiche.' using errcode = '22023';
    end if;
    v_project := v_link_project;
    update public.sales set project_id = v_project where id = s.id;
  elsif v_project is null then
    select array_agg(p.id) into v_people from (
      select id from public.people where company_id = p_company order by is_primary desc, created_at limit 1) p;
    select * into m from public.finance_missions where id = v_mission;
    v_project := public.project_create(jsonb_build_object(
      'company_id', p_company,
      'name', left(coalesce(nullif(btrim(p_data ->> 'project_name'), ''), 'Mission ' || c.name), 160),
      'start_date', coalesce(m.start_date, v_rev_date),
      'end_date', case when m.kind = 'recurrent' then m.end_date else null end,
      'status', 'a_preparer'), coalesce(v_people, '{}'));
    update public.sales set project_id = v_project where id = s.id;
    v_created := v_created || '{"project": true}';
  end if;

  -- 5. la préparation reprend (sources de la fiche) : lancée en arrière-plan par l'application
  update public.sales set prep_state = 'pending', prep_error = null where id = s.id and prep_state in ('pending', 'failed');

  return public.idem_put(p_idempotency_key, 'sale_confirm', jsonb_build_object(
    'sale_id', s.id, 'project_id', v_project, 'mission_id', v_mission, 'created', v_created));
end;
$$;

-- ---------------------------------------------------------------------------
-- Faire avancer le suivi (carte Ventes ou projet) : un seul état, partagé avec Projets
-- ---------------------------------------------------------------------------
create or replace function public.sale_set_stage(p_sale uuid, p_stage text)
returns jsonb
language plpgsql
as $$
declare s public.sales; v_project public.projects; v_label text;
begin
  perform public.assert_owner();
  if p_stage not in ('devis_contrat', 'onboarding', 'en_mission', 'termine') then raise exception 'Étape de suivi invalide' using errcode = '22023'; end if;
  select * into s from public.sales where id = p_sale for update;
  if not found then raise exception 'Vente introuvable' using errcode = 'P0002'; end if;
  if s.state <> 'won' then raise exception 'Opportunité rouverte : marquez-la gagnée pour reprendre son suivi.' using errcode = '22023'; end if;
  select * into v_project from public.projects where id = s.project_id;
  if p_stage in ('en_mission', 'termine') and v_project.id is null then
    raise exception 'Aucun projet lié : créez ou liez le projet d''abord.' using errcode = '22023';
  end if;
  update public.sales set documents_ready = p_stage <> 'devis_contrat' where id = s.id;
  if v_project.id is not null then
    update public.projects set status = case p_stage when 'en_mission' then 'en_cours' when 'termine' then 'termine' else 'a_preparer' end
     where id = v_project.id and status is distinct from case p_stage when 'en_mission' then 'en_cours' when 'termine' then 'termine' else 'a_preparer' end
       and status <> 'archive';
  end if;
  v_label := case p_stage when 'devis_contrat' then 'Devis / Contrat' when 'onboarding' then 'Onboarding' when 'en_mission' then 'En mission' else 'Mission terminée' end;
  perform public.log_event(s.company_id, 'system', 'Suivi client : ' || v_label, jsonb_build_object('sale_id', s.id, 'stage', p_stage, 'project_id', s.project_id));
  return jsonb_build_object('sale_id', s.id, 'stage', p_stage);
end;
$$;

-- Résultat de la préparation, écrit par l'application (tâche en arrière-plan).
create or replace function public.sale_prep_save(p_sale uuid, p_state text, p_prep jsonb, p_error text default null)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  if p_state not in ('running', 'ready', 'incomplete', 'failed') then raise exception 'État de préparation invalide' using errcode = '22023'; end if;
  update public.sales
     set prep_state = p_state,
         prep = case when p_prep is null then prep else p_prep end,
         prep_error = case when p_state = 'failed' then left(coalesce(p_error, 'Préparation interrompue.'), 500) else null end,
         prep_at = now()
   where id = p_sale;
  if not found then raise exception 'Vente introuvable' using errcode = 'P0002'; end if;
end;
$$;

-- Prendre la préparation (une seule à la fois ; une préparation bloquée plus de 10 minutes se reprend).
create or replace function public.sale_prep_claim(p_sale uuid)
returns boolean
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.sales set prep_state = 'running', prep_error = null, prep_at = now()
   where id = p_sale and (prep_state <> 'running' or prep_at < now() - interval '10 minutes');
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Vue des ventes : gagnées et perdues (statuts actuels), suivi, facturation
-- ---------------------------------------------------------------------------
create or replace view public.sales_overview with (security_invoker = true) as
  select c.id as company_id,
         c.name,
         c.deal_status,
         c.deal_closed_at,
         coalesce(s.closed_on, (c.deal_closed_at at time zone 'Europe/Paris')::date) as closed_on,
         c.lost_reason,
         c.amount as deal_amount,
         c.archived_at,
         pl.name as pipeline_name,
         st.name as stage_name,
         pp.name as primary_person_name,
         s.id as sale_id,
         s.state as sale_state,
         s.signed_on,
         s.revenue_mode,
         s.documents_ready,
         s.prep_state,
         s.prep,
         s.prep_error,
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
         -- ancien dossier gagné sans suivi : liens trouvés de façon fiable (un seul candidat), proposés à la complétion
         case when s.id is null then lm.mission_id end as candidate_mission_id,
         case when s.id is null then lp.project_id end as candidate_project_id,
         case
           when mo.id is null then 'a_renseigner'
           when mo.invoiced_ttc > 0 and mo.remaining <= 0 and mo.received > 0 then 'encaisse'
           when mo.invoiced_ttc > 0 then 'facture'
           else 'prevu'
         end as billing,
         case
           when c.deal_status <> 'won' then null
           when pr.status in ('termine', 'archive') then 'termine'
           when pr.status in ('en_cours', 'en_attente') then 'en_mission'
           when s.id is null and pr.id is null then null          -- ancien dossier sans suivi : à compléter
           when s.id is not null and not s.documents_ready then 'devis_contrat'
           else 'onboarding'
         end as stage
    from public.companies c
    left join public.sales s on s.company_id = c.id
    left join public.pipelines pl on pl.id = c.pipeline_id
    left join public.stages st on st.id = c.stage_id
    left join lateral (
      select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as name
        from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1) pp on true
    -- un seul revenu libre / un seul projet actif sur la fiche : lien fiable ; plusieurs : rien n'est deviné
    left join lateral (
      select case when count(*) = 1 then min(m.id::text)::uuid end as mission_id
        from public.finance_missions m
       where m.company_id = c.id and not exists (select 1 from public.sales x where x.mission_id = m.id)) lm on true
    left join lateral (
      select case when count(*) = 1 then min(p.id::text)::uuid end as project_id
        from public.projects p where p.company_id = c.id and p.status <> 'archive') lp on true
    left join public.finance_mission_overview mo on mo.id = s.mission_id
    left join public.projects pr on pr.id = coalesce(s.project_id, case when s.id is null then lp.project_id end)
   where c.merged_into_id is null and c.deal_status in ('won', 'lost');

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public.sale_confirm(uuid, jsonb, text)', 'public.sale_set_stage(uuid, text)',
    'public.sale_prep_save(uuid, text, jsonb, text)', 'public.sale_prep_claim(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke all on public.sales_overview from anon;
