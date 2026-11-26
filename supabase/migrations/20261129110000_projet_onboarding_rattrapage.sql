-- Rattrapage : la préparation de projet de la production date de la première version de ce module
-- (« 20261112000100_projet_onboarding », fondée sur deal_closings). Le fichier a ensuite été réécrit et renommé
-- (20261114000100, fondé sur les ventes) sans que la base de production soit rejouée. Les migrations suivantes se
-- sont appliquées sans erreur par-dessus, mais tout ce qui lit project_onboarding.sale_id échoue à l'exécution :
-- « column "sale_id" of relation "project_onboarding" does not exist » (ouverture d'un projet né d'une vente,
-- open_project_onboarding, préparation après « Gagné »).
--
-- Cette migration amène une base dans cet état à celui du dépôt. Sur une base déjà à jour (installation neuve,
-- environnement de test), la partie « schéma » ne fait rien et les fonctions sont redéfinies à l'identique.
-- Aucune donnée n'est supprimée : deal_closings et project_onboarding.closing_id sont conservés, inutilisés.
-- Le SQL Editor exécute le fichier en une transaction : en cas d'erreur, rien n'est modifié.

-- ---------------------------------------------------------------------------
-- 1. Schéma : la préparation se rattache à la vente
-- ---------------------------------------------------------------------------
do $do$
declare
  v_sales_overview text;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'project_onboarding' and column_name = 'sale_id') then
    return; -- base déjà à jour
  end if;

  alter table public.project_onboarding add column sale_id uuid references public.sales (id) on delete set null;
  -- préparations existantes : rattachées à la vente qui porte leur projet (la plus récente s'il y en a plusieurs)
  update public.project_onboarding o
     set sale_id = (select s.id from public.sales s where s.project_id = o.project_id order by s.created_at desc limit 1);
  -- l'ancienne clé n'est plus renseignée par les nouvelles préparations
  alter table public.project_onboarding alter column closing_id drop not null;

  -- La vue d'état change de colonnes (sale_id, won_on) : elle doit être recréée, et sales_overview, qui la lit,
  -- avec elle. sales_overview est recréée à l'identique, à partir de sa définition actuelle.
  if to_regclass('public.sales_overview') is not null then
    v_sales_overview := pg_get_viewdef('public.sales_overview'::regclass, true);
    drop view public.sales_overview;
  end if;
  drop view public.project_onboarding_status;
  execute $v$create view public.project_onboarding_status with (security_invoker = true) as
  select o.project_id, o.sale_id, p.company_id, coalesce(s.signed_on, s.closed_on, (p.created_at at time zone 'Europe/Paris')::date) as won_on, o.prep_state, o.prep_error, o.analysis_state, o.analysis_error,
         (select count(*) from public.project_onboarding_items i where i.project_id = o.project_id and i.status = 'open' and i.required)::int as open_required,
         (select count(*) from public.project_onboarding_items i where i.project_id = o.project_id and i.status = 'open' and not i.required)::int as open_optional,
         case
           when o.prep_state = 'pending' or (o.analysis_state = 'requested' and o.analysis_requested_at > now() - interval '20 minutes') then 'preparing'
           when o.prep_state = 'failed' or exists (select 1 from public.project_onboarding_items i where i.project_id = o.project_id and i.status = 'open' and i.required) then 'to_complete'
           else 'ready'
         end as status
    from public.project_onboarding o
    join public.projects p on p.id = o.project_id
    left join public.sales s on s.id = o.sale_id$v$;
  revoke all on public.project_onboarding_status from anon;
  grant select on public.project_onboarding_status to authenticated;
  if v_sales_overview is not null then
    execute 'create view public.sales_overview with (security_invoker = true) as ' || v_sales_overview;
    revoke all on public.sales_overview from anon;
    grant select on public.sales_overview to authenticated;
  end if;

  -- ancien circuit « Gagné → deal_closings → projet » : remplacé par Ventes (sale_confirm, company_make_client)
  drop trigger if exists deal_closing_reopen on public.companies;
  drop function if exists public.tg_deal_closing_reopen();
  drop function if exists public.project_win_deal(uuid);
end $do$;

-- ---------------------------------------------------------------------------
-- 2. La vente porte le projet : la préparation existe dès que le projet est lié
--    (définitions reprises telles quelles de 20261114000100)
-- ---------------------------------------------------------------------------
create or replace function public.tg_sales_onboarding()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null then
    insert into public.project_onboarding (project_id, sale_id) values (new.project_id, new.id)
    on conflict (project_id) do update set sale_id = excluded.sale_id where public.project_onboarding.sale_id is null;
  end if;
  return null;
end; $$;
drop trigger if exists sales_onboarding on public.sales;
create trigger sales_onboarding after insert or update of project_id on public.sales
  for each row execute function public.tg_sales_onboarding();

-- ---------------------------------------------------------------------------
-- 3. Préparation à partir des sources : lit la vente, tient à jour sales.prep
-- ---------------------------------------------------------------------------
create or replace function public.onboarding_prepare(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o public.project_onboarding;
  p public.projects;
  c public.companies;
  v_won date;
  v_sections jsonb;
  v_items jsonb := '[]';
  v_keys text[] := '{}';
  v_contracts uuid[];
  v_proposals uuid[];
  v_proposal uuid;
  v_proposal_name text;
  v_diag uuid;
  v_diag_count int;
  v_context jsonb := '[]';
  v_actions jsonb := '[]';
  v_findings jsonb := '[]';
  v_phases jsonb;
  v_people int;
  v_with_email int;
  v_calls int := 0;
  v_primary text;
  r record;
  it jsonb;
  v_text text;
begin
  perform public.assert_owner();
  select * into o from public.project_onboarding where project_id = p_project for update;
  if not found then raise exception 'Ce projet n''est lié à aucune vente : pas de préparation' using errcode = 'P0002'; end if;
  select * into p from public.projects where id = p_project;
  select coalesce(sa.signed_on, sa.closed_on) into v_won from public.sales sa where sa.id = o.sale_id;
  select * into c from public.companies where id = p.company_id;
  v_sections := o.sections;

  -- Proposition ou contrat : le choix explicite prime ; sinon un seul contrat, ou une seule proposition.
  v_proposal := case when o.proposal_choice = 'owner' then o.proposal_file_id end;
  if v_proposal is not null and not exists (select 1 from public.company_files where id = v_proposal and status = 'ready') then
    v_proposal := null;
  end if;
  select coalesce(array_agg(id order by created_at desc), '{}') into v_contracts from public.company_files where company_id = c.id and status = 'ready' and category = 'Contrat';
  select coalesce(array_agg(id order by created_at desc), '{}') into v_proposals from public.company_files where company_id = c.id and status = 'ready' and category = 'Proposition';
  if v_proposal is null then
    if cardinality(v_contracts) = 1 then v_proposal := v_contracts[1];
    elsif cardinality(v_contracts) = 0 and cardinality(v_proposals) = 1 then v_proposal := v_proposals[1];
    end if;
  end if;
  select display_name into v_proposal_name from public.company_files where id = v_proposal;

  -- Diagnostic : celui que j'ai choisi, sinon le dernier qui a une version prête (le CRM n'a pas de « validé »).
  v_diag := case when o.diagnostic_choice = 'owner' then o.diagnostic_id end;
  if v_diag is null then
    select dg.id into v_diag from public.diagnostics dg
     where dg.company_id = c.id and exists (select 1 from public.diagnostic_versions v where v.diagnostic_id = dg.id and v.status = 'ready')
     order by dg.created_at desc limit 1;
  end if;
  select count(*) into v_diag_count from public.diagnostics dg
   where dg.company_id = c.id and exists (select 1 from public.diagnostic_versions v where v.diagnostic_id = dg.id and v.status = 'ready');

  -- Résumé de la mission (repris de la fiche)
  v_sections := public.onboarding_put_section(v_sections, 'mission', jsonb_build_array(jsonb_build_object(
    'text', 'Mission pour ' || c.name || coalesce(', signée le ' || to_char(v_won, 'DD/MM/YYYY'), '')
            || coalesce(' · montant indiqué sur la fiche : ' || replace(to_char(c.amount, 'FM999G999G990D00'), ',', ' ') || ' €', ''),
    'refs', jsonb_build_array(public.onboarding_ref('company', c.id, 'Fiche CRM')))));

  -- Contexte : description de la fiche, résumés Fireflies des appels rattachés
  if coalesce(btrim(c.description), '') <> '' then
    v_context := v_context || jsonb_build_array(jsonb_build_object('text', left(btrim(c.description), 800), 'refs', jsonb_build_array(public.onboarding_ref('company', c.id, 'Description de la fiche'))));
  end if;
  for r in
    select fc.id, fc.title, fc.occurred_at, fc.summary from public.fireflies_calls fc
     where fc.company_id = c.id and fc.summary_state = 'available'
     order by fc.occurred_at desc nulls last limit 5
  loop
    v_calls := v_calls + 1;
    v_text := coalesce(public.onboarding_text(r.summary -> 'short_summary'), public.onboarding_text(r.summary -> 'overview'),
                       public.onboarding_text(r.summary -> 'short_overview'), public.onboarding_text(r.summary -> 'bullet_gist'));
    if coalesce(btrim(v_text), '') <> '' then
      v_context := v_context || jsonb_build_array(jsonb_build_object('text', left(btrim(v_text), 800),
        'refs', jsonb_build_array(public.onboarding_ref('call', r.id, r.title || coalesce(' · ' || to_char(r.occurred_at at time zone 'Europe/Paris', 'DD/MM/YYYY'), '')))));
    end if;
    v_text := public.onboarding_text(r.summary -> 'action_items');
    if coalesce(btrim(v_text), '') <> '' then
      for it in select to_jsonb(btrim(regexp_replace(l, '^[\s\-\*•·0-9\.\)]+', ''))) from unnest(string_to_array(v_text, E'\n')) l
                where char_length(btrim(regexp_replace(l, '^[\s\-\*•·0-9\.\)]+', ''))) between 3 and 300 limit 4
      loop
        if jsonb_array_length(v_actions) < 6 then
          v_actions := v_actions || jsonb_build_array(jsonb_build_object('text', it #>> '{}', 'suggested', true,
            'refs', jsonb_build_array(public.onboarding_ref('call', r.id, r.title))));
        end if;
      end loop;
    end if;
  end loop;
  v_sections := public.onboarding_put_section(v_sections, 'context', v_context);

  -- Constats du diagnostic retenu
  if v_diag is not null then
    for v_text in
      select btrim(l) from public.diagnostics dg, unnest(regexp_split_to_array(coalesce(dg.summary, ''), E'\n\s*\n|\n')) l
       where dg.id = v_diag and char_length(btrim(l)) >= 20 limit 5
    loop
      v_findings := v_findings || jsonb_build_array(jsonb_build_object('text', left(v_text, 600),
        'refs', jsonb_build_array(public.onboarding_ref('diagnostic', v_diag, 'Diagnostic'))));
    end loop;
  end if;
  v_sections := public.onboarding_put_section(v_sections, 'findings', v_findings);

  -- Phases : le planning du projet s'il existe déjà
  select coalesce(jsonb_agg(jsonb_build_object('text', ph.name, 'date', ph.start_date,
           'date_status', case when ph.start_date is null then 'unknown' else 'confirmed' end) order by ph.position), '[]')
    into v_phases from public.project_phases ph where ph.project_id = p_project;
  v_sections := public.onboarding_put_section(v_sections, 'phases', v_phases);

  -- Premières actions (suggestions)
  select count(*), count(*) filter (where coalesce(btrim(email), '') <> '') into v_people, v_with_email from public.people where company_id = c.id;
  select coalesce(nullif(btrim(concat_ws(' ', first_name, last_name)), ''), email) into v_primary
    from public.people where company_id = c.id order by is_primary desc, created_at limit 1;
  v_actions := jsonb_build_array(
      jsonb_build_object('text', 'Planifier le point de lancement' || coalesce(' avec ' || v_primary, ''), 'suggested', true, 'refs', '[]'::jsonb),
      jsonb_build_object('text', 'Partager l''espace client (accès au portail)', 'suggested', true, 'refs', '[]'::jsonb)) || v_actions;
  v_sections := public.onboarding_put_section(v_sections, 'first_actions', v_actions);

  -- Ce qui manque ---------------------------------------------------------------
  if v_proposal is null then
    if cardinality(v_contracts) + cardinality(v_proposals) = 0 then
      v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'proposal', 'kind', 'proposal', 'required', true, 'priority', 10,
        'label', 'Proposition acceptée introuvable',
        'detail', 'Aucun document « Proposition » ou « Contrat » sur la fiche. Choisissez un document déjà joint ou importez le document signé.'));
    else
      v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'proposal', 'kind', 'proposal', 'required', true, 'priority', 10,
        'label', 'Plusieurs propositions : laquelle a été acceptée ?',
        'detail', 'La version acceptée n''est pas identifiable. Choisissez celle qui fait foi.',
        'options', (select coalesce(jsonb_agg(jsonb_build_object('label', f.display_name, 'file_id', f.id) order by f.created_at desc), '[]')
                      from public.company_files f where f.id = any (v_contracts || v_proposals))));
    end if;
  end if;
  if not public.onboarding_section_filled(v_sections, 'objectives') then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'objectives', 'kind', 'text', 'required', true, 'priority', 20, 'target_section', 'objectives',
      'label', 'Objectifs de la mission à préciser',
      'detail', case when v_proposal is not null or v_calls > 0 or v_diag is not null
                     then 'Les sources ne sont pas encore analysées. Lancez l''analyse avec Claude, ou écrivez les objectifs en une ou deux phrases.'
                     else 'Aucune source exploitable : écrivez les objectifs en une ou deux phrases.' end));
  end if;
  if not (public.onboarding_section_filled(v_sections, 'scope') and public.onboarding_section_filled(v_sections, 'deliverables')) then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'scope', 'kind', 'text', 'required', true, 'priority', 30, 'target_section', 'scope',
      'label', 'Périmètre et livrables à confirmer',
      'detail', case when v_proposal is not null
                     then 'La proposition « ' || v_proposal_name || ' » est jointe, mais le CRM ne lit pas son contenu. Lancez l''analyse avec Claude, ou résumez le périmètre et les livrables.'
                     else 'Sans proposition, résumez ce qui a été convenu (une ligne par élément).' end,
      'refs', case when v_proposal is not null then jsonb_build_array(public.onboarding_ref('file', v_proposal, v_proposal_name)) else '[]'::jsonb end));
  end if;
  if p.start_date is null then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'start_date', 'kind', 'date', 'required', true, 'priority', 40,
      'label', 'Date de démarrage à confirmer', 'detail', 'Renseignez la date de démarrage convenue.'));
  end if;
  if v_people = 0 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'contact', 'kind', 'contact', 'required', true, 'priority', 50,
      'label', 'Interlocuteur principal à identifier', 'detail', 'Aucun contact sur la fiche. Ajoutez-le depuis la fiche CRM.'));
  elsif v_with_email = 0 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'contact_email', 'kind', 'contact', 'required', false, 'priority', 60,
      'label', 'Email de l''interlocuteur manquant', 'detail', 'Utile pour partager l''espace client. À compléter sur la fiche.'));
  end if;
  if v_calls = 0 then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'calls', 'kind', 'link', 'required', false, 'priority', 70,
      'label', 'Aucun appel Fireflies rattaché', 'detail', 'Rattachez les appels de vente à la fiche pour enrichir le contexte.'));
  end if;
  if v_diag is null then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'diagnostic', 'kind', 'link', 'required', false, 'priority', 80,
      'label', 'Pas de diagnostic disponible', 'detail', 'Facultatif : aucun diagnostic avec une version prête sur cette fiche.'));
  elsif v_diag_count > 1 and o.diagnostic_choice = 'auto' then
    v_items := v_items || jsonb_build_array(jsonb_build_object('key', 'diagnostic_choice', 'kind', 'choice', 'required', false, 'priority', 80,
      'label', 'Diagnostic à confirmer', 'detail', 'Plusieurs diagnostics ont une version prête : le plus récent est utilisé.',
      'options', (select coalesce(jsonb_agg(jsonb_build_object('label', 'Diagnostic du ' || to_char(dg.created_at at time zone 'Europe/Paris', 'DD/MM/YYYY'), 'diagnostic_id', dg.id) order by dg.created_at desc), '[]')
                    from public.diagnostics dg where dg.company_id = c.id and exists (select 1 from public.diagnostic_versions v where v.diagnostic_id = dg.id and v.status = 'ready'))));
  end if;

  for it in select * from jsonb_array_elements(v_items) loop
    v_keys := v_keys || (it ->> 'key');
    insert into public.project_onboarding_items (project_id, key, label, detail, kind, required, priority, options, refs, target_section, origin)
    values (p_project, it ->> 'key', it ->> 'label', it ->> 'detail', it ->> 'kind', (it ->> 'required')::boolean, (it ->> 'priority')::int,
            coalesce(it -> 'options', '[]'), coalesce(it -> 'refs', '[]'), it ->> 'target_section', 'crm')
    on conflict (project_id, key) do update
       set label = excluded.label, detail = excluded.detail, options = excluded.options, refs = excluded.refs, required = excluded.required,
           status = case when project_onboarding_items.status = 'resolved' then 'open' else project_onboarding_items.status end
     where project_onboarding_items.status in ('open', 'resolved');
  end loop;
  -- Un point du CRM qui ne se pose plus est clos ; mes réponses et celles du client ne sont jamais effacées.
  update public.project_onboarding_items set status = 'resolved'
   where project_id = p_project and origin = 'crm' and status = 'open' and not (key = any (v_keys));
  -- Une question de Claude sur une section que j'ai complétée depuis ne bloque plus.
  update public.project_onboarding_items set status = 'resolved'
   where project_id = p_project and origin = 'claude' and status = 'open' and target_section is not null
     and kind = 'text' and coalesce(v_sections -> target_section ->> 'origin', '') = 'owner';

  update public.project_onboarding
     set sections = v_sections, proposal_file_id = v_proposal, diagnostic_id = v_diag,
         prep_state = 'done', prep_error = null, prep_count = prep_count + 1, prepared_at = now()
   where project_id = p_project;
  -- Même état pour Ventes : les points de la préparation (les points clos sont marqués faits).
  update public.sales sa
     set prep_state = case when exists (select 1 from public.project_onboarding_items i where i.project_id = p_project and i.status = 'open' and i.required)
                           then 'incomplete' else 'ready' end,
         prep = jsonb_build_object(
           'items', coalesce((select jsonb_agg(jsonb_build_object('key', i.key, 'label', i.label, 'done', i.status <> 'open', 'required', i.required,
                                'href', '/projets/' || p_project, 'hint', i.detail) order by i.required desc, i.priority)
                                from public.project_onboarding_items i where i.project_id = p_project and i.status <> 'resolved'), '[]'),
           'sources', jsonb_build_object('propositions', cardinality(v_proposals), 'contracts', cardinality(v_contracts), 'calls', v_calls, 'diagnostic', v_diag is not null)),
         prep_error = null, prep_at = now()
   where sa.id = o.sale_id and sa.project_id = p_project;
  return jsonb_build_object('status', (select status from public.project_onboarding_status where project_id = p_project));
end;
$$;

create or replace function public.onboarding_prep_failed(p_project uuid, p_message text)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding set prep_state = 'failed', prep_error = left(coalesce(nullif(btrim(p_message), ''), 'Préparation impossible.'), 2000)
   where project_id = p_project;
  update public.sales set prep_state = 'failed', prep_error = left(coalesce(nullif(btrim(p_message), ''), 'Préparation impossible.'), 500), prep_at = now()
   where project_id = p_project;
end; $$;

-- ---------------------------------------------------------------------------
-- Droits (inchangés) et rechargement du cache de l'API
-- ---------------------------------------------------------------------------
revoke all on function public.tg_sales_onboarding() from public, anon, authenticated;
revoke all on function public.onboarding_prepare(uuid) from public, anon;
grant execute on function public.onboarding_prepare(uuid) to authenticated;
revoke all on function public.onboarding_prep_failed(uuid, text) from public, anon;
grant execute on function public.onboarding_prep_failed(uuid, text) to authenticated;

notify pgrst, 'reload schema';
