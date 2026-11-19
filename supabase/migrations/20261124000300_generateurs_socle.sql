-- Socle commun des générateurs (proposition, onboarding), sur le modèle du dossier de diagnostic.
--
--   * generator_settings : sélection par défaut de la bibliothèque, par générateur.
--   * generator_dossiers : un dossier par demande (clé : un double clic rend le même), sources décochées,
--     sélection de bibliothèque ajustée pour ce dossier, état du lancement de la tâche Claude.
--   * generator_answers : une réponse par question, avec sa provenance. Une réponse corrigée par le propriétaire
--     n'est jamais remplacée par le CRM ou par Claude.
--   * generator_versions : v1, v2… avec les réponses qui l'ont produite. Une version validée ne se modifie plus.
--
-- Les questions vivent dans des fichiers de contenu de l'application (src/content/generators) : la base ne
-- connaît que leur clé. Le diagnostic n'est pas modifié par cette migration.
-- Droits : lecture pour le propriétaire (application et Claude). Créer, répondre en tant que propriétaire,
-- générer, valider et envoyer sont réservés à l'application. Claude ne lit une source que par generator_read,
-- pour la fiche du dossier, et seulement si elle n'a pas été décochée.

create table if not exists public.generator_settings (
  kind text primary key check (kind in ('proposal', 'onboarding')),
  library_item_ids uuid[] not null default '{}' check (cardinality(library_item_ids) <= 60),
  updated_at timestamptz not null default now()
);
-- au départ : la charte (« Marque et design ») de la bibliothèque de diagnostic, pour garder la même DA
insert into public.generator_settings (kind, library_item_ids)
select k, coalesce((select array_agg(f.id) from public.diagnostic_library_files f where f.status = 'ready' and f.category = 'brand'), '{}')
  from unnest(array['proposal', 'onboarding']) k
on conflict (kind) do nothing;

create table if not exists public.generator_dossiers (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('proposal', 'onboarding')),
  company_id uuid not null references public.companies (id) on delete restrict,
  project_id uuid references public.projects (id) on delete set null,
  request_key text not null unique check (char_length(request_key) between 8 and 100),
  excluded_sources text[] not null default '{}' check (cardinality(excluded_sources) <= 500),
  library_item_ids uuid[] not null default '{}' check (cardinality(library_item_ids) <= 60),
  prefill_state text not null default 'none' check (prefill_state in ('none', 'requested', 'done', 'failed')),
  trigger_ref text check (trigger_ref is null or char_length(trigger_ref) <= 40),
  triggered_at timestamptz,
  trigger_error text check (trigger_error is null or char_length(trigger_error) <= 500),
  session_url text check (session_url is null or (char_length(session_url) <= 500 and session_url ~ '^https://claude\.ai/')),
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists generator_dossiers_company_idx on public.generator_dossiers (company_id, kind, created_at desc);
drop trigger if exists set_updated_at on public.generator_dossiers;
create trigger set_updated_at before update on public.generator_dossiers
  for each row execute function public.tg_set_updated_at();

create table if not exists public.generator_answers (
  dossier_id uuid not null references public.generator_dossiers (id) on delete cascade,
  question_key text not null check (question_key ~ '^[a-z0-9_]{2,60}$'),
  value jsonb not null check (pg_column_size(value) <= 60000),
  provenance text check (provenance is null or char_length(provenance) <= 200),
  origin text not null check (origin in ('crm', 'claude', 'owner')),
  updated_at timestamptz not null default now(),
  primary key (dossier_id, question_key)
);

