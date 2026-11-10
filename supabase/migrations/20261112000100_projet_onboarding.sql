-- Projets : « Gagné » crée et prépare le projet client. Migration additive.
--   - deal_closings : une vente (identifiant stable). Un double clic, une relance ou un rechargement
--     retrouvent la même vente et le même projet ; rouvrir puis regagner reprend la vente tant que son
--     projet n'est ni terminé ni archivé. Les autres projets du client restent distincts.
--   - project_onboarding : préparation du projet (sources retenues, sections préremplies, état).
--   - project_onboarding_items : ce qui manque, avec la réponse (moi ou le client via le portail).
--   - project_onboarding_decks : versions des slides d'onboarding (fichiers internes du projet).
-- Rien de tout cela n'est lisible par le portail : aucune fonction portal_* n'y accède, anon n'a aucun droit.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.deal_closings (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  won_at timestamptz not null default now(),
  -- fiche rouverte après la vente : la vente n'est plus active
  reopened_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index deal_closings_one_active on public.deal_closings (company_id) where reopened_at is null;
create index deal_closings_company_idx on public.deal_closings (company_id, won_at desc);

create table public.project_onboarding (
  project_id uuid primary key references public.projects (id) on delete cascade,
  closing_id uuid not null unique references public.deal_closings (id) on delete restrict,
  -- pending : à préparer (ou en cours) ; done : préparé ; failed : erreur, à relancer
  prep_state text not null default 'pending' check (prep_state in ('pending', 'done', 'failed')),
  prep_error text check (prep_error is null or char_length(prep_error) <= 2000),
  prep_count integer not null default 0,
  prepared_at timestamptz,
  -- analyse des sources par Claude (le CRM ne lit pas le contenu des documents)
  analysis_state text not null default 'none' check (analysis_state in ('none', 'requested', 'done', 'failed')),
  analysis_error text check (analysis_error is null or char_length(analysis_error) <= 2000),
  analysis_requested_at timestamptz,
  analysis_at timestamptz,
  analysis_session_url text check (analysis_session_url is null or (char_length(analysis_session_url) <= 500 and analysis_session_url ~ '^https://claude\.ai/')),
  proposal_file_id uuid references public.company_files (id) on delete set null,
  proposal_choice text not null default 'auto' check (proposal_choice in ('auto', 'owner')),
  diagnostic_id uuid references public.diagnostics (id) on delete set null,
  diagnostic_choice text not null default 'auto' check (diagnostic_choice in ('auto', 'owner')),
  -- {clé: {items: [{text, refs, provisional, suggested, date, date_status}], origin: crm|claude|owner, updated_at}}
  sections jsonb not null default '{}' check (jsonb_typeof(sections) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.project_onboarding for each row execute function public.tg_set_updated_at();

create table public.project_onboarding_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 120),
  label text not null check (char_length(btrim(label)) between 1 and 300),
  detail text check (detail is null or char_length(detail) <= 2000),
  kind text not null check (kind in ('proposal', 'date', 'text', 'choice', 'contact', 'link', 'conflict', 'client_request')),
  required boolean not null default true,
  priority integer not null default 100,
  options jsonb not null default '[]' check (jsonb_typeof(options) = 'array'),
  refs jsonb not null default '[]' check (jsonb_typeof(refs) = 'array'),
  target_section text,
  origin text not null default 'crm' check (origin in ('crm', 'claude', 'owner')),
  -- resolved : le point ne se pose plus (source ajoutée, section complétée)
  status text not null default 'open' check (status in ('open', 'answered', 'not_applicable', 'resolved')),
  answer text check (answer is null or char_length(answer) <= 5000),
  answer_file_id uuid references public.company_files (id) on delete set null,
  answered_by text check (answered_by is null or answered_by in ('owner', 'client')),
  answered_at timestamptz,
  client_task_id uuid references public.project_tasks (id) on delete set null,
  request_text text check (request_text is null or char_length(request_text) <= 5000),
  request_shared_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, key)
);
create index project_onboarding_items_task_idx on public.project_onboarding_items (client_task_id) where client_task_id is not null;
create trigger set_updated_at before update on public.project_onboarding_items for each row execute function public.tg_set_updated_at();

create table public.project_onboarding_decks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  version integer not null check (version >= 1),
  status text not null default 'requested' check (status in ('requested', 'uploading', 'ready', 'failed')),
  file_id uuid references public.company_files (id) on delete set null,
  error text check (error is null or char_length(error) <= 2000),
  session_url text check (session_url is null or (char_length(session_url) <= 500 and session_url ~ '^https://claude\.ai/')),
  requested_at timestamptz not null default now(),
  ready_at timestamptz,
  shared_at timestamptz,
  unique (project_id, version)
);

do $$
declare t text;
begin
  foreach t in array array['deal_closings', 'project_onboarding', 'project_onboarding_items', 'project_onboarding_decks'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Rouvrir une fiche gagnée : la vente n'est plus active (quel que soit le chemin utilisé).
create or replace function public.tg_deal_closing_reopen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deal_status = 'won' and new.deal_status <> 'won' then
    update public.deal_closings set reopened_at = now() where company_id = new.id and reopened_at is null;
  end if;
  return new;
end; $$;
create trigger deal_closing_reopen after update of deal_status on public.companies
  for each row execute function public.tg_deal_closing_reopen();

-- ---------------------------------------------------------------------------
-- État affiché : Préparation en cours / À compléter / Prêt à démarrer
-- ---------------------------------------------------------------------------
create or replace view public.project_onboarding_status with (security_invoker = true) as
  select o.project_id, o.closing_id, c.company_id, c.won_at, o.prep_state, o.prep_error, o.analysis_state, o.analysis_error,
         (select count(*) from public.project_onboarding_items i where i.project_id = o.project_id and i.status = 'open' and i.required)::int as open_required,
         (select count(*) from public.project_onboarding_items i where i.project_id = o.project_id and i.status = 'open' and not i.required)::int as open_optional,
         case
           when o.prep_state = 'pending' or (o.analysis_state = 'requested' and o.analysis_requested_at > now() - interval '20 minutes') then 'preparing'
           when o.prep_state = 'failed' or exists (select 1 from public.project_onboarding_items i where i.project_id = o.project_id and i.status = 'open' and i.required) then 'to_complete'
           else 'ready'
         end as status
    from public.project_onboarding o
    join public.deal_closings c on c.id = o.closing_id;
revoke all on public.project_onboarding_status from anon;
grant select on public.project_onboarding_status to authenticated;

-- ---------------------------------------------------------------------------
-- Gagné → vente → projet (une seule transaction ; la préparation vient ensuite)
-- ---------------------------------------------------------------------------
create or replace function public.project_win_deal(p_company uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c public.companies;
  v_closing public.deal_closings;
  v_project uuid;
  v_name text;
  v_people uuid[];
  v_created boolean := false;
begin
  perform public.assert_owner();
  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.deal_status <> 'won' then
    perform public.set_deal_status(p_company, 'won');
  end if;

  select * into v_closing from public.deal_closings where company_id = p_company and reopened_at is null;
  if not found then
    -- Fiche rouverte puis regagnée : même vente tant que son projet est actif.
    select d.* into v_closing from public.deal_closings d
      join public.project_onboarding o on o.closing_id = d.id
      join public.projects p on p.id = o.project_id
     where d.company_id = p_company and p.status not in ('termine', 'archive')
     order by d.won_at desc limit 1;
    if found then
      update public.deal_closings set reopened_at = null where id = v_closing.id;
    else
      insert into public.deal_closings (company_id, won_at)
      values (p_company, coalesce(case when c.deal_status = 'won' then c.deal_closed_at end, now()))
      returning * into v_closing;
    end if;
  end if;

  select project_id into v_project from public.project_onboarding where closing_id = v_closing.id;
  if v_project is null then
    v_name := left(btrim(c.name), 140);
    if exists (select 1 from public.projects where company_id = p_company and name = v_name) then
      v_name := v_name || ' · ' || to_char(v_closing.won_at, 'MM/YYYY');
    end if;
    select coalesce(array_agg(id order by created_at), '{}') into v_people from public.people where company_id = p_company and is_primary;
    if cardinality(v_people) = 0 then
      select coalesce(array_agg(id), '{}') into v_people from (select id from public.people where company_id = p_company order by created_at limit 1) x;
    end if;
    v_project := public.project_create(jsonb_build_object('company_id', p_company, 'name', v_name, 'status', 'a_preparer'), v_people);
    insert into public.project_onboarding (project_id, closing_id) values (v_project, v_closing.id);
    v_created := true;
  end if;
  return jsonb_build_object('closing_id', v_closing.id, 'project_id', v_project, 'created', v_created);
end;
$$;

-- ---------------------------------------------------------------------------
-- Préparation à partir des sources lisibles par le CRM
-- ---------------------------------------------------------------------------
create or replace function public.onboarding_ref(p_kind text, p_id uuid, p_label text)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('kind', p_kind, 'id', p_id, 'label', left(coalesce(p_label, ''), 200));
$$;

create or replace function public.onboarding_text(p jsonb)
returns text language sql immutable set search_path = '' as $$
  select case jsonb_typeof(p) when 'string' then p #>> '{}'
    when 'array' then (select string_agg(x, E'\n') from jsonb_array_elements_text(p) x) end;
$$;

-- Section du CRM : remplacée à chaque préparation, sauf si je l'ai modifiée ou si Claude l'a analysée.
create or replace function public.onboarding_put_section(p_sections jsonb, p_key text, p_items jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when coalesce(p_sections -> p_key ->> 'origin', 'crm') <> 'crm' then p_sections
    else p_sections || jsonb_build_object(p_key, jsonb_build_object('items', coalesce(p_items, '[]'::jsonb), 'origin', 'crm', 'updated_at', now())) end;
$$;

create or replace function public.onboarding_section_filled(p_sections jsonb, p_key text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(jsonb_array_length(p_sections -> p_key -> 'items'), 0) > 0;
$$;

-- security definer : Claude peut relancer la préparation après son analyse sans obtenir pour autant la
-- lecture des appels ou des fichiers ; la fonction ne renvoie que l'état.
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
  d public.deal_closings;
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
  if not found then raise exception 'Ce projet n''a pas de préparation (il n''a pas été créé depuis une vente)' using errcode = 'P0002'; end if;
  select * into p from public.projects where id = p_project;
  select * into d from public.deal_closings where id = o.closing_id;
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
    'text', 'Mission pour ' || c.name || ', signée le ' || to_char(d.won_at at time zone 'Europe/Paris', 'DD/MM/YYYY')
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
  return jsonb_build_object('status', (select status from public.project_onboarding_status where project_id = p_project));
end;
$$;

create or replace function public.onboarding_prep_failed(p_project uuid, p_message text)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding set prep_state = 'failed', prep_error = left(coalesce(nullif(btrim(p_message), ''), 'Préparation impossible.'), 2000)
   where project_id = p_project;
end; $$;

-- ---------------------------------------------------------------------------
-- Mes réponses et corrections
-- ---------------------------------------------------------------------------
create or replace function public.onboarding_save_section(p_project uuid, p_key text, p_items jsonb)
returns jsonb language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  if p_key not in ('mission', 'context', 'objectives', 'scope', 'deliverables', 'phases', 'first_actions', 'findings') then
    raise exception 'Section inconnue' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then raise exception '30 éléments maximum' using errcode = '22023'; end if;
  update public.project_onboarding
     set sections = sections || jsonb_build_object(p_key, jsonb_build_object('items', p_items, 'origin', 'owner', 'updated_at', now()))
   where project_id = p_project;
  if not found then raise exception 'Préparation introuvable' using errcode = 'P0002'; end if;
  return public.onboarding_prepare(p_project);
end; $$;

create or replace function public.onboarding_answer(p_item uuid, p_action text, p_value text default null, p_file uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  i public.project_onboarding_items;
  p public.projects;
  v_value text := nullif(btrim(coalesce(p_value, '')), '');
  v_date date;
  v_opt jsonb;
begin
  perform public.assert_owner();
  select * into i from public.project_onboarding_items where id = p_item for update;
  if not found then raise exception 'Point introuvable' using errcode = 'P0002'; end if;
  select * into p from public.projects where id = i.project_id;
  if p_action = 'not_applicable' then
    update public.project_onboarding_items set status = 'not_applicable', answered_by = 'owner', answered_at = now() where id = i.id;
  elsif p_action = 'reopen' then
    update public.project_onboarding_items set status = 'open', answer = null, answer_file_id = null, answered_by = null, answered_at = null where id = i.id;
  elsif p_action = 'date' then
    begin v_date := v_value::date; exception when others then raise exception 'Date invalide' using errcode = '22023'; end;
    if v_date is null then raise exception 'Date manquante' using errcode = '22023'; end if;
    if p.end_date is not null and p.end_date < v_date then raise exception 'La date de démarrage est après la fin prévue du projet' using errcode = '22023'; end if;
    update public.projects set start_date = v_date where id = p.id;
    update public.project_onboarding_items set status = 'answered', answer = to_char(v_date, 'DD/MM/YYYY'), answered_by = 'owner', answered_at = now() where id = i.id;
  elsif p_action = 'file' then
    if not exists (select 1 from public.company_files where id = p_file and company_id = p.company_id and status = 'ready') then
      raise exception 'Document introuvable sur cette fiche' using errcode = 'P0002';
    end if;
    if i.kind = 'proposal' then
      update public.project_onboarding set proposal_file_id = p_file, proposal_choice = 'owner' where project_id = p.id;
    end if;
    update public.project_onboarding_items set status = 'answered', answer_file_id = p_file, answered_by = 'owner', answered_at = now(),
           answer = (select display_name from public.company_files where id = p_file) where id = i.id;
  elsif p_action in ('text', 'choice') then
    if v_value is null then raise exception 'Réponse vide' using errcode = '22023'; end if;
    if p_action = 'choice' then
      select x into v_opt from jsonb_array_elements(i.options) x where x ->> 'label' = v_value limit 1;
      if v_opt is null then raise exception 'Option inconnue' using errcode = '22023'; end if;
      if v_opt ? 'diagnostic_id' then
        update public.project_onboarding set diagnostic_id = (v_opt ->> 'diagnostic_id')::uuid, diagnostic_choice = 'owner' where project_id = p.id;
      end if;
    end if;
    if char_length(v_value) > 5000 then raise exception '5 000 caractères maximum' using errcode = '22023'; end if;
    update public.project_onboarding_items set status = 'answered', answer = v_value, answered_by = 'owner', answered_at = now() where id = i.id;
    -- La réponse complète la section concernée (et la protège des préparations suivantes).
    if i.target_section is not null then
      update public.project_onboarding
         set sections = sections || jsonb_build_object(i.target_section, jsonb_build_object(
               'items', coalesce(sections -> i.target_section -> 'items', '[]'::jsonb)
                        || jsonb_build_array(jsonb_build_object('text', coalesce(v_opt ->> 'text', v_value), 'refs', coalesce(v_opt -> 'refs', '[]'::jsonb) || jsonb_build_array(public.onboarding_ref('answer', i.id, i.label)))),
               'origin', 'owner', 'updated_at', now()))
       where project_id = p.id;
    end if;
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return public.onboarding_prepare(p.id);
end; $$;

-- Demande au client : une tâche visible sur le portail, qui me revient quand il répond ou dépose le fichier.
create or replace function public.onboarding_share_request(p_item uuid, p_text text, p_person uuid default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  i public.project_onboarding_items;
  p public.projects;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_task uuid;
begin
  perform public.assert_owner();
  select * into i from public.project_onboarding_items where id = p_item for update;
  if not found then raise exception 'Point introuvable' using errcode = 'P0002'; end if;
  select * into p from public.projects where id = i.project_id;
  if v_text is null then raise exception 'Rédigez la demande avant de la partager' using errcode = '22023'; end if;
  if char_length(v_text) > 5000 then raise exception '5 000 caractères maximum' using errcode = '22023'; end if;
  if not p.portal_published then
    raise exception 'Le projet n''est pas publié sur le portail : publiez-le (onglet Général) avant de partager une demande. Rien n''a été partagé.' using errcode = '22023';
  end if;
  if p_person is not null and not exists (select 1 from public.project_members where project_id = p.id and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  if i.client_task_id is not null and exists (select 1 from public.project_tasks where id = i.client_task_id) then
    update public.project_tasks set description = v_text, assignee_person_id = p_person, status = case when status = 'termine' then 'a_faire' else status end,
           updated_by_kind = 'owner', updated_by_person = null
     where id = i.client_task_id;
    v_task := i.client_task_id;
  else
    insert into public.project_tasks (project_id, title, description, assignee_kind, assignee_person_id, visible_to_client)
    values (p.id, left(i.label, 300), v_text, 'client', p_person, true) returning id into v_task;
  end if;
  update public.project_onboarding_items set client_task_id = v_task, request_text = v_text, request_shared_at = now() where id = i.id;
  return jsonb_build_object('task_id', v_task);
end; $$;

-- Réception côté portail : réponse, fichier déposé ou tâche marquée faite par le client.
create or replace function public.tg_onboarding_client_comment()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.author_kind = 'client' then
    update public.project_onboarding_items
       set status = 'answered', answered_by = 'client', answered_at = now(),
           answer = left(coalesce(answer || E'\n', '') || new.body, 5000)
     where client_task_id = new.task_id and status in ('open', 'answered') and coalesce(answered_by, 'client') = 'client';
  end if;
  return null;
end; $$;
create trigger onboarding_client_comment after insert on public.project_task_comments
  for each row execute function public.tg_onboarding_client_comment();

create or replace function public.tg_onboarding_client_file()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'ready' and old.status <> 'ready' and new.uploaded_by_kind = 'client' then
    update public.project_onboarding_items i
       set status = 'answered', answered_by = 'client', answered_at = now(), answer_file_id = new.id,
           answer = coalesce(i.answer, 'Fichier déposé : ' || new.display_name)
      from public.project_files pf
     where pf.file_id = new.id and pf.task_id is not null and i.client_task_id = pf.task_id
       and i.status in ('open', 'answered') and coalesce(i.answered_by, 'client') = 'client';
  end if;
  return null;
end; $$;
create trigger onboarding_client_file after update of status on public.company_files
  for each row execute function public.tg_onboarding_client_file();

create or replace function public.tg_onboarding_client_task()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'termine' and old.status <> 'termine' and new.updated_by_kind = 'client' then
    update public.project_onboarding_items
       set status = 'answered', answered_by = 'client', answered_at = now(), answer = coalesce(answer, 'Marqué comme fait par le client')
     where client_task_id = new.id and status = 'open';
  end if;
  return null;
end; $$;
create trigger onboarding_client_task after update of status on public.project_tasks
  for each row execute function public.tg_onboarding_client_task();

-- ---------------------------------------------------------------------------
-- Analyse par Claude (routine ou conversation) : jamais au-dessus de mes corrections
-- ---------------------------------------------------------------------------
create or replace function public.onboarding_analysis_claim(p_project uuid)
returns boolean language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding set analysis_state = 'requested', analysis_requested_at = now(), analysis_error = null
   where project_id = p_project
     and not (analysis_state = 'requested' and analysis_requested_at > now() - interval '10 minutes');
  return found;
end; $$;

create or replace function public.onboarding_analysis_result(p_project uuid, p_session_url text, p_error text)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding
     set analysis_session_url = coalesce(p_session_url, analysis_session_url),
         analysis_state = case when p_error is null then analysis_state else 'failed' end,
         analysis_error = left(p_error, 2000)
   where project_id = p_project;
end; $$;

create or replace function public.onboarding_save_analysis(p_project uuid, p_sections jsonb, p_items jsonb, p_start_date date default null)
returns jsonb language plpgsql set search_path = '' as $$
declare
  o public.project_onboarding;
  k text;
  v jsonb;
  it jsonb;
  v_kept text[] := '{}';
  v_saved text[] := '{}';
  v_keys text[] := '{}';
  v_key text;
begin
  perform public.assert_owner();
  select * into o from public.project_onboarding where project_id = p_project for update;
  if not found then raise exception 'Préparation introuvable' using errcode = 'P0002'; end if;
  if jsonb_typeof(coalesce(p_sections, '{}')) <> 'object' or jsonb_typeof(coalesce(p_items, '[]')) <> 'array' then
    raise exception 'Format invalide' using errcode = '22023';
  end if;
  for k, v in select * from jsonb_each(coalesce(p_sections, '{}')) loop
    if k not in ('mission', 'context', 'objectives', 'scope', 'deliverables', 'phases', 'first_actions', 'findings') then
      raise exception 'Section inconnue : %', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 30 then raise exception 'Section % : 30 éléments maximum', k using errcode = '22023'; end if;
    if coalesce(o.sections -> k ->> 'origin', '') = 'owner' then
      v_kept := v_kept || k;
    else
      o.sections := o.sections || jsonb_build_object(k, jsonb_build_object('items', v, 'origin', 'claude', 'updated_at', now()));
      v_saved := v_saved || k;
    end if;
  end loop;
  if jsonb_array_length(coalesce(p_items, '[]')) > 20 then raise exception '20 points maximum' using errcode = '22023'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]')) loop
    v_key := 'claude:' || left(coalesce(nullif(btrim(it ->> 'key'), ''), md5(it ->> 'label')), 100);
    v_keys := v_keys || v_key;
    if coalesce(it ->> 'kind', 'text') not in ('text', 'choice', 'conflict', 'client_request', 'date') then
      raise exception 'Type de point inconnu : %', it ->> 'kind' using errcode = '22023';
    end if;
    insert into public.project_onboarding_items (project_id, key, label, detail, kind, required, priority, options, refs, target_section, origin)
    values (p_project, v_key, left(it ->> 'label', 300), left(it ->> 'detail', 2000), coalesce(it ->> 'kind', 'text'),
            coalesce((it ->> 'required')::boolean, false), coalesce((it ->> 'priority')::int, 50),
            coalesce(it -> 'options', '[]'), coalesce(it -> 'refs', '[]'), it ->> 'target_section', 'claude')
    on conflict (project_id, key) do update
       set label = excluded.label, detail = excluded.detail, kind = excluded.kind, required = excluded.required, priority = excluded.priority,
           options = excluded.options, refs = excluded.refs, target_section = excluded.target_section,
           status = case when project_onboarding_items.status = 'resolved' then 'open' else project_onboarding_items.status end
     where project_onboarding_items.status in ('open', 'resolved');
  end loop;
  update public.project_onboarding_items set status = 'resolved'
   where project_id = p_project and origin = 'claude' and status = 'open' and not (key = any (v_keys));
  -- Date confirmée par une source : seulement si je n'en ai pas déjà fixé une.
  if p_start_date is not null then
    update public.projects set start_date = p_start_date where id = p_project and start_date is null and (end_date is null or end_date >= p_start_date);
  end if;
  update public.project_onboarding set sections = o.sections, analysis_state = 'done', analysis_at = now(), analysis_error = null where project_id = p_project;
  perform public.onboarding_prepare(p_project);
  return jsonb_build_object('sections_enregistrees', v_saved, 'sections_conservees_car_corrigees', v_kept, 'points', jsonb_array_length(coalesce(p_items, '[]')),
    'status', (select status from public.project_onboarding_status where project_id = p_project));
end; $$;

-- ---------------------------------------------------------------------------
-- Slides d'onboarding : versions déposées dans un dossier interne du projet
-- ---------------------------------------------------------------------------
create or replace function public.onboarding_deck_request(p_project uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  d public.project_onboarding_decks;
begin
  perform public.assert_owner();
  perform 1 from public.project_onboarding where project_id = p_project for update;
  if not found then raise exception 'Préparation introuvable' using errcode = 'P0002'; end if;
  if (select status from public.project_onboarding_status where project_id = p_project) <> 'ready' then
    raise exception 'Le projet n''est pas prêt : complétez d''abord les points nécessaires au démarrage.' using errcode = '22023';
  end if;
  select * into d from public.project_onboarding_decks
   where project_id = p_project and status in ('requested', 'uploading') and requested_at > now() - interval '2 hours'
   order by version desc limit 1;
  if found then return jsonb_build_object('id', d.id, 'version', d.version, 'existing', true); end if;
  insert into public.project_onboarding_decks (project_id, version)
  values (p_project, coalesce((select max(version) from public.project_onboarding_decks where project_id = p_project), 0) + 1)
  returning * into d;
  return jsonb_build_object('id', d.id, 'version', d.version, 'existing', false);
end; $$;

create or replace function public.onboarding_deck_session(p_deck uuid, p_session_url text, p_error text)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding_decks
     set session_url = coalesce(p_session_url, session_url),
         status = case when p_error is null then status else 'failed' end, error = left(p_error, 2000)
   where id = p_deck and status in ('requested', 'uploading');
end; $$;

-- Claude ouvre le dépôt de la version demandée (ou d'une nouvelle version s'il n'y en a pas).
create or replace function public.onboarding_deck_open(p_project uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare
  d public.project_onboarding_decks;
begin
  perform public.assert_owner();
  perform 1 from public.project_onboarding where project_id = p_project for update;
  if not found then raise exception 'Préparation introuvable' using errcode = 'P0002'; end if;
  select * into d from public.project_onboarding_decks where project_id = p_project and status in ('requested', 'uploading') order by version desc limit 1;
  if not found then
    insert into public.project_onboarding_decks (project_id, version)
    values (p_project, coalesce((select max(version) from public.project_onboarding_decks where project_id = p_project), 0) + 1)
    returning * into d;
  end if;
  update public.project_onboarding_decks set status = 'uploading' where id = d.id;
  return jsonb_build_object('id', d.id, 'version', d.version, 'file_id', d.file_id,
    'company_id', (select company_id from public.projects where id = p_project));
end; $$;

create or replace function public.onboarding_deck_attach(p_deck uuid, p_file uuid)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding_decks set file_id = p_file where id = p_deck and status = 'uploading' and file_id is null;
  if not found then raise exception 'Aucun dépôt en cours pour cette version' using errcode = '22023'; end if;
end; $$;

-- Le fichier (déjà confirmé) rejoint les fichiers internes du projet, dossier « Onboarding (interne) ».
-- security definer : Claude peut ainsi créer ce dossier interne (jamais visible du client).
create or replace function public.onboarding_deck_ready(p_project uuid, p_version int)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  d public.project_onboarding_decks;
  v_folder uuid;
begin
  perform public.assert_owner();
  select * into d from public.project_onboarding_decks where project_id = p_project and version = p_version and status = 'uploading' for update;
  if not found or d.file_id is null then raise exception 'Aucun dépôt en cours pour cette version' using errcode = '22023'; end if;
  if not exists (select 1 from public.company_files where id = d.file_id and status = 'ready') then
    raise exception 'Le fichier n''a pas été reçu' using errcode = '22023';
  end if;
  select id into v_folder from public.project_folders where project_id = p_project and parent_id is null and name = 'Onboarding (interne)' and not visible_to_client limit 1;
  if v_folder is null then
    insert into public.project_folders (project_id, name, visible_to_client, client_can_upload) values (p_project, 'Onboarding (interne)', false, false)
    returning id into v_folder;
  end if;
  insert into public.project_files (project_id, file_id, folder_id) values (p_project, d.file_id, v_folder) on conflict (project_id, file_id) do nothing;
  update public.project_onboarding_decks set status = 'ready', ready_at = now(), error = null where id = d.id;
  return jsonb_build_object('version', d.version, 'folder_id', v_folder);
end; $$;

create or replace function public.onboarding_deck_failed(p_project uuid, p_message text)
returns void language plpgsql set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.project_onboarding_decks set status = 'failed', error = left(coalesce(nullif(btrim(p_message), ''), 'Génération impossible.'), 2000)
   where project_id = p_project and status in ('requested', 'uploading');
end; $$;

-- ---------------------------------------------------------------------------
-- Droits : ces fonctions sont réservées au propriétaire connecté (jamais anon).
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'project_win_deal(uuid)', 'onboarding_prepare(uuid)', 'onboarding_prep_failed(uuid, text)',
    'onboarding_save_section(uuid, text, jsonb)', 'onboarding_answer(uuid, text, text, uuid)', 'onboarding_share_request(uuid, text, uuid)',
    'onboarding_analysis_claim(uuid)', 'onboarding_analysis_result(uuid, text, text)', 'onboarding_save_analysis(uuid, jsonb, jsonb, date)',
    'onboarding_deck_request(uuid)', 'onboarding_deck_session(uuid, text, text)', 'onboarding_deck_open(uuid)',
    'onboarding_deck_attach(uuid, uuid)', 'onboarding_deck_ready(uuid, int)', 'onboarding_deck_failed(uuid, text)',
    'onboarding_ref(text, uuid, text)', 'onboarding_text(jsonb)', 'onboarding_put_section(jsonb, text, jsonb)', 'onboarding_section_filled(jsonb, text)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['tg_deal_closing_reopen()', 'tg_onboarding_client_comment()', 'tg_onboarding_client_file()', 'tg_onboarding_client_task()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