create table if not exists public.generator_versions (
  id uuid primary key default gen_random_uuid(),
  dossier_id uuid not null references public.generator_dossiers (id) on delete cascade,
  version integer not null check (version >= 1),
  request_key text not null unique check (char_length(request_key) between 8 and 100),
  answers jsonb not null default '{}' check (jsonb_typeof(answers) = 'object'),
  sources jsonb not null default '[]' check (jsonb_typeof(sources) = 'array'),
  library_item_ids uuid[] not null default '{}',
  feedback text check (feedback is null or char_length(feedback) <= 10000),
  slides_status text not null default 'pending' check (slides_status in ('pending', 'uploading', 'ready', 'failed')),
  slides_error text check (slides_error is null or char_length(slides_error) <= 2000),
  file_id uuid references public.company_files (id) on delete set null,
  ready_at timestamptz,
  validated_at timestamptz,
  sent_at timestamptz,
  sent_mail_id uuid references public.mail_messages (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (dossier_id, version)
);
create unique index if not exists generator_versions_one_open on public.generator_versions (dossier_id) where slides_status in ('pending', 'uploading');

-- Une version validée est figée : réponses, sources, bibliothèque et fichier ne changent plus (ni par l'application,
-- ni par Claude, ni par une autre fonction). Seuls « envoyée » et le retrait du fichier de la fiche restent possibles.
create or replace function public.tg_generator_version_frozen()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.validated_at is not null and (
       new.answers is distinct from old.answers or new.sources is distinct from old.sources
       or new.library_item_ids is distinct from old.library_item_ids or new.feedback is distinct from old.feedback
       or new.slides_status is distinct from old.slides_status or new.version is distinct from old.version
       or new.validated_at is distinct from old.validated_at
       or (new.file_id is distinct from old.file_id and new.file_id is not null)) then
    raise exception 'La version V% est validée : elle ne se modifie plus. Créez une nouvelle version.', old.version using errcode = '22023';
  end if;
  return new;
end; $$;
drop trigger if exists generator_version_frozen on public.generator_versions;
create trigger generator_version_frozen before update on public.generator_versions
  for each row execute function public.tg_generator_version_frozen();

create or replace function public.tg_companies_merge_generators()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.generator_dossiers set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end; $$;
drop trigger if exists companies_merge_generators on public.companies;
create trigger companies_merge_generators after update of merged_into_id on public.companies
  for each row execute function public.tg_companies_merge_generators();

do $$
declare t text;
begin
  foreach t in array array['generator_settings', 'generator_dossiers', 'generator_answers', 'generator_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_select on public.%I', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  foreach t in array array['generator_dossiers', 'generator_versions'] loop
    execute format('drop trigger if exists activity_log on public.%I', t);
    execute format('create trigger activity_log after insert or update or delete on public.%I for each row execute function public.tg_activity_log()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Réglage : sélection par défaut de la bibliothèque
-- ---------------------------------------------------------------------------
create or replace function public.generator_clean_library(p_items uuid[])
returns uuid[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f.id order by f.display_name), '{}')
    from public.diagnostic_library_files f where f.id = any (coalesce(p_items, '{}')) and f.status = 'ready';
$$;

create or replace function public.generator_set_default_library(p_kind text, p_items uuid[])
returns uuid[] language plpgsql security definer set search_path = '' as $$
declare v uuid[];
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Sélection de la bibliothèque');
  v := public.generator_clean_library(p_items);
  update public.generator_settings set library_item_ids = v, updated_at = now() where kind = p_kind;
  if not found then raise exception 'Générateur inconnu' using errcode = '22023'; end if;
  return v;
end; $$;

-- ---------------------------------------------------------------------------
-- Dossier
-- ---------------------------------------------------------------------------
create or replace function public.generator_start(p_kind text, p_company uuid, p_project uuid, p_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_new boolean := false;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Création d''un dossier');
  if p_kind not in ('proposal', 'onboarding') then raise exception 'Générateur inconnu' using errcode = '22023'; end if;
  if p_project is not null and not exists (select 1 from public.projects where id = p_project and company_id = p_company) then
    raise exception 'Ce projet n''appartient pas à cette fiche' using errcode = '22023';
  end if;
  insert into public.generator_dossiers (kind, company_id, project_id, request_key, library_item_ids)
  select p_kind, p_company, p_project, p_key, public.generator_clean_library(s.library_item_ids)
    from public.generator_settings s where s.kind = p_kind
  on conflict (request_key) do nothing
  returning id into v_id;
  v_new := v_id is not null;
  if v_id is null then
    select id into v_id from public.generator_dossiers where request_key = p_key and company_id = p_company and kind = p_kind;
  end if;
  if v_id is null then raise exception 'Demande invalide' using errcode = '22023'; end if;
  return jsonb_build_object('id', v_id, 'created', v_new);
end; $$;

create or replace function public.generator_company(p_id uuid)
returns uuid language plpgsql stable security definer set search_path = '' as $$
declare v uuid;
begin
  perform public.assert_owner();
  select company_id into v from public.generator_dossiers where id = p_id;
  if v is null then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  return v;
end; $$;

-- Sélection du dossier : sources décochées et éléments de bibliothèque, ajustables jusqu'à la génération.
create or replace function public.generator_set_selection(p_id uuid, p_excluded text[], p_library uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Choix des sources');
  update public.generator_dossiers
     set excluded_sources = coalesce((select array_agg(distinct x) from unnest(coalesce(p_excluded, '{}')) x
                                       where x <> 'fiche' and x ~ '^[a-z_]{2,20}(:[0-9a-f-]{36})?$'), '{}'),
         library_item_ids = case when p_library is null then library_item_ids else public.generator_clean_library(p_library) end
   where id = p_id;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
end; $$;

-- Réponses. p_answers : [{ "key", "value", "provenance" }]. Le propriétaire écrit toujours ; le CRM et Claude ne
-- remplacent jamais une réponse du propriétaire, et le CRM ne remplace pas une réponse proposée par Claude.
-- Un appel venu de Claude est toujours enregistré comme tel, quel que soit p_origin.
create or replace function public.generator_save_answers(p_id uuid, p_answers jsonb, p_origin text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_origin text := case when public.current_actor() = 'claude' then 'claude' else p_origin end; v_count integer;
begin
  perform public.assert_owner();
  if v_origin not in ('crm', 'claude', 'owner') then raise exception 'Origine invalide' using errcode = '22023'; end if;
  if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 100 then raise exception 'Réponses invalides' using errcode = '22023'; end if;
  perform 1 from public.generator_dossiers where id = p_id for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  -- une réponse vidée par le propriétaire disparaît : la question redevient « à compléter »
  if v_origin = 'owner' then
    delete from public.generator_answers a using jsonb_array_elements(p_answers) e
     where a.dossier_id = p_id and a.question_key = e ->> 'key'
       and (e -> 'value' is null or e -> 'value' in ('null'::jsonb, '""'::jsonb, '[]'::jsonb));
  end if;
  with incoming as (
    select e ->> 'key' as k, e -> 'value' as v, nullif(btrim(left(e ->> 'provenance', 200)), '') as p
      from jsonb_array_elements(p_answers) e
     where e ->> 'key' ~ '^[a-z0-9_]{2,60}$' and e -> 'value' is not null and e -> 'value' not in ('null'::jsonb, '""'::jsonb, '[]'::jsonb)
  ), written as (
    insert into public.generator_answers as a (dossier_id, question_key, value, provenance, origin)
    select p_id, k, v, case when v_origin = 'owner' then null else p end, v_origin from incoming
    on conflict (dossier_id, question_key) do update
      set value = excluded.value, provenance = excluded.provenance, origin = excluded.origin, updated_at = now()
      where v_origin = 'owner' or (v_origin = 'claude' and a.origin <> 'owner') or (v_origin = 'crm' and a.origin = 'crm')
    returning 1
  )
  select count(*) into v_count from written;
  if v_origin = 'claude' then
    update public.generator_dossiers set prefill_state = 'done', last_error = null where id = p_id and prefill_state in ('requested', 'failed');
  end if;
  return v_count;
end; $$;

-- ---------------------------------------------------------------------------
-- Sources : ce que le CRM sait déjà sur la fiche du dossier, et ce qui est retenu
-- ---------------------------------------------------------------------------
create or replace function public.generator_sources(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_company uuid := public.generator_company(p_id); v_excluded text[];
begin
  select excluded_sources into v_excluded from public.generator_dossiers where id = p_id;
  return (
    select coalesce(jsonb_agg(jsonb_build_object('cle', s.cle, 'type', s.type, 'titre', s.titre, 'date', s.at,
                                                 'retenue', not (s.cle = any (v_excluded))) order by s.rang, s.at desc nulls last), '[]')
    from (
      select 'fiche' as cle, 'fiche' as type, c.name as titre, c.updated_at as at, 0 as rang from public.companies c where c.id = v_company
      union all
      select 'personnes', 'personnes', count(*) || ' interlocuteur(s)', max(p.updated_at), 1 from public.people p where p.company_id = v_company having count(*) > 0
      union all
      select 'diagnostic:' || d.id, 'diagnostic', 'Diagnostic', d.created_at, 2 from public.diagnostics d
       where d.company_id = v_company and (d.summary is not null or exists (select 1 from public.diagnostic_versions v where v.diagnostic_id = d.id and v.status = 'ready'))
      union all
      select 'proposition:' || v.id, 'proposition', 'Proposition V' || v.version, coalesce(v.sent_at, v.validated_at), 3
        from public.generator_versions v join public.generator_dossiers g on g.id = v.dossier_id
       where g.company_id = v_company and g.kind = 'proposal' and v.validated_at is not null and g.id <> p_id
      union all
      select 'appel:' || f.id, 'appel', f.title, f.occurred_at, 4 from public.fireflies_calls f where f.company_id = v_company and f.link_state = 'linked'
      union all
      select 'email:' || m.id, 'email', coalesce(nullif(m.subject, ''), '(sans objet)'), m.sent_at, 5 from public.mail_messages m where m.company_id = v_company and m.status = 'accepted'
      union all
      select 'rdv:' || b.id, 'rdv', 'Rendez-vous', b.starts_at, 6 from public.appt_bookings b where b.company_id = v_company and b.status = 'confirmed'
      union all
      select 'notes', 'notes', count(*) || ' note(s) et échange(s) de l''historique', max(i.occurred_at), 7 from public.interactions i
       where i.company_id = v_company and i.kind in ('note', 'message_in', 'message_out', 'call', 'meeting') having count(*) > 0
      union all
      select 'fichier:' || cf.id, 'fichier', cf.display_name, cf.created_at, 8 from public.company_files cf where cf.company_id = v_company and cf.status = 'ready'
    ) s
  );
end; $$;

-- Une source n'est lisible que si elle appartient à la fiche du dossier et n'a pas été décochée.
create or replace function public.generator_source_allowed(p_id uuid, p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from jsonb_array_elements(public.generator_sources(p_id)) e where e ->> 'cle' = p_key and (e ->> 'retenue')::boolean);
$$;

-- Lecture d'une source par sa clé (« appel:<id> », « email:<id> », « notes »…), par pages.
create or replace function public.generator_read(p_id uuid, p_key text, p_offset integer default 0, p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_company uuid := public.generator_company(p_id);
  v_type text := split_part(p_key, ':', 1);
  v_ref uuid := case when p_key ~ ':[0-9a-f-]{36}$' then split_part(p_key, ':', 2)::uuid end;
  v_off integer := greatest(coalesce(p_offset, 0), 0);
  v_lim integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
  v_lines jsonb; v_thread text;
begin
  if not public.generator_source_allowed(p_id, p_key) then
    raise exception 'Source introuvable ou écartée pour ce dossier' using errcode = 'P0002';
  end if;
  if v_type = 'fiche' then
    return (select jsonb_build_object('nom', c.name, 'site', c.website, 'description', c.description, 'montant', c.amount,
                                      'montant_mensuel', c.amount_recurring, 'tags', c.tags,
                                      'pipeline', (select name from public.pipelines where id = c.pipeline_id),
                                      'etape', (select name from public.stages where id = c.stage_id), 'statut', c.deal_status)
              from public.companies c where c.id = v_company);
  elsif v_type = 'personnes' then
    return (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'prenom', p.first_name, 'nom', p.last_name, 'fonction', p.title,
                                                         'email', p.email, 'telephone', p.phone, 'principal', p.is_primary)
                                      order by p.is_primary desc, p.created_at), '[]')
              from public.people p where p.company_id = v_company);
  elsif v_type = 'diagnostic' then
    return (select jsonb_build_object('synthese', d.summary, 'sources', d.sources,
              'questions', (select coalesce(jsonb_agg(jsonb_build_object('question', q.question, 'reponse', case when q.dont_know then 'Je ne sais pas' else q.answer end) order by q.position), '[]')
                              from public.diagnostic_questions q where q.diagnostic_id = d.id),
              'derniere_version', (select jsonb_build_object('version', v.version, 'fichier', 'fichier:' || v.file_id, 'validee_le', v.validated_at)
                                     from public.diagnostic_versions v where v.diagnostic_id = d.id and v.status = 'ready' order by v.version desc limit 1))
              from public.diagnostics d where d.id = v_ref and d.company_id = v_company);
  elsif v_type = 'proposition' then
    return (select jsonb_build_object('version', v.version, 'validee_le', v.validated_at, 'envoyee_le', v.sent_at, 'reponses', v.answers,
                                      'fichier', case when v.file_id is not null then 'fichier:' || v.file_id end)
              from public.generator_versions v join public.generator_dossiers g on g.id = v.dossier_id
             where v.id = v_ref and g.company_id = v_company);
  elsif v_type = 'appel' then
    select t.lines into v_lines from public.fireflies_calls c left join public.fireflies_call_transcripts t on t.call_id = c.id
     where c.id = v_ref and c.company_id = v_company and c.link_state = 'linked';
    return (select jsonb_build_object('titre', c.title, 'date', c.occurred_at, 'duree_minutes', c.duration_minutes, 'participants', c.participants,
              'resume', c.summary, 'note_interne', c.internal_note, 'total_lignes', coalesce(jsonb_array_length(v_lines), 0),
              'lignes', coalesce((select jsonb_agg(e order by ord) from jsonb_array_elements(coalesce(v_lines, '[]')) with ordinality as t(e, ord)
                                   where ord > v_off and ord <= v_off + v_lim), '[]'))
              from public.fireflies_calls c where c.id = v_ref);
  elsif v_type = 'email' then
    select provider_thread_id into v_thread from public.mail_messages where id = v_ref and company_id = v_company and status = 'accepted';
    return (select coalesce(jsonb_agg(jsonb_build_object('date', m.sent_at, 'a', m.to_addrs, 'cc', m.cc_addrs, 'objet', m.subject, 'corps', m.body_text) order by m.sent_at), '[]')
              from (select * from public.mail_messages
                     where company_id = v_company and status = 'accepted' and (id = v_ref or (v_thread is not null and provider_thread_id = v_thread))
                     order by sent_at offset v_off limit least(v_lim, 20)) m);
  elsif v_type = 'rdv' then
    return (select jsonb_build_object('debut', b.starts_at, 'fin', b.ends_at, 'issue', b.outcome, 'prenom', b.first_name, 'nom', b.last_name,
                                      'reponses', b.answers, 'note_interne', b.internal_note)
              from public.appt_bookings b where b.id = v_ref and b.company_id = v_company);
  elsif v_type = 'notes' then
    return (select coalesce(jsonb_agg(jsonb_build_object('date', i.occurred_at, 'type', i.kind, 'canal', i.channel, 'texte', i.content) order by i.occurred_at desc), '[]')
              from (select * from public.interactions where company_id = v_company and kind in ('note', 'message_in', 'message_out', 'call', 'meeting')
                     order by occurred_at desc offset v_off limit least(v_lim, 100)) i);
  elsif v_type = 'fichier' then
    return (select jsonb_build_object('id', f.id, 'nom', f.display_name, 'type', f.mime_type, 'categorie', f.category, 'taille_octets', f.size_bytes)
              from public.company_files f where f.id = v_ref and f.company_id = v_company and f.status = 'ready');
  end if;
  raise exception 'Source inconnue' using errcode = '22023';
end; $$;

-- ---------------------------------------------------------------------------
-- Lancement de la tâche Claude : une étape (p_ref : « prefill », « slides:3 »…) ne se réserve qu'une fois.
-- Un échec, ou dix minutes sans résultat (session fermée, délai dépassé), la rend relançable.
-- ---------------------------------------------------------------------------
create or replace function public.generator_claim_trigger(p_id uuid, p_ref text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Lancement d''une génération');
  update public.generator_dossiers
     set trigger_ref = p_ref, triggered_at = now(), trigger_error = null, last_error = null,
         prefill_state = case when p_ref = 'prefill' then 'requested' else prefill_state end
   where id = p_id
     and (trigger_ref is distinct from p_ref or trigger_error is not null or last_error is not null or triggered_at < now() - interval '10 minutes');
  return found;
end; $$;

create or replace function public.generator_trigger_result(p_id uuid, p_session_url text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Lancement d''une génération');
  update public.generator_dossiers
     set session_url = coalesce(p_session_url, session_url), trigger_error = left(p_error, 500),
         prefill_state = case when p_error is not null and trigger_ref = 'prefill' then 'failed' else prefill_state end
   where id = p_id;
end; $$;

-- Échec signalé par la session Claude (ou par l'application) : l'étape en cours devient relançable, les réponses restent.
create or replace function public.generator_report_failure(p_id uuid, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_msg text := left(coalesce(nullif(btrim(p_message), ''), 'La génération a échoué.'), 2000);
begin
  perform public.assert_owner();
  update public.generator_dossiers set last_error = v_msg,
         prefill_state = case when prefill_state = 'requested' then 'failed' else prefill_state end
   where id = p_id;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  update public.generator_versions set slides_status = 'failed', slides_error = v_msg
   where dossier_id = p_id and slides_status in ('pending', 'uploading');
end; $$;

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------
-- « Générer » : fige les réponses du moment dans la version suivante. La même clé (double clic, reprise) rend la
-- même version ; une génération déjà en cours est rendue telle quelle : jamais deux versions pour un clic.
create or replace function public.generator_generate(p_id uuid, p_key text, p_feedback text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.generator_versions; v_dossier public.generator_dossiers;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Génération');
  select * into v_dossier from public.generator_dossiers where id = p_id for update;
  if v_dossier.id is null then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  select * into v from public.generator_versions where request_key = p_key;
  if v.id is not null and v.dossier_id <> p_id then raise exception 'Demande invalide' using errcode = '22023'; end if;
  if v.id is null then
    select * into v from public.generator_versions where dossier_id = p_id and slides_status in ('pending', 'uploading');
  end if;
  if v.id is not null then
    return jsonb_build_object('id', v.id, 'version', v.version, 'created', false);
  end if;
  insert into public.generator_versions (dossier_id, version, request_key, answers, sources, library_item_ids, feedback)
  select p_id,
         coalesce((select max(version) from public.generator_versions where dossier_id = p_id), 0) + 1,
         p_key,
         coalesce((select jsonb_object_agg(a.question_key, jsonb_build_object('value', a.value, 'provenance', a.provenance, 'origin', a.origin))
                     from public.generator_answers a where a.dossier_id = p_id), '{}'),
         coalesce((select jsonb_agg(e) from jsonb_array_elements(public.generator_sources(p_id)) e where (e ->> 'retenue')::boolean), '[]'),
         public.generator_clean_library(v_dossier.library_item_ids),
         nullif(btrim(p_feedback), '')
  returning * into v;
  update public.generator_dossiers set last_error = null where id = p_id;
  return jsonb_build_object('id', v.id, 'version', v.version, 'created', true);
end; $$;

-- Relance des slides d'une version en échec (les réponses de la version ne changent pas).
create or replace function public.generator_retry_slides(p_version uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_dossier uuid;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Relance d''une génération');
  update public.generator_versions set slides_status = 'pending', slides_error = null
   where id = p_version and slides_status = 'failed' and validated_at is null returning dossier_id into v_dossier;
  if v_dossier is not null then
    -- l'étape est libérée une seule fois : un double clic sur « Réessayer » ne lance qu'une session
    update public.generator_dossiers set last_error = null, trigger_ref = null where id = v_dossier;
    return v_dossier;
  end if;
  -- génération interrompue sans échec signalé : relançable après dix minutes (generator_claim_trigger)
  select dossier_id into v_dossier from public.generator_versions where id = p_version and slides_status in ('pending', 'uploading');
  if v_dossier is null then raise exception 'Cette version n''est pas à relancer' using errcode = '22023'; end if;
  return v_dossier;
end; $$;

-- Dépôt du PDF par la session : ouvre (ou reprend) le dépôt de la version en cours.
create or replace function public.generator_version_open(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v public.generator_versions; v_company uuid;
begin
  perform public.assert_owner();
  select company_id into v_company from public.generator_dossiers where id = p_id for update;
  if v_company is null then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  select * into v from public.generator_versions where dossier_id = p_id and slides_status in ('pending', 'uploading', 'failed') and validated_at is null
   order by version desc limit 1;
  if v.id is null then
    raise exception 'Aucune version à produire : la génération se lance dans l''application' using errcode = '22023';
  end if;
  update public.generator_versions set slides_status = 'uploading', slides_error = null where id = v.id;
  return jsonb_build_object('id', v.id, 'version', v.version, 'file_id', v.file_id, 'company_id', v_company);
end; $$;

create or replace function public.generator_version_attach(p_version uuid, p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.generator_versions v set file_id = p_file
    from public.generator_dossiers d, public.company_files f
   where v.id = p_version and v.slides_status = 'uploading' and d.id = v.dossier_id and f.id = p_file and f.company_id = d.company_id;
  if not found then raise exception 'Fichier ou version invalide' using errcode = '22023'; end if;
end; $$;

create or replace function public.generator_version_ready(p_id uuid, p_version integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.generator_versions set slides_status = 'ready', ready_at = now(), slides_error = null
   where dossier_id = p_id and version = p_version and slides_status = 'uploading' and file_id is not null;
  if not found then raise exception 'Aucun dépôt en cours pour cette version' using errcode = '22023'; end if;
  update public.generator_dossiers set last_error = null, trigger_error = null where id = p_id;
end; $$;

-- Validation : réservée au propriétaire, dans l'application. Répétée, elle ne change rien.
create or replace function public.generator_validate(p_version uuid)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v public.generator_versions;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Validation');
  select * into v from public.generator_versions where id = p_version for update;
  if v.id is null then raise exception 'Version introuvable' using errcode = 'P0002'; end if;
  if v.validated_at is not null then return v.validated_at; end if;
  if v.slides_status <> 'ready' then raise exception 'Les slides de cette version ne sont pas encore reçues' using errcode = '22023'; end if;
  update public.generator_versions set validated_at = now() where id = p_version returning validated_at into v.validated_at;
  return v.validated_at;
end; $$;

-- Envoi : noté une seule fois, sur une version validée.
create or replace function public.generator_mark_sent(p_version uuid, p_mail uuid default null)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v public.generator_versions;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Envoi');
  select * into v from public.generator_versions where id = p_version for update;
  if v.id is null then raise exception 'Version introuvable' using errcode = 'P0002'; end if;
  if v.validated_at is null then raise exception 'Validez la version avant de l''envoyer' using errcode = '22023'; end if;
  if v.sent_at is not null then return v.sent_at; end if;
  update public.generator_versions set sent_at = now(), sent_mail_id = p_mail where id = p_version returning sent_at into v.sent_at;
  return v.sent_at;
end; $$;

do $$
declare f text;
begin
  foreach f in array array[
    'generator_clean_library(uuid[])', 'generator_set_default_library(text, uuid[])', 'generator_start(text, uuid, uuid, text)',
    'generator_company(uuid)', 'generator_set_selection(uuid, text[], uuid[])', 'generator_save_answers(uuid, jsonb, text)',
    'generator_sources(uuid)', 'generator_source_allowed(uuid, text)', 'generator_read(uuid, text, integer, integer)',
    'generator_claim_trigger(uuid, text)', 'generator_trigger_result(uuid, text, text)', 'generator_report_failure(uuid, text)',
    'generator_generate(uuid, text, text)', 'generator_retry_slides(uuid)', 'generator_version_open(uuid)',
    'generator_version_attach(uuid, uuid)', 'generator_version_ready(uuid, integer)', 'generator_validate(uuid)', 'generator_mark_sent(uuid, uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['tg_generator_version_frozen()', 'tg_companies_merge_generators()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
