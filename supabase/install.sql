-- Fichier généré par scripts/bundle-sql.mjs à partir de supabase/migrations.
-- À exécuter une seule fois sur un projet Supabase vide.

-- ===== 20261029000100_schema.sql =====
-- Cely CRM — schéma principal
-- Une entreprise = un prospect = une opportunité = une fiche (table companies).
-- Toutes les tables sont protégées par RLS et réservées au propriétaire (app_owner).

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------------
-- Accès : un seul compte autorisé
-- ---------------------------------------------------------------------------

create table public.app_owner (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.is_app_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_owner where user_id = (select auth.uid()));
$$;

-- 'claude' lorsque la requête vient d'un jeton OAuth (connecteur MCP), sinon 'user'.
create or replace function public.current_actor()
returns text
language sql
stable
set search_path = ''
as $$
  select case when coalesce(auth.jwt() ->> 'client_id', '') <> '' then 'claude' else 'user' end;
$$;

create or replace function public.assert_owner()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_app_owner() then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.today_paris()
returns date
language sql
stable
as $$ select (now() at time zone 'Europe/Paris')::date; $$;

-- ---------------------------------------------------------------------------
-- Normalisation (source de vérité côté serveur ; miroir TS dans src/lib/crm/normalize.ts)
-- ---------------------------------------------------------------------------

create or replace function public.f_unaccent(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, t); $$;

create or replace function public.norm_email(t text)
returns text
language sql
immutable
as $$ select nullif(lower(btrim(coalesce(t, ''))), ''); $$;

create or replace function public.norm_domain(t text)
returns text
language plpgsql
immutable
as $$
declare
  v text := lower(btrim(coalesce(t, '')));
begin
  v := regexp_replace(v, '^[a-z][a-z0-9+.-]*://', '');   -- protocole
  v := regexp_replace(v, '^[^/@]*@', '');                -- identifiants éventuels
  v := regexp_replace(v, '[/?#].*$', '');                -- chemin, requête, ancre
  v := regexp_replace(v, ':\d+$', '');                   -- port
  v := regexp_replace(v, '^www\d*\.', '');               -- préfixe www
  v := regexp_replace(v, '\.+$', '');
  if v = '' or position('.' in v) = 0 then
    return null;
  end if;
  return v;
end;
$$;

create or replace function public.email_domain(t text)
returns text
language sql
immutable
as $$ select nullif(split_part(public.norm_email(t), '@', 2), ''); $$;

create or replace function public.is_free_email_domain(d text)
returns boolean
language sql
immutable
as $$
  select lower(coalesce(d, '')) = any (array[
    'gmail.com','googlemail.com','outlook.com','outlook.fr','hotmail.com','hotmail.fr','live.com','live.fr',
    'msn.com','yahoo.com','yahoo.fr','ymail.com','icloud.com','me.com','mac.com','aol.com','proton.me',
    'protonmail.com','pm.me','gmx.com','gmx.fr','gmx.de','orange.fr','wanadoo.fr','free.fr','sfr.fr',
    'laposte.net','bbox.fr','neuf.fr','numericable.fr','yandex.com','yandex.ru','zoho.com','mail.com','hey.com'
  ]);
$$;

create or replace function public.norm_linkedin(t text)
returns text
language plpgsql
immutable
as $$
declare
  v text := lower(btrim(coalesce(t, '')));
begin
  if v = '' then return null; end if;
  v := regexp_replace(v, '^[a-z]+://', '');
  v := regexp_replace(v, '[?#].*$', '');
  v := regexp_replace(v, '^([a-z]{2,3}|www|m)\.linkedin\.com', 'linkedin.com');
  v := regexp_replace(v, '/+$', '');
  return nullif(v, '');
end;
$$;

create or replace function public.norm_company_name(t text)
returns text
language plpgsql
immutable
as $$
declare
  v text := lower(public.f_unaccent(btrim(coalesce(t, ''))));
begin
  v := replace(v, '&', ' et ');
  v := regexp_replace(v, '[^a-z0-9]+', ' ', 'g');
  v := ' ' || v || ' ';
  v := regexp_replace(v,
    ' (sas|sasu|sarl|sa|eurl|sci|scop|snc|inc|ltd|llc|gmbh|bv|srl|spa|plc|corp|co|company|group|groupe|the|le|la|les)(?= )',
    '', 'g');
  v := btrim(regexp_replace(v, '\s+', ' ', 'g'));
  return nullif(v, '');
end;
$$;

create or replace function public.norm_person_name(first_name text, last_name text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(
    regexp_replace(lower(public.f_unaccent(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))), '[^a-z0-9]+', ' ', 'g'),
    '\s+', ' ', 'g')), '');
$$;

-- ---------------------------------------------------------------------------
-- Référentiels
-- ---------------------------------------------------------------------------

create table public.lead_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create unique index lead_sources_name_uniq on public.lead_sources (lower(btrim(name)));

create table public.pipelines (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  pipeline_id uuid not null references public.pipelines (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  position int not null default 0,
  created_at timestamptz not null default now()
);
create index stages_pipeline_idx on public.stages (pipeline_id, position);

-- ---------------------------------------------------------------------------
-- La fiche
-- ---------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  name_norm text,
  website text check (website is null or char_length(website) <= 300),
  domain_norm text,
  description text check (description is null or char_length(description) <= 5000),
  source_id uuid references public.lead_sources (id) on delete set null,
  tags text[] not null default '{}',
  prospect_status text not null default 'nouveau'
    check (prospect_status in ('nouveau','contacte','en_discussion','qualifie','pas_interesse')),
  -- suivi commercial : une seule opportunité active par fiche
  pipeline_id uuid references public.pipelines (id) on delete restrict,
  stage_id uuid references public.stages (id) on delete restrict,
  deal_status text not null default 'open' check (deal_status in ('open','won','lost')),
  amount numeric(12,2) check (amount is null or amount >= 0),
  expected_close_date date,
  lost_reason text check (lost_reason is null or char_length(lost_reason) <= 500),
  deal_closed_at timestamptz,
  last_interaction_at timestamptz,
  archived_at timestamptz,
  merged_into_id uuid references public.companies (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_stage_needs_pipeline check (stage_id is null or pipeline_id is not null)
);
create index companies_domain_idx on public.companies (domain_norm) where merged_into_id is null;
create index companies_name_trgm on public.companies using gin (name_norm extensions.gin_trgm_ops);
create index companies_stage_idx on public.companies (stage_id);
create index companies_tags_idx on public.companies using gin (tags);

create table public.people (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  first_name text check (first_name is null or char_length(first_name) <= 100),
  last_name text check (last_name is null or char_length(last_name) <= 100),
  full_name_norm text,
  title text check (title is null or char_length(title) <= 150),
  email text check (email is null or char_length(email) <= 254),
  email_norm text,
  phone text check (phone is null or char_length(phone) <= 50),
  linkedin_url text check (linkedin_url is null or char_length(linkedin_url) <= 300),
  linkedin_norm text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint people_has_identity check (
    coalesce(btrim(first_name), '') <> '' or coalesce(btrim(last_name), '') <> ''
    or coalesce(btrim(email), '') <> '' or coalesce(btrim(linkedin_url), '') <> '')
);
create index people_company_idx on public.people (company_id);
create index people_email_idx on public.people (email_norm);
create index people_linkedin_idx on public.people (linkedin_norm);
create unique index people_one_primary on public.people (company_id) where is_primary;

-- Historique : notes, messages, appels, rendez-vous, mouvements, actions…
create table public.interactions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  person_id uuid references public.people (id) on delete set null,
  kind text not null check (kind in (
    'note','message_out','message_in','call','meeting',
    'stage_change','deal_status','prospecting','task_done','merge','system')),
  channel text check (channel is null or channel in ('linkedin','email','phone','other')),
  occurred_at timestamptz not null default now(),
  content text check (content is null or char_length(content) <= 20000),
  -- distingue un texte fourni par l'utilisateur d'une suggestion rédigée par Claude
  content_origin text not null default 'user' check (content_origin in ('user','claude_suggestion','system')),
  source text not null default 'user' check (source in ('user','claude','import','system')),
  campaign_participant_id uuid,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index interactions_company_idx on public.interactions (company_id, occurred_at desc);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  person_id uuid references public.people (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  due_date date not null,
  done_at timestamptz,
  source text not null default 'user' check (source in ('user','claude')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tasks_open_idx on public.tasks (due_date) where done_at is null;
create index tasks_company_idx on public.tasks (company_id);

-- ---------------------------------------------------------------------------
-- Prospection : listes, modèles, campagnes
-- ---------------------------------------------------------------------------

create table public.lists (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Une liste ne contient que des références : supprimer la liste ne touche pas aux fiches.
create table public.list_members (
  list_id uuid not null references public.lists (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete restrict,
  added_at timestamptz not null default now(),
  primary key (list_id, company_id)
);
create index list_members_company_idx on public.list_members (company_id);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.template_steps (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates (id) on delete cascade,
  position int not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  channel text not null check (channel in ('linkedin','email','phone','other')),
  delay_days int not null default 0 check (delay_days between 0 and 365),
  message text check (message is null or char_length(message) <= 5000),
  unique (template_id, position)
);

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  template_id uuid references public.templates (id) on delete set null,
  template_name text,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Copie figée des étapes du modèle au moment de la création de la campagne.
create table public.campaign_steps (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  position int not null,
  name text not null,
  channel text not null check (channel in ('linkedin','email','phone','other')),
  delay_days int not null default 0,
  message text,
  unique (campaign_id, position)
);

create table public.campaign_lists (
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  list_id uuid not null references public.lists (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (campaign_id, list_id)
);

create table public.campaign_participants (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete restrict,
  person_id uuid references public.people (id) on delete set null,
  current_step int not null default 1,          -- prochaine étape à réaliser
  status text not null default 'a_contacter'
    check (status in ('a_contacter','en_cours','a_repondu','termine','arrete')),
  next_due_date date,
  last_done_at timestamptz,
  stop_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, company_id)
);
create index campaign_participants_company_idx on public.campaign_participants (company_id);
create index campaign_participants_due_idx on public.campaign_participants (next_due_date)
  where status in ('a_contacter','en_cours');

alter table public.interactions
  add constraint interactions_participant_fk foreign key (campaign_participant_id)
  references public.campaign_participants (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Anti-doublons, fusion, import, idempotence, journal
-- ---------------------------------------------------------------------------

create table public.duplicate_dismissals (
  company_a uuid not null references public.companies (id) on delete cascade,
  company_b uuid not null references public.companies (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (company_a, company_b),
  check (company_a < company_b)
);

create table public.merges (
  id uuid primary key default gen_random_uuid(),
  kept_company_id uuid not null references public.companies (id) on delete restrict,
  merged_company_id uuid not null references public.companies (id) on delete restrict,
  merged_snapshot jsonb not null,
  field_choices jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.imports (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  filename text,
  summary jsonb,
  created_at timestamptz not null default now()
);

-- Empreinte de chaque ligne importée : un nouvel import du même fichier est reconnu.
create table public.import_row_keys (
  row_hash text primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  import_id uuid references public.imports (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.idempotency_keys (
  key text primary key check (char_length(key) between 8 and 200),
  scope text not null,
  result jsonb,
  created_at timestamptz not null default now()
);

-- Journal des écritures effectuées par Claude (connecteur MCP).
create table public.activity_log (
  id bigint generated always as identity primary key,
  actor text not null,
  table_name text not null,
  operation text not null,
  row_id uuid,
  company_id uuid,
  summary text,
  data jsonb,
  created_at timestamptz not null default now()
);
create index activity_log_company_idx on public.activity_log (company_id, created_at desc);


-- ===== 20261029000200_triggers_rls.sql =====
-- Triggers (normalisation, dates, historique) et politiques RLS

-- ---------------------------------------------------------------------------
-- Dates de modification
-- ---------------------------------------------------------------------------

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['companies','people','tasks','lists','templates','campaigns','campaign_participants','pipelines']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Valeurs normalisées (les valeurs saisies restent intactes pour l'affichage)
-- ---------------------------------------------------------------------------

create or replace function public.tg_companies_normalize()
returns trigger
language plpgsql
as $$
begin
  new.name := btrim(new.name);
  new.website := nullif(btrim(coalesce(new.website, '')), '');
  new.name_norm := public.norm_company_name(new.name);
  new.domain_norm := public.norm_domain(new.website);
  new.tags := coalesce(array(select distinct btrim(t) from unnest(new.tags) t where btrim(t) <> '' order by 1), '{}');
  if new.stage_id is not null then
    if not exists (select 1 from public.stages s where s.id = new.stage_id and s.pipeline_id = new.pipeline_id) then
      raise exception 'L''étape ne fait pas partie du pipeline choisi' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger companies_normalize before insert or update on public.companies
  for each row execute function public.tg_companies_normalize();

create or replace function public.tg_people_normalize()
returns trigger
language plpgsql
as $$
begin
  new.first_name := nullif(btrim(coalesce(new.first_name, '')), '');
  new.last_name := nullif(btrim(coalesce(new.last_name, '')), '');
  new.email := nullif(btrim(coalesce(new.email, '')), '');
  new.phone := nullif(btrim(coalesce(new.phone, '')), '');
  new.title := nullif(btrim(coalesce(new.title, '')), '');
  new.linkedin_url := nullif(btrim(coalesce(new.linkedin_url, '')), '');
  if new.email is not null and new.email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Email invalide : %', new.email using errcode = '22023';
  end if;
  new.email_norm := public.norm_email(new.email);
  new.linkedin_norm := public.norm_linkedin(new.linkedin_url);
  new.full_name_norm := public.norm_person_name(new.first_name, new.last_name);
  return new;
end;
$$;
create trigger people_normalize before insert or update on public.people
  for each row execute function public.tg_people_normalize();

-- ---------------------------------------------------------------------------
-- Date du dernier échange : messages, appels et rendez-vous
-- ---------------------------------------------------------------------------

create or replace function public.refresh_last_interaction(p_company uuid)
returns void
language sql
as $$
  update public.companies c
     set last_interaction_at = (
       select max(i.occurred_at) from public.interactions i
        where i.company_id = c.id and i.kind in ('message_out','message_in','call','meeting'))
   where c.id = p_company;
$$;

create or replace function public.tg_interactions_last()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('INSERT','UPDATE') then
    perform public.refresh_last_interaction(new.company_id);
  end if;
  if tg_op in ('UPDATE','DELETE') then
    if tg_op = 'DELETE' or old.company_id <> new.company_id then
      perform public.refresh_last_interaction(old.company_id);
    end if;
  end if;
  return null;
end;
$$;
create trigger interactions_last after insert or update or delete on public.interactions
  for each row execute function public.tg_interactions_last();

-- ---------------------------------------------------------------------------
-- Tâche terminée → entrée d'historique
-- ---------------------------------------------------------------------------

create or replace function public.tg_tasks_done()
returns trigger
language plpgsql
as $$
begin
  if new.done_at is not null and (tg_op = 'INSERT' or old.done_at is null) then
    insert into public.interactions (company_id, person_id, kind, occurred_at, content, content_origin, source, meta)
    values (new.company_id, new.person_id, 'task_done', new.done_at, new.title, 'system',
            case when public.current_actor() = 'claude' then 'claude' else 'user' end,
            jsonb_build_object('task_id', new.id));
  end if;
  return null;
end;
$$;
create trigger tasks_done after insert or update of done_at on public.tasks
  for each row execute function public.tg_tasks_done();

-- ---------------------------------------------------------------------------
-- Journal des écritures de Claude
-- ---------------------------------------------------------------------------

create or replace function public.tg_activity_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb;
  v_company uuid;
begin
  if public.current_actor() <> 'claude' then
    return null;
  end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_company := case when tg_table_name = 'companies' then (v_row ->> 'id')::uuid
                    else nullif(v_row ->> 'company_id', '')::uuid end;
  insert into public.activity_log (actor, table_name, operation, row_id, company_id, summary, data)
  values ('claude', tg_table_name, tg_op, nullif(v_row ->> 'id', '')::uuid, v_company,
          coalesce(current_setting('crm.claude_summary', true), ''), v_row);
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['companies','people','interactions','tasks','list_members','campaign_participants']
  loop
    execute format('create trigger activity_log after insert or update or delete on public.%I for each row execute function public.tg_activity_log()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RLS : tout est réservé au propriétaire. Les suppressions ne sont jamais
-- autorisées via un jeton Claude.
-- ---------------------------------------------------------------------------

alter table public.app_owner enable row level security;
create policy app_owner_self on public.app_owner for select to authenticated
  using (user_id = (select auth.uid()));

do $$
declare t text;
begin
  foreach t in array array[
    'lead_sources','pipelines','stages','companies','people','interactions','tasks','lists','list_members',
    'templates','template_steps','campaigns','campaign_steps','campaign_lists','campaign_participants',
    'duplicate_dismissals','merges','imports','import_row_keys','idempotency_keys','activity_log']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Le journal Claude est en lecture seule pour l'application.
drop policy owner_insert on public.activity_log;
drop policy owner_update on public.activity_log;
drop policy owner_delete on public.activity_log;

revoke all on public.app_owner from anon;


-- ===== 20261029000300_functions.sql =====
-- Logique métier transactionnelle. Toutes les fonctions sont « security invoker » :
-- elles s'exécutent avec les droits de l'appelant, donc sous RLS.
-- L'interface (server actions) et le connecteur Claude appellent les mêmes fonctions.

-- ---------------------------------------------------------------------------
-- Utilitaires
-- ---------------------------------------------------------------------------

create or replace function public.lock_keys(p_keys text[])
returns void
language plpgsql
as $$
declare k text;
begin
  -- verrous transactionnels triés pour éviter les interblocages : deux créations
  -- simultanées avec le même domaine / email sont sérialisées.
  for k in select distinct x from unnest(p_keys) x where x is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('crm:' || k, 0));
  end loop;
end;
$$;

create or replace function public.idem_get(p_key text)
returns jsonb
language plpgsql
as $$
declare v jsonb;
begin
  if p_key is null then return null; end if;
  perform public.lock_keys(array['idem:' || p_key]);
  select result into v from public.idempotency_keys where key = p_key;
  return v;
end;
$$;

create or replace function public.idem_put(p_key text, p_scope text, p_result jsonb)
returns jsonb
language plpgsql
as $$
begin
  if p_key is not null then
    insert into public.idempotency_keys (key, scope, result) values (p_key, p_scope, p_result)
    on conflict (key) do nothing;
  end if;
  return p_result;
end;
$$;

create or replace function public.log_event(
  p_company uuid, p_kind text, p_content text, p_meta jsonb default '{}', p_person uuid default null)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.interactions (company_id, person_id, kind, content, content_origin, source, meta)
  values (p_company, p_person, p_kind, p_content, 'system',
          case when public.current_actor() = 'claude' then 'claude' else 'system' end, coalesce(p_meta, '{}'))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.assert_not_claude(p_action text)
returns void
language plpgsql
as $$
begin
  if public.current_actor() = 'claude' then
    raise exception '% : action réservée à l''application, impossible via Claude', p_action using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Détection des doublons
-- strength = 'exact' (correspondance forte) ou 'similar' (ressemblance à vérifier)
-- ---------------------------------------------------------------------------

create or replace function public.find_duplicates(
  p_name text,
  p_website text default null,
  p_emails text[] default '{}',
  p_linkedins text[] default '{}',
  p_person_names text[] default '{}',
  p_exclude uuid default null)
returns table (company_id uuid, name text, website text, archived boolean, strength text, reasons text[])
language plpgsql
stable
as $$
declare
  v_name text := public.norm_company_name(p_name);
  v_domain text := public.norm_domain(p_website);
  v_emails text[] := coalesce(array(select distinct public.norm_email(e) from unnest(p_emails) e where public.norm_email(e) is not null), '{}');
  v_email_domains text[];
  v_linkedins text[] := coalesce(array(select distinct public.norm_linkedin(l) from unnest(p_linkedins) l where public.norm_linkedin(l) is not null), '{}');
  v_pnames text[] := coalesce(array(select distinct x from unnest(p_person_names) x where coalesce(x, '') <> ''), '{}');
begin
  perform public.assert_owner();
  -- domaines d'email professionnels uniquement : Gmail, Outlook… ne rapprochent jamais.
  v_email_domains := coalesce(array(
    select distinct public.email_domain(e) from unnest(v_emails) e
     where public.email_domain(e) is not null and not public.is_free_email_domain(public.email_domain(e))), '{}');
  v_pnames := coalesce(array(select distinct public.norm_person_name(x, null) from unnest(v_pnames) x
                              where public.norm_person_name(x, null) is not null), '{}');

  return query
  with hits as (
    select c.id, 'exact'::text as s, 'Même domaine : ' || c.domain_norm as r
      from public.companies c
     where v_domain is not null and c.domain_norm = v_domain
    union all
    select c.id, 'exact', 'Domaine de l''email identique au site de l''entreprise : ' || c.domain_norm
      from public.companies c
     where c.domain_norm = any (v_email_domains)
    union all
    select p.company_id, 'exact', 'Domaine du site identique à l''email de ' || coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), p.email)
      from public.people p
     where v_domain is not null and not public.is_free_email_domain(v_domain)
       and public.email_domain(p.email_norm) = v_domain
    union all
    select p.company_id, 'exact', 'Même email : ' || p.email_norm
      from public.people p
     where p.email_norm = any (v_emails)
    union all
    select p.company_id, 'exact', 'Même profil LinkedIn : ' || p.linkedin_norm
      from public.people p
     where p.linkedin_norm = any (v_linkedins)
    union all
    select c.id, 'similar', 'Nom d''entreprise identique après normalisation'
      from public.companies c
     where v_name is not null and c.name_norm = v_name
    union all
    select c.id, 'similar', 'Nom d''entreprise proche (' || round(extensions.similarity(c.name_norm, v_name) * 100) || ' %)'
      from public.companies c
     where v_name is not null and c.name_norm <> v_name and char_length(v_name) >= 3
       and extensions.similarity(c.name_norm, v_name) >= 0.55
    union all
    select p.company_id, 'similar', 'Personne au nom identique : ' || btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,''))
      from public.people p
     where p.full_name_norm = any (v_pnames) and position(' ' in p.full_name_norm) > 0
  )
  select c.id, c.name, c.website, c.archived_at is not null,
         case when bool_or(h.s = 'exact') then 'exact' else 'similar' end,
         array_agg(distinct h.r)
    from hits h
    join public.companies c on c.id = h.id
   where c.merged_into_id is null
     and (p_exclude is null or c.id <> p_exclude)
   group by c.id, c.name, c.website, c.archived_at
   order by case when bool_or(h.s = 'exact') then 0 else 1 end, c.name
   limit 20;
end;
$$;

-- Toutes les paires de doublons potentiels de la base (vue « Doublons à vérifier »)
create or replace function public.list_duplicate_pairs()
returns table (company_a uuid, name_a text, company_b uuid, name_b text, strength text, reasons text[])
language plpgsql
stable
as $$
begin
  perform public.assert_owner();
  return query
  with active as (
    select * from public.companies where merged_into_id is null
  ), pairs as (
    select a.id as x, b.id as y, 'exact'::text as s, 'Même domaine : ' || a.domain_norm as r
      from active a join active b on a.domain_norm = b.domain_norm and a.id < b.id
    union all
    select least(pa.company_id, pb.company_id), greatest(pa.company_id, pb.company_id), 'exact', 'Même email : ' || pa.email_norm
      from public.people pa join public.people pb on pa.email_norm = pb.email_norm and pa.company_id <> pb.company_id
    union all
    select least(pa.company_id, pb.company_id), greatest(pa.company_id, pb.company_id), 'exact', 'Même profil LinkedIn : ' || pa.linkedin_norm
      from public.people pa join public.people pb on pa.linkedin_norm = pb.linkedin_norm and pa.company_id <> pb.company_id
    union all
    select least(c.id, p.company_id), greatest(c.id, p.company_id), 'exact', 'Email de ' || p.email_norm || ' sur le domaine ' || c.domain_norm
      from active c join public.people p
        on public.email_domain(p.email_norm) = c.domain_norm and p.company_id <> c.id
     where not public.is_free_email_domain(c.domain_norm)
    union all
    select a.id, b.id, 'similar',
           case when a.name_norm = b.name_norm then 'Nom d''entreprise identique après normalisation'
                else 'Nom d''entreprise proche (' || round(extensions.similarity(a.name_norm, b.name_norm) * 100) || ' %)' end
      from active a join active b on a.id < b.id
       and (a.name_norm = b.name_norm or (a.name_norm operator(extensions.%) b.name_norm
            and extensions.similarity(a.name_norm, b.name_norm) >= 0.55))
    union all
    select least(pa.company_id, pb.company_id), greatest(pa.company_id, pb.company_id), 'similar',
           'Personne au nom identique : ' || btrim(coalesce(pa.first_name,'') || ' ' || coalesce(pa.last_name,''))
      from public.people pa join public.people pb
        on pa.full_name_norm = pb.full_name_norm and pa.company_id <> pb.company_id
     where position(' ' in pa.full_name_norm) > 0
  )
  select p.x, ca.name, p.y, cb.name,
         case when bool_or(p.s = 'exact') then 'exact' else 'similar' end,
         array_agg(distinct p.r)
    from pairs p
    join active ca on ca.id = p.x
    join active cb on cb.id = p.y
   where not exists (select 1 from public.duplicate_dismissals d where d.company_a = p.x and d.company_b = p.y)
   group by p.x, ca.name, p.y, cb.name
   order by case when bool_or(p.s = 'exact') then 0 else 1 end, ca.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fiches : création et modification avec contrôle des doublons
-- p_company : {name, website, description, source_id, tags[]}
-- p_people  : [{first_name, last_name, title, email, phone, linkedin_url, is_primary}]
-- Retourne {status:'created', id} ou {status:'duplicates', candidates:[…]}
-- ---------------------------------------------------------------------------

create or replace function public.create_company(
  p_company jsonb,
  p_people jsonb default '[]',
  p_force boolean default false,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
  v_emails text[];
  v_linkedins text[];
  v_pnames text[];
  v_candidates jsonb;
  v_person jsonb;
  v_idx bigint;
  v_primary_idx bigint;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  if coalesce(btrim(p_company ->> 'name'), '') = '' then
    raise exception 'Le nom de l''entreprise est obligatoire' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_people, '[]')) <> 'array' then
    raise exception 'Format des personnes invalide' using errcode = '22023';
  end if;

  select coalesce(array_agg(x ->> 'email') filter (where coalesce(x ->> 'email', '') <> ''), '{}'),
         coalesce(array_agg(x ->> 'linkedin_url') filter (where coalesce(x ->> 'linkedin_url', '') <> ''), '{}'),
         coalesce(array_agg(btrim(coalesce(x ->> 'first_name', '') || ' ' || coalesce(x ->> 'last_name', ''))), '{}')
    into v_emails, v_linkedins, v_pnames
    from jsonb_array_elements(coalesce(p_people, '[]')) x;

  perform public.lock_keys(
    array['domain:' || public.norm_domain(p_company ->> 'website'),
          'name:' || public.norm_company_name(p_company ->> 'name')]
    || array(select 'email:' || public.norm_email(e) from unnest(v_emails) e)
    || array(select 'li:' || public.norm_linkedin(l) from unnest(v_linkedins) l));

  select coalesce(jsonb_agg(to_jsonb(d)), '[]') into v_candidates
    from public.find_duplicates(p_company ->> 'name', p_company ->> 'website', v_emails, v_linkedins, v_pnames) d;

  if jsonb_array_length(v_candidates) > 0 and not p_force then
    -- pas d'enregistrement de la clé : l'utilisateur peut confirmer ensuite
    return jsonb_build_object('status', 'duplicates', 'candidates', v_candidates);
  end if;

  insert into public.companies (name, website, description, source_id, tags)
  values (p_company ->> 'name',
          p_company ->> 'website',
          nullif(btrim(coalesce(p_company ->> 'description', '')), ''),
          nullif(p_company ->> 'source_id', '')::uuid,
          coalesce(array(select jsonb_array_elements_text(p_company -> 'tags')), '{}'))
  returning id into v_id;

  -- un seul contact principal : le premier marqué comme tel, sinon le premier saisi
  select coalesce(min(o) filter (where coalesce((x ->> 'is_primary')::boolean, false)), 1) into v_primary_idx
    from jsonb_array_elements(coalesce(p_people, '[]')) with ordinality as t(x, o);

  for v_person, v_idx in select x, o from jsonb_array_elements(coalesce(p_people, '[]')) with ordinality as t(x, o)
  loop
    insert into public.people (company_id, first_name, last_name, title, email, phone, linkedin_url, is_primary)
    values (v_id, v_person ->> 'first_name', v_person ->> 'last_name', v_person ->> 'title',
            v_person ->> 'email', v_person ->> 'phone', v_person ->> 'linkedin_url', v_idx = v_primary_idx);
  end loop;

  perform public.log_event(v_id, 'system', 'Fiche créée',
    case when jsonb_array_length(v_candidates) > 0
         then jsonb_build_object('created_despite_duplicates', v_candidates) else '{}'::jsonb end);

  return public.idem_put(p_idempotency_key, 'create_company', jsonb_build_object('status', 'created', 'id', v_id));
end;
$$;

-- Modification : seuls les champs présents dans p_patch sont modifiés.
create or replace function public.update_company(p_id uuid, p_patch jsonb, p_force boolean default false)
returns jsonb
language plpgsql
as $$
declare
  c public.companies;
  v_candidates jsonb := '[]';
begin
  perform public.assert_owner();
  select * into c from public.companies where id = p_id and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;

  if p_patch ? 'name' and coalesce(btrim(p_patch ->> 'name'), '') = '' then
    raise exception 'Le nom de l''entreprise est obligatoire' using errcode = '22023';
  end if;

  if (p_patch ? 'website' and public.norm_domain(p_patch ->> 'website') is distinct from c.domain_norm)
     or (p_patch ? 'name' and public.norm_company_name(p_patch ->> 'name') is distinct from c.name_norm) then
    perform public.lock_keys(array['domain:' || public.norm_domain(p_patch ->> 'website'),
                                   'name:' || public.norm_company_name(p_patch ->> 'name')]);
    select coalesce(jsonb_agg(to_jsonb(d)), '[]') into v_candidates
      from public.find_duplicates(
             case when p_patch ? 'name' and public.norm_company_name(p_patch ->> 'name') is distinct from c.name_norm
                  then p_patch ->> 'name' end,
             case when p_patch ? 'website' then p_patch ->> 'website' end,
             '{}', '{}', '{}', p_id) d;
    if jsonb_array_length(v_candidates) > 0 and not p_force then
      return jsonb_build_object('status', 'duplicates', 'candidates', v_candidates);
    end if;
  end if;

  update public.companies set
    name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
    website = case when p_patch ? 'website' then p_patch ->> 'website' else website end,
    description = case when p_patch ? 'description' then nullif(btrim(coalesce(p_patch ->> 'description', '')), '') else description end,
    source_id = case when p_patch ? 'source_id' then nullif(p_patch ->> 'source_id', '')::uuid else source_id end,
    tags = case when p_patch ? 'tags' then coalesce(array(select jsonb_array_elements_text(p_patch -> 'tags')), '{}') else tags end,
    prospect_status = case when p_patch ? 'prospect_status' then p_patch ->> 'prospect_status' else prospect_status end,
    amount = case when p_patch ? 'amount' then nullif(p_patch ->> 'amount', '')::numeric else amount end,
    expected_close_date = case when p_patch ? 'expected_close_date' then nullif(p_patch ->> 'expected_close_date', '')::date else expected_close_date end,
    lost_reason = case when p_patch ? 'lost_reason' then nullif(btrim(coalesce(p_patch ->> 'lost_reason', '')), '') else lost_reason end
  where id = p_id;

  return jsonb_build_object('status', 'updated', 'id', p_id);
end;
$$;

-- Personnes : contrôle email / LinkedIn déjà présents ailleurs
create or replace function public.upsert_person(
  p_company uuid, p_person jsonb, p_person_id uuid default null, p_force boolean default false,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
  v_conflicts jsonb;
  v_email text := public.norm_email(p_person ->> 'email');
  v_li text := public.norm_linkedin(p_person ->> 'linkedin_url');
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  perform public.lock_keys(array['email:' || v_email, 'li:' || v_li]);

  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id', p.id, 'company_id', p.company_id, 'company_name', c.name,
           'person_name', btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
           'reason', case when p.email_norm = v_email then 'Même email : ' || v_email else 'Même profil LinkedIn' end)), '[]')
    into v_conflicts
    from public.people p join public.companies c on c.id = p.company_id
   where (p_person_id is null or p.id <> p_person_id)
     and c.merged_into_id is null
     and ((v_email is not null and p.email_norm = v_email) or (v_li is not null and p.linkedin_norm = v_li));

  if jsonb_array_length(v_conflicts) > 0 and not p_force then
    return jsonb_build_object('status', 'duplicates', 'candidates', v_conflicts);
  end if;

  if coalesce((p_person ->> 'is_primary')::boolean, false) then
    update public.people set is_primary = false
     where company_id = p_company and is_primary and (p_person_id is null or id <> p_person_id);
  end if;

  if p_person_id is null then
    insert into public.people (company_id, first_name, last_name, title, email, phone, linkedin_url, is_primary)
    values (p_company, p_person ->> 'first_name', p_person ->> 'last_name', p_person ->> 'title',
            p_person ->> 'email', p_person ->> 'phone', p_person ->> 'linkedin_url',
            coalesce((p_person ->> 'is_primary')::boolean, false)
              or not exists (select 1 from public.people where company_id = p_company))
    returning id into v_id;
  else
    update public.people set
      first_name = case when p_person ? 'first_name' then p_person ->> 'first_name' else first_name end,
      last_name = case when p_person ? 'last_name' then p_person ->> 'last_name' else last_name end,
      title = case when p_person ? 'title' then p_person ->> 'title' else title end,
      email = case when p_person ? 'email' then p_person ->> 'email' else email end,
      phone = case when p_person ? 'phone' then p_person ->> 'phone' else phone end,
      linkedin_url = case when p_person ? 'linkedin_url' then p_person ->> 'linkedin_url' else linkedin_url end,
      is_primary = case when p_person ? 'is_primary' then coalesce((p_person ->> 'is_primary')::boolean, false) else is_primary end
    where id = p_person_id and company_id = p_company
    returning id into v_id;
    if v_id is null then raise exception 'Personne introuvable' using errcode = 'P0002'; end if;
  end if;

  return public.idem_put(p_idempotency_key, 'upsert_person', jsonb_build_object('status', 'saved', 'id', v_id));
end;
$$;

create or replace function public.set_archived(p_ids uuid[], p_archived boolean)
returns int
language plpgsql
as $$
declare n int;
begin
  perform public.assert_owner();
  if public.current_actor() = 'claude' and cardinality(p_ids) > 1 then
    perform public.assert_not_claude('Archivage multiple');
  end if;
  update public.companies
     set archived_at = case when p_archived then coalesce(archived_at, now()) else null end
   where id = any (p_ids) and merged_into_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Interactions saisies manuellement (note, message, appel, rendez-vous)
-- Un message reçu met en pause les relances actives de la fiche.
-- ---------------------------------------------------------------------------

create or replace function public.add_interaction(
  p_company uuid,
  p_kind text,
  p_content text,
  p_occurred_at timestamptz default null,
  p_person uuid default null,
  p_channel text default null,
  p_content_origin text default 'user',
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
  v_paused int := 0;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_kind not in ('note','message_out','message_in','call','meeting') then
    raise exception 'Type d''interaction invalide' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;
  if coalesce(btrim(p_content), '') = '' and p_kind in ('note','message_out','message_in') then
    raise exception 'Le contenu est obligatoire' using errcode = '22023';
  end if;
  if coalesce(p_occurred_at, now()) > now() + interval '1 day' then
    raise exception 'La date d''un échange ne peut pas être dans le futur' using errcode = '22023';
  end if;

  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source)
  values (p_company, p_person, p_kind, p_channel, coalesce(p_occurred_at, now()), nullif(btrim(p_content), ''),
          coalesce(p_content_origin, 'user'),
          case when public.current_actor() = 'claude' then 'claude' else 'user' end)
  returning id into v_id;

  if p_kind = 'message_in' then
    update public.campaign_participants
       set status = 'a_repondu', next_due_date = null
     where company_id = p_company and status in ('a_contacter','en_cours');
    get diagnostics v_paused = row_count;
    update public.companies set prospect_status = 'en_discussion'
     where id = p_company and prospect_status in ('nouveau','contacte');
  elsif p_kind = 'message_out' then
    update public.companies set prospect_status = 'contacte'
     where id = p_company and prospect_status = 'nouveau';
  end if;

  return public.idem_put(p_idempotency_key, 'add_interaction',
    jsonb_build_object('status', 'created', 'id', v_id, 'paused_followups', v_paused));
end;
$$;

-- ---------------------------------------------------------------------------
-- Campagnes manuelles
-- ---------------------------------------------------------------------------

create or replace function public.add_lists_to_campaign(p_campaign uuid, p_list_ids uuid[])
returns jsonb
language plpgsql
as $$
declare
  v_first_delay int;
  v_added int;
  v_total int;
begin
  perform public.assert_owner();
  select coalesce(delay_days, 0) into v_first_delay from public.campaign_steps
   where campaign_id = p_campaign order by position limit 1;

  insert into public.campaign_lists (campaign_id, list_id)
  select p_campaign, l from unnest(p_list_ids) l
  on conflict do nothing;

  -- une entreprise présente dans plusieurs listes n'est ajoutée qu'une fois
  select count(distinct lm.company_id) into v_total
    from public.list_members lm join public.companies c on c.id = lm.company_id
   where lm.list_id = any (p_list_ids) and c.archived_at is null and c.merged_into_id is null;

  insert into public.campaign_participants (campaign_id, company_id, person_id, next_due_date)
  select distinct on (c.id) p_campaign, c.id,
         (select p.id from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1),
         public.today_paris() + coalesce(v_first_delay, 0)
    from public.list_members lm join public.companies c on c.id = lm.company_id
   where lm.list_id = any (p_list_ids) and c.archived_at is null and c.merged_into_id is null
  on conflict (campaign_id, company_id) do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object('added', v_added, 'already_present', v_total - v_added);
end;
$$;

create or replace function public.add_companies_to_campaign(p_campaign uuid, p_company_ids uuid[])
returns jsonb
language plpgsql
as $$
declare
  v_first_delay int;
  v_added int;
begin
  perform public.assert_owner();
  select coalesce(delay_days, 0) into v_first_delay from public.campaign_steps
   where campaign_id = p_campaign order by position limit 1;
  insert into public.campaign_participants (campaign_id, company_id, person_id, next_due_date)
  select p_campaign, c.id,
         (select p.id from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1),
         public.today_paris() + coalesce(v_first_delay, 0)
    from public.companies c
   where c.id = any (p_company_ids) and c.merged_into_id is null
  on conflict (campaign_id, company_id) do nothing;
  get diagnostics v_added = row_count;
  return jsonb_build_object('added', v_added, 'already_present', cardinality(p_company_ids) - v_added);
end;
$$;

-- Les étapes du modèle sont copiées : modifier le modèle ne change pas la campagne.
create or replace function public.create_campaign(p_name text, p_template uuid, p_list_ids uuid[] default '{}')
returns jsonb
language plpgsql
as $$
declare
  v_id uuid;
  v_tpl public.templates;
  v_res jsonb := '{}';
begin
  perform public.assert_owner();
  select * into v_tpl from public.templates where id = p_template;
  if not found then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.template_steps where template_id = p_template) then
    raise exception 'Le modèle ne contient aucune étape' using errcode = '22023';
  end if;

  insert into public.campaigns (name, template_id, template_name)
  values (coalesce(nullif(btrim(p_name), ''), v_tpl.name), p_template, v_tpl.name)
  returning id into v_id;

  insert into public.campaign_steps (campaign_id, position, name, channel, delay_days, message)
  select v_id, row_number() over (order by position), name, channel, delay_days, message
    from public.template_steps where template_id = p_template;

  if cardinality(p_list_ids) > 0 then
    v_res := public.add_lists_to_campaign(v_id, p_list_ids);
  end if;
  return jsonb_build_object('id', v_id) || v_res;
end;
$$;

-- « Marquer comme envoyé » : seule action qui enregistre un envoi.
-- La prochaine échéance part de la date réelle d'envoi.
create or replace function public.mark_step_sent(
  p_participant uuid,
  p_content text,
  p_sent_at timestamptz default null,
  p_person uuid default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  cp public.campaign_participants;
  st public.campaign_steps;
  nxt public.campaign_steps;
  v_camp public.campaigns;
  v_at timestamptz := coalesce(p_sent_at, now());
  v_person uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  if cp.status in ('termine','arrete') then
    raise exception 'Le suivi de cette fiche est terminé ou arrêté' using errcode = '22023';
  end if;
  if v_at > now() + interval '1 day' then
    raise exception 'La date d''envoi ne peut pas être dans le futur' using errcode = '22023';
  end if;
  select * into v_camp from public.campaigns where id = cp.campaign_id;
  select * into st from public.campaign_steps where campaign_id = cp.campaign_id and position = cp.current_step;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  select * into nxt from public.campaign_steps where campaign_id = cp.campaign_id and position = cp.current_step + 1;

  v_person := coalesce(p_person, cp.person_id);
  if v_person is not null and not exists (select 1 from public.people where id = v_person and company_id = cp.company_id) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;

  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source,
                                   campaign_participant_id, meta)
  values (cp.company_id, v_person, 'message_out', st.channel, v_at, nullif(btrim(p_content), ''), 'user',
          case when public.current_actor() = 'claude' then 'claude' else 'user' end, cp.id,
          jsonb_build_object('campaign_id', v_camp.id, 'campaign_name', v_camp.name,
                             'step_position', st.position, 'step_name', st.name));

  if nxt.id is not null then
    update public.campaign_participants
       set status = 'en_cours', current_step = nxt.position, last_done_at = v_at, person_id = v_person,
           next_due_date = (v_at at time zone 'Europe/Paris')::date + nxt.delay_days
     where id = cp.id;
  else
    update public.campaign_participants
       set status = 'termine', current_step = st.position + 1, last_done_at = v_at, person_id = v_person,
           next_due_date = null
     where id = cp.id;
  end if;

  update public.companies set prospect_status = 'contacte' where id = cp.company_id and prospect_status = 'nouveau';

  return public.idem_put(p_idempotency_key, 'mark_step_sent',
    jsonb_build_object('status', 'sent', 'finished', nxt.id is null));
end;
$$;

-- Réponse reçue : le suivi est mis en pause, l'utilisateur décide de la suite.
create or replace function public.record_reply(
  p_participant uuid,
  p_content text,
  p_received_at timestamptz default null,
  p_person uuid default null,
  p_channel text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  st public.campaign_steps;
  v_res jsonb;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  select * into st from public.campaign_steps
   where campaign_id = cp.campaign_id and position = greatest(cp.current_step - 1, 1);
  v_res := public.add_interaction(cp.company_id, 'message_in', p_content, p_received_at,
                                  coalesce(p_person, cp.person_id), coalesce(p_channel, st.channel));
  update public.interactions set campaign_participant_id = cp.id where id = (v_res ->> 'id')::uuid;
  -- add_interaction a déjà mis en pause les participants actifs ; on couvre aussi un suivi déjà terminé.
  update public.campaign_participants set status = 'a_repondu', next_due_date = null
   where id = cp.id and status <> 'arrete';
  return jsonb_build_object('status', 'paused');
end;
$$;

create or replace function public.update_participant(
  p_participant uuid, p_action text, p_due date default null, p_reason text default null)
returns jsonb
language plpgsql
as $$
declare cp public.campaign_participants;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;

  if p_action = 'postpone' then
    if p_due is null then raise exception 'Nouvelle date obligatoire' using errcode = '22023'; end if;
    if cp.status not in ('a_contacter','en_cours') then
      raise exception 'Seul un suivi actif peut être reporté' using errcode = '22023';
    end if;
    update public.campaign_participants set next_due_date = p_due where id = cp.id;
  elsif p_action = 'resume' then
    if not exists (select 1 from public.campaign_steps where campaign_id = cp.campaign_id and position = cp.current_step) then
      raise exception 'Il ne reste aucune étape à réaliser' using errcode = '22023';
    end if;
    update public.campaign_participants
       set status = case when cp.last_done_at is null then 'a_contacter' else 'en_cours' end,
           next_due_date = coalesce(p_due, public.today_paris()), stop_reason = null
     where id = cp.id;
  elsif p_action = 'stop' then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null, stop_reason = coalesce(nullif(btrim(p_reason), ''), 'Arrêt manuel')
     where id = cp.id;
    perform public.log_event(cp.company_id, 'prospecting', 'Suivi de prospection arrêté : ' || coalesce(nullif(btrim(p_reason), ''), 'arrêt manuel'),
      jsonb_build_object('campaign_id', cp.campaign_id));
  elsif p_action = 'finish' then
    update public.campaign_participants set status = 'termine', next_due_date = null where id = cp.id;
  elsif p_action = 'set_person' then
    if p_reason is not null and not exists (select 1 from public.people where id = p_reason::uuid and company_id = cp.company_id) then
      raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
    end if;
    update public.campaign_participants set person_id = p_reason::uuid where id = cp.id;
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- Pipelines
-- ---------------------------------------------------------------------------

-- Déplace (ou retire) la fiche. Aucune copie : c'est la même ligne qui change d'étape.
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
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;

  if p_stage is not null then
    select * into v_to from public.stages where id = p_stage;
    if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
    select * into v_to_pipeline from public.pipelines where id = v_to.pipeline_id;
  end if;

  if c.stage_id is not distinct from p_stage and c.deal_status = 'open' then
    return jsonb_build_object('status', 'unchanged');
  end if;

  select s.name, p.name into v_from_stage, v_from_pipeline
    from public.stages s join public.pipelines p on p.id = s.pipeline_id where s.id = c.stage_id;

  update public.companies
     set pipeline_id = v_to.pipeline_id, stage_id = v_to.id,
         deal_status = 'open', deal_closed_at = null,
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
         else v_to_pipeline.name || ' : ' || coalesce(v_from_stage, '—') || ' → ' || v_to.name end
    || case when c.deal_status <> 'open' and p_stage is not null then ' (opportunité rouverte)' else '' end,
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

-- Gagné / perdu : la fiche garde son dernier pipeline et sa dernière étape.
create or replace function public.set_deal_status(p_company uuid, p_status text, p_lost_reason text default null)
returns jsonb
language plpgsql
as $$
declare c public.companies;
begin
  perform public.assert_owner();
  if p_status not in ('open','won','lost') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.pipeline_id is null then
    raise exception 'La fiche doit être dans un pipeline' using errcode = '22023';
  end if;
  if c.deal_status = p_status then return jsonb_build_object('status', 'unchanged'); end if;
  update public.companies
     set deal_status = p_status,
         deal_closed_at = case when p_status = 'open' then null else now() end,
         lost_reason = case when p_status = 'lost' then nullif(btrim(coalesce(p_lost_reason, '')), '') else lost_reason end
   where id = c.id;
  perform public.log_event(c.id, 'deal_status',
    case p_status when 'won' then 'Opportunité gagnée' when 'lost' then 'Opportunité perdue' || coalesce(' : ' || nullif(btrim(p_lost_reason), ''), '')
                  else 'Opportunité rouverte' end,
    jsonb_build_object('from', c.deal_status, 'to', p_status));
  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.reorder_stages(p_pipeline uuid, p_stage_ids uuid[])
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  if exists (select 1 from unnest(p_stage_ids) s
              where not exists (select 1 from public.stages st where st.id = s and st.pipeline_id = p_pipeline)) then
    raise exception 'Étape étrangère au pipeline' using errcode = '22023';
  end if;
  update public.stages st set position = o.ord
    from unnest(p_stage_ids) with ordinality o(id, ord)
   where st.id = o.id;
end;
$$;

-- Suppression d'une étape : les fiches qu'elle contient vont dans l'étape de remplacement.
create or replace function public.delete_stage(p_stage uuid, p_replacement uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_stage public.stages;
  v_rep public.stages;
  v_count int;
  r record;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression d''étape');
  select * into v_stage from public.stages where id = p_stage;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  select count(*) into v_count from public.companies where stage_id = p_stage;
  if v_count > 0 then
    if p_replacement is null or p_replacement = p_stage then
      raise exception 'Cette étape contient % fiche(s) : choisissez une étape de remplacement', v_count using errcode = '22023';
    end if;
    select * into v_rep from public.stages where id = p_replacement;
    if not found then raise exception 'Étape de remplacement introuvable' using errcode = 'P0002'; end if;
    for r in select id from public.companies where stage_id = p_stage loop
      update public.companies set pipeline_id = v_rep.pipeline_id, stage_id = v_rep.id where id = r.id;
      perform public.log_event(r.id, 'stage_change',
        'Étape « ' || v_stage.name || ' » supprimée : fiche déplacée vers « ' || v_rep.name || ' »',
        jsonb_build_object('from_stage_id', v_stage.id, 'from_stage', v_stage.name, 'to_stage_id', v_rep.id, 'to_stage', v_rep.name));
    end loop;
  end if;
  delete from public.stages where id = p_stage;
  return jsonb_build_object('moved', v_count);
end;
$$;

create or replace function public.delete_pipeline(p_pipeline uuid, p_replacement_stage uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_pipe public.pipelines;
  v_rep public.stages;
  v_count int;
  r record;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression de pipeline');
  select * into v_pipe from public.pipelines where id = p_pipeline;
  if not found then raise exception 'Pipeline introuvable' using errcode = 'P0002'; end if;
  select count(*) into v_count from public.companies where pipeline_id = p_pipeline;
  if v_count > 0 then
    select * into v_rep from public.stages where id = p_replacement_stage and pipeline_id <> p_pipeline;
    if not found then
      raise exception 'Ce pipeline contient % fiche(s) : choisissez une étape de destination dans un autre pipeline', v_count
        using errcode = '22023';
    end if;
    for r in select id from public.companies where pipeline_id = p_pipeline loop
      update public.companies set pipeline_id = v_rep.pipeline_id, stage_id = v_rep.id where id = r.id;
      perform public.log_event(r.id, 'stage_change',
        'Pipeline « ' || v_pipe.name || ' » supprimé : fiche déplacée vers « ' || v_rep.name || ' »',
        jsonb_build_object('from_pipeline_id', v_pipe.id, 'from_pipeline', v_pipe.name, 'to_stage_id', v_rep.id, 'to_stage', v_rep.name));
    end loop;
  end if;
  delete from public.stages where pipeline_id = p_pipeline;
  delete from public.pipelines where id = p_pipeline;
  return jsonb_build_object('moved', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fusion explicite de deux fiches, dans une seule transaction
-- p_fields : {"name":"keep"|"merged", "website":…, "description":…, "source_id":…,
--             "amount":…, "expected_close_date":…, "prospect_status":…}
-- p_pipeline_from : 'keep' | 'merged' (pipeline, étape, statut commercial)
-- ---------------------------------------------------------------------------

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
  f text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Fusion');
  if p_keep = p_merge then raise exception 'Impossible de fusionner une fiche avec elle-même' using errcode = '22023'; end if;
  -- verrouillage dans un ordre stable
  perform 1 from public.companies where id in (p_keep, p_merge) order by id for update;
  select * into k from public.companies where id = p_keep;
  select * into m from public.companies where id = p_merge;
  if k.id is null or m.id is null then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if k.merged_into_id is not null or m.merged_into_id is not null then
    raise exception 'Une des fiches a déjà été fusionnée' using errcode = '22023';
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

  -- personnes : un seul contact principal conservé
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

  delete from public.duplicate_dismissals where company_a = m.id or company_b = m.id;

  update public.companies
     set merged_into_id = k.id, archived_at = coalesce(archived_at, now()),
         pipeline_id = null, stage_id = null
   where id = m.id;

  perform public.log_event(k.id, 'merge',
    'Fiche « ' || m.name || ' » fusionnée dans cette fiche (ancien identifiant ' || m.id || ')',
    jsonb_build_object('merged_company_id', m.id, 'merged_name', m.name, 'people_moved', v_people,
                       'campaign_conflicts', v_conflicts,
                       'pipeline_from', p_pipeline_from,
                       'discarded_pipeline', case when p_pipeline_from = 'merged' then k.stage_id else m.stage_id end));

  return jsonb_build_object('status', 'merged', 'kept_id', k.id, 'merged_id', m.id,
                            'people_moved', v_people, 'campaign_conflicts', v_conflicts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Import CSV
-- ---------------------------------------------------------------------------

-- Vérifie les groupes d'un import : doublons en base et lignes déjà importées.
-- p_groups : [{key, name, website, emails[], linkedins[], person_names[], row_hashes[]}]
create or replace function public.import_check(p_groups jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  g jsonb;
  v_out jsonb := '[]';
  v_candidates jsonb;
  v_imported jsonb;
begin
  perform public.assert_owner();
  for g in select * from jsonb_array_elements(p_groups) loop
    select coalesce(jsonb_agg(to_jsonb(d)), '[]') into v_candidates
      from public.find_duplicates(
        g ->> 'name', g ->> 'website',
        coalesce(array(select jsonb_array_elements_text(g -> 'emails')), '{}'),
        coalesce(array(select jsonb_array_elements_text(g -> 'linkedins')), '{}'),
        coalesce(array(select jsonb_array_elements_text(g -> 'person_names')), '{}')) d;
    select coalesce(jsonb_agg(distinct k.company_id), '[]') into v_imported
      from public.import_row_keys k
      join public.companies c on c.id = k.company_id
     where k.row_hash in (select jsonb_array_elements_text(g -> 'row_hashes'));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', g ->> 'key', 'candidates', v_candidates, 'already_imported_company_ids', v_imported));
  end loop;
  return v_out;
end;
$$;

-- Applique les choix explicites de l'utilisateur.
-- p_groups : [{key, action:'create'|'complete'|'skip', target_company_id, rows:[numéros],
--              row_hashes:[…], company:{name, website, description, source}, people:[…]}]
create or replace function public.import_commit(
  p_idempotency_key text, p_filename text, p_groups jsonb, p_list_id uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_existing public.imports;
  v_import_id uuid;
  g jsonb;
  pr jsonb;
  v_company uuid;
  v_source uuid;
  v_res jsonb;
  v_created int := 0;
  v_completed int := 0;
  v_skipped int := 0;
  v_people int := 0;
  v_errors jsonb := '[]';
  v_existing_person uuid;
begin
  perform public.assert_owner();
  perform public.lock_keys(array['import:' || p_idempotency_key]);
  select * into v_existing from public.imports where idempotency_key = p_idempotency_key;
  if found then return v_existing.summary || jsonb_build_object('replayed', true); end if;

  insert into public.imports (idempotency_key, filename) values (p_idempotency_key, p_filename)
  returning id into v_import_id;

  for g in select * from jsonb_array_elements(p_groups) loop
    if g ->> 'action' = 'skip' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    begin
      v_source := null;
      if coalesce(btrim(g -> 'company' ->> 'source'), '') <> '' then
        select id into v_source from public.lead_sources where lower(btrim(name)) = lower(btrim(g -> 'company' ->> 'source'));
        if v_source is null then
          insert into public.lead_sources (name, position)
          values (btrim(g -> 'company' ->> 'source'), (select coalesce(max(position), 0) + 1 from public.lead_sources))
          returning id into v_source;
        end if;
      end if;

      if g ->> 'action' = 'create' then
        v_res := public.create_company(
          jsonb_build_object('name', g -> 'company' ->> 'name', 'website', g -> 'company' ->> 'website',
                             'description', g -> 'company' ->> 'description', 'source_id', v_source),
          coalesce(g -> 'people', '[]'), true, null);
        v_company := (v_res ->> 'id')::uuid;
        update public.interactions set source = 'import', content = 'Fiche créée par import CSV'
         where company_id = v_company and kind = 'system';
        v_created := v_created + 1;
        v_people := v_people + jsonb_array_length(coalesce(g -> 'people', '[]'));
      elsif g ->> 'action' = 'complete' then
        v_company := (g ->> 'target_company_id')::uuid;
        if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
          raise exception 'Fiche cible introuvable';
        end if;
        -- complément : on ne remplit que les champs vides, jamais d'écrasement
        update public.companies set
          website = coalesce(website, nullif(btrim(coalesce(g -> 'company' ->> 'website', '')), '')),
          description = coalesce(description, nullif(btrim(coalesce(g -> 'company' ->> 'description', '')), '')),
          source_id = coalesce(source_id, v_source)
        where id = v_company;
        for pr in select * from jsonb_array_elements(coalesce(g -> 'people', '[]')) loop
          select id into v_existing_person from public.people p
           where p.company_id = v_company
             and ((public.norm_email(pr ->> 'email') is not null and p.email_norm = public.norm_email(pr ->> 'email'))
               or (public.norm_linkedin(pr ->> 'linkedin_url') is not null and p.linkedin_norm = public.norm_linkedin(pr ->> 'linkedin_url'))
               or (public.norm_person_name(pr ->> 'first_name', pr ->> 'last_name') is not null
                   and p.full_name_norm = public.norm_person_name(pr ->> 'first_name', pr ->> 'last_name')))
           limit 1;
          if v_existing_person is null then
            insert into public.people (company_id, first_name, last_name, title, email, phone, linkedin_url, is_primary)
            values (v_company, pr ->> 'first_name', pr ->> 'last_name', pr ->> 'title', pr ->> 'email', pr ->> 'phone',
                    pr ->> 'linkedin_url', not exists (select 1 from public.people where company_id = v_company));
            v_people := v_people + 1;
          else
            update public.people set
              title = coalesce(title, nullif(btrim(coalesce(pr ->> 'title', '')), '')),
              email = coalesce(email, nullif(btrim(coalesce(pr ->> 'email', '')), '')),
              phone = coalesce(phone, nullif(btrim(coalesce(pr ->> 'phone', '')), '')),
              linkedin_url = coalesce(linkedin_url, nullif(btrim(coalesce(pr ->> 'linkedin_url', '')), ''))
            where id = v_existing_person;
          end if;
        end loop;
        perform public.log_event(v_company, 'system', 'Fiche complétée par import CSV');
        v_completed := v_completed + 1;
      else
        raise exception 'Action inconnue';
      end if;

      insert into public.import_row_keys (row_hash, company_id, import_id)
      select h, v_company, v_import_id from jsonb_array_elements_text(coalesce(g -> 'row_hashes', '[]')) h
      on conflict (row_hash) do nothing;

      if p_list_id is not null then
        insert into public.list_members (list_id, company_id) values (p_list_id, v_company) on conflict do nothing;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('rows', g -> 'rows', 'message', sqlerrm));
    end;
  end loop;

  v_res := jsonb_build_object('import_id', v_import_id, 'created', v_created, 'completed', v_completed,
                              'skipped', v_skipped, 'people', v_people, 'errors', v_errors);
  update public.imports set summary = v_res where id = v_import_id;
  return v_res;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lecture : recherche globale et relances du jour
-- ---------------------------------------------------------------------------

create or replace function public.search_companies(p_query text, p_include_archived boolean default false, p_limit int default 20)
returns table (id uuid, name text, website text, archived boolean, matched text)
language plpgsql
stable
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
  qn text := public.norm_company_name(p_query);
begin
  perform public.assert_owner();
  if q = '' then return; end if;
  return query
  select c.id, c.name, c.website, c.archived_at is not null,
         coalesce(
           case when c.name ilike '%' || q || '%' or c.name_norm like '%' || coalesce(qn, q) || '%' then null end,
           case when c.domain_norm like '%' || q || '%' then 'Domaine : ' || c.domain_norm end,
           (select 'Personne : ' || btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) || coalesce(' · ' || p.email, '')
              from public.people p
             where p.company_id = c.id
               and (p.full_name_norm like '%' || coalesce(public.norm_person_name(q, null), q) || '%'
                    or p.email_norm like '%' || q || '%' or p.linkedin_norm like '%' || q || '%')
             limit 1))
    from public.companies c
   where c.merged_into_id is null
     and (p_include_archived or c.archived_at is null)
     and (c.name ilike '%' || q || '%'
          or c.name_norm like '%' || coalesce(qn, q) || '%'
          or c.domain_norm like '%' || q || '%'
          or exists (select 1 from public.people p where p.company_id = c.id
                      and (p.full_name_norm like '%' || coalesce(public.norm_person_name(q, null), q) || '%'
                           or p.email_norm like '%' || q || '%' or p.linkedin_norm like '%' || q || '%')))
   order by (c.name_norm = qn) desc, (c.name ilike q || '%') desc, c.name
   limit greatest(1, least(p_limit, 50));
end;
$$;

-- Actions à faire : tâches ouvertes + étapes de prospection en attente.
-- Les deux sources sont distinctes (aucune tâche n'est générée pour une étape), donc pas de doublon.
create or replace view public.todo_items with (security_invoker = true) as
  select 'task'::text as item_type, t.id, t.company_id, c.name as company_name, t.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as person_name,
         t.title, t.due_date, null::uuid as campaign_id, null::text as campaign_name, null::text as channel,
         null::int as step_position, null::text as step_message
    from public.tasks t
    join public.companies c on c.id = t.company_id
    left join public.people p on p.id = t.person_id
   where t.done_at is null and c.merged_into_id is null and c.archived_at is null
  union all
  select 'followup', cp.id, cp.company_id, c.name, cp.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         cs.name, cp.next_due_date, ca.id, ca.name, cs.channel, cs.position, cs.message
    from public.campaign_participants cp
    join public.campaigns ca on ca.id = cp.campaign_id and ca.archived_at is null
    join public.companies c on c.id = cp.company_id
    join public.campaign_steps cs on cs.campaign_id = cp.campaign_id and cs.position = cp.current_step
    left join public.people p on p.id = cp.person_id
   where cp.status in ('a_contacter','en_cours') and cp.next_due_date is not null
     and c.merged_into_id is null and c.archived_at is null;

-- Vue d'ensemble d'une fiche pour les tableaux (prospection et kanban)
create or replace view public.company_overview with (security_invoker = true) as
  select c.*,
         pp.id as primary_person_id,
         nullif(btrim(coalesce(pp.first_name,'') || ' ' || coalesce(pp.last_name,'')), '') as primary_person_name,
         pp.email as primary_person_email,
         (select count(*) from public.people p where p.company_id = c.id)::int as people_count,
         coalesce((select array_agg(lm.list_id) from public.list_members lm where lm.company_id = c.id), '{}') as list_ids,
         na.title as next_action_title, na.due_date as next_action_due, na.item_type as next_action_type,
         coalesce((select string_agg(coalesce(p.email,'') || ' ' || coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,''), ' ')
                     from public.people p where p.company_id = c.id), '') as people_search
    from public.companies c
    left join lateral (
      select * from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1
    ) pp on true
    left join lateral (
      select ti.title, ti.due_date, ti.item_type from public.todo_items ti
       where ti.company_id = c.id order by ti.due_date, ti.item_type limit 1
    ) na on true
   where c.merged_into_id is null;

-- ---------------------------------------------------------------------------
-- Droits d'exécution : rien pour anon
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.todo_items, public.company_overview from anon;
grant select on public.todo_items, public.company_overview to authenticated;


-- ===== 20261029000400_seed_sources.sql =====
-- Valeurs initiales de la liste « Source du lead » (modifiables dans Paramètres).
-- Ce ne sont pas des données de démonstration : aucun prospect ni pipeline n'est créé.
insert into public.lead_sources (name, position) values
  ('LinkedIn', 1), ('Email sortant', 2), ('Recommandation', 3), ('Site web', 4), ('Événement', 5), ('Autre', 6)
on conflict do nothing;


-- ===== 20261029000500_templates.sql =====
-- Modèles de prospection : enregistrement atomique des étapes et duplication.

create or replace function public.save_template(p_id uuid, p_name text, p_steps jsonb)
returns uuid
language plpgsql
as $$
declare
  v_id uuid := p_id;
  s jsonb;
  i int := 0;
begin
  perform public.assert_owner();
  if coalesce(btrim(p_name), '') = '' then raise exception 'Le nom du modèle est obligatoire' using errcode = '22023'; end if;
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Ajoutez au moins une étape' using errcode = '22023';
  end if;
  if v_id is null then
    insert into public.templates (name) values (btrim(p_name)) returning id into v_id;
  else
    update public.templates set name = btrim(p_name) where id = v_id;
    if not found then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
    delete from public.template_steps where template_id = v_id;
  end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    i := i + 1;
    if coalesce(btrim(s ->> 'name'), '') = '' then
      raise exception 'Étape % : le nom est obligatoire', i using errcode = '22023';
    end if;
    insert into public.template_steps (template_id, position, name, channel, delay_days, message)
    values (v_id, i, btrim(s ->> 'name'), coalesce(s ->> 'channel', 'other'),
            coalesce(nullif(s ->> 'delay_days', '')::int, 0), nullif(btrim(coalesce(s ->> 'message', '')), ''));
  end loop;
  return v_id;
end;
$$;

create or replace function public.duplicate_template(p_id uuid)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  insert into public.templates (name)
  select name || ' (copie)' from public.templates where id = p_id
  returning id into v_id;
  if v_id is null then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
  insert into public.template_steps (template_id, position, name, channel, delay_days, message)
  select v_id, position, name, channel, delay_days, message from public.template_steps where template_id = p_id;
  return v_id;
end;
$$;

revoke execute on function public.save_template(uuid, text, jsonb), public.duplicate_template(uuid) from public, anon;
grant execute on function public.save_template(uuid, text, jsonb), public.duplicate_template(uuid) to authenticated;


-- ===== 20261029000600_tasks_idempotent.sql =====
-- Création de tâche protégée contre la répétition d'une même requête (connecteur Claude).
create or replace function public.create_task(
  p_company uuid, p_title text, p_due date, p_person uuid default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;
  insert into public.tasks (company_id, person_id, title, due_date, source)
  values (p_company, p_person, btrim(p_title), p_due, case when public.current_actor() = 'claude' then 'claude' else 'user' end)
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'create_task', jsonb_build_object('status', 'created', 'id', v_id));
end;
$$;

revoke execute on function public.create_task(uuid, text, date, uuid, text) from public, anon;
grant execute on function public.create_task(uuid, text, date, uuid, text) to authenticated;


-- ===== 20261030000100_prospection_v2.sql =====
-- Prospection v2 : campagnes avec statut, séquences versionnées, types d'étapes manuelles,
-- brouillons personnalisés, journal d'actions annulables, résultats commerciaux,
-- « Ne plus contacter », vues enregistrées. Migration additive : aucune donnée supprimée.

-- ---------------------------------------------------------------------------
-- Types d'étapes
-- ---------------------------------------------------------------------------

create or replace function public.step_channel(p_type text)
returns text
language sql
immutable
as $$
  select case
    when p_type = 'email' then 'email'
    when p_type like 'linkedin_%' then 'linkedin'
    when p_type = 'call' then 'phone'
    else 'other' end;
$$;

-- type d'interaction enregistrée lorsque l'étape est réalisée
create or replace function public.step_interaction_kind(p_type text)
returns text
language sql
immutable
as $$
  select case
    when p_type in ('email', 'linkedin_message', 'linkedin_invite') then 'message_out'
    when p_type = 'call' then 'call'
    else 'prospecting' end;
$$;

-- ---------------------------------------------------------------------------
-- Colonnes ajoutées
-- ---------------------------------------------------------------------------

alter table public.companies
  add column do_not_contact boolean not null default false,
  add column do_not_contact_reason text check (do_not_contact_reason is null or char_length(do_not_contact_reason) <= 500),
  add column do_not_contact_at timestamptz;

alter table public.campaigns
  add column status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'finished', 'archived')),
  add column current_version int not null default 1,
  add column description text check (description is null or char_length(description) <= 2000);
update public.campaigns set status = case when archived_at is not null then 'archived' else 'active' end;

alter table public.template_steps
  add column step_type text,
  add column subject text check (subject is null or char_length(subject) <= 300),
  add column instructions text check (instructions is null or char_length(instructions) <= 2000);
update public.template_steps set step_type = case channel
  when 'linkedin' then 'linkedin_message' when 'email' then 'email' when 'phone' then 'call' else 'task' end;
alter table public.template_steps alter column step_type set not null;

alter table public.campaign_steps
  add column version int not null default 1,
  add column step_type text,
  add column subject text check (subject is null or char_length(subject) <= 300),
  add column instructions text check (instructions is null or char_length(instructions) <= 2000);
update public.campaign_steps set step_type = case channel
  when 'linkedin' then 'linkedin_message' when 'email' then 'email' when 'phone' then 'call' else 'task' end;
alter table public.campaign_steps alter column step_type set not null;
alter table public.campaign_steps drop constraint campaign_steps_campaign_id_position_key;
alter table public.campaign_steps add constraint campaign_steps_version_position_key unique (campaign_id, version, position);

do $$
declare t text;
begin
  foreach t in array array['template_steps', 'campaign_steps'] loop
    execute format($f$alter table public.%I add constraint %I check (step_type in
      ('email','linkedin_invite','linkedin_message','call','linkedin_visit','linkedin_interaction','task'))$f$, t, t || '_type_check');
  end loop;
end $$;

-- variables v1 {prénom} / {entreprise} → syntaxe v2 {{prenom}} / {{entreprise}}
update public.template_steps set message = regexp_replace(regexp_replace(message,
  '\{\s*pr[ée]nom\s*\}', '{{prenom}}', 'gi'), '\{\s*entreprise\s*\}', '{{entreprise}}', 'gi') where message is not null;
update public.campaign_steps set message = regexp_replace(regexp_replace(message,
  '\{\s*pr[ée]nom\s*\}', '{{prenom}}', 'gi'), '\{\s*entreprise\s*\}', '{{entreprise}}', 'gi') where message is not null;

alter table public.campaign_participants drop constraint campaign_participants_status_check;
alter table public.campaign_participants add constraint campaign_participants_status_check
  check (status in ('a_preparer', 'a_contacter', 'en_cours', 'a_repondu', 'termine', 'arrete'));
alter table public.campaign_participants
  add column sequence_version int,
  add column outcome text not null default 'none'
    check (outcome in ('none', 'replied', 'interested', 'not_interested', 'meeting', 'do_not_contact')),
  add column outcome_at timestamptz,
  add column activated_at timestamptz,
  add column moved_to_pipeline_at timestamptz;
update public.campaign_participants set sequence_version = 1, activated_at = created_at;
update public.campaign_participants set outcome = 'replied', outcome_at = updated_at where status = 'a_repondu';
alter table public.campaign_participants alter column sequence_version set not null;

-- ---------------------------------------------------------------------------
-- Nouvelles tables
-- ---------------------------------------------------------------------------

-- Brouillon personnalisé d'une étape pour un participant (≠ modèle, ≠ contenu envoyé)
create table public.participant_drafts (
  participant_id uuid not null references public.campaign_participants (id) on delete cascade,
  sequence_version int not null,
  step_position int not null,
  subject text check (subject is null or char_length(subject) <= 300),
  body text check (body is null or char_length(body) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (participant_id, sequence_version, step_position)
);

-- Journal des actions sur un participant, pour l'annulation courte
create table public.participant_actions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.campaign_participants (id) on delete cascade,
  action text not null check (action in ('done', 'skip')),
  step_position int not null,
  interaction_id uuid references public.interactions (id) on delete set null,
  prev_state jsonb not null,
  next_state jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index participant_actions_participant_idx on public.participant_actions (participant_id, created_at desc);

-- Vues enregistrées (filtres, colonnes, ordre) et préférences d'affichage
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (char_length(scope) between 1 and 60),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  config jsonb not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.user_preferences (
  key text primary key check (char_length(key) between 1 and 120),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['participant_drafts', 'participant_actions', 'saved_views', 'user_preferences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- un participant prend la version courante de la séquence ; « Ne plus contacter » bloque l'inscription
create or replace function public.tg_participants_before_insert()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.companies where id = new.company_id and do_not_contact) then
    return null; -- ignoré silencieusement : les fonctions d'inscription le comptent comme bloqué
  end if;
  if new.sequence_version is null then
    select current_version into new.sequence_version from public.campaigns where id = new.campaign_id;
  end if;
  if new.status <> 'a_preparer' and new.activated_at is null then
    new.activated_at := now();
  end if;
  return new;
end;
$$;
create trigger participants_before_insert before insert on public.campaign_participants
  for each row execute function public.tg_participants_before_insert();

-- une réponse (statut a_repondu) devient le résultat « a répondu » si rien de plus précis n'existe
create or replace function public.tg_participants_outcome()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'a_repondu' and old.status <> 'a_repondu' and new.outcome = 'none' then
    new.outcome := 'replied';
    new.outcome_at := now();
  end if;
  return new;
end;
$$;
create trigger participants_outcome before update of status on public.campaign_participants
  for each row execute function public.tg_participants_outcome();

-- passage en pipeline : mémorisé sur les participations de l'entreprise (statistiques)
create or replace function public.tg_companies_pipeline_entry()
returns trigger
language plpgsql
as $$
begin
  if new.stage_id is not null and old.pipeline_id is null then
    update public.campaign_participants set moved_to_pipeline_at = coalesce(moved_to_pipeline_at, now())
     where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger companies_pipeline_entry after update of stage_id on public.companies
  for each row execute function public.tg_companies_pipeline_entry();

do $$
declare t text;
begin
  foreach t in array array['saved_views', 'user_preferences', 'participant_drafts'] loop
    if t <> 'saved_views' then
      execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
    end if;
  end loop;
end $$;

-- type ⇄ canal : l'un se déduit de l'autre si absent (compatibilité avec les écritures v1)
create or replace function public.tg_steps_type_channel()
returns trigger
language plpgsql
as $$
begin
  if new.step_type is null then
    new.step_type := case new.channel when 'linkedin' then 'linkedin_message' when 'email' then 'email'
                                      when 'phone' then 'call' else 'task' end;
  end if;
  new.channel := public.step_channel(new.step_type);
  return new;
end;
$$;
create trigger steps_type_channel before insert or update on public.template_steps
  for each row execute function public.tg_steps_type_channel();
create trigger steps_type_channel before insert or update on public.campaign_steps
  for each row execute function public.tg_steps_type_channel();

-- ---------------------------------------------------------------------------
-- Campagnes
-- ---------------------------------------------------------------------------

create or replace function public.validate_steps(p_steps jsonb)
returns void
language plpgsql
as $$
declare s jsonb; i int := 0;
begin
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Ajoutez au moins une étape' using errcode = '22023';
  end if;
  if jsonb_array_length(p_steps) > 30 then
    raise exception '30 étapes maximum' using errcode = '22023';
  end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    i := i + 1;
    if coalesce(btrim(s ->> 'name'), '') = '' then
      raise exception 'Étape % : le titre est obligatoire', i using errcode = '22023';
    end if;
    if coalesce(s ->> 'step_type', '') not in ('email','linkedin_invite','linkedin_message','call','linkedin_visit','linkedin_interaction','task') then
      raise exception 'Étape % : type inconnu', i using errcode = '22023';
    end if;
    if coalesce(nullif(s ->> 'delay_days', '')::int, 0) not between 0 and 365 then
      raise exception 'Étape % : délai entre 0 et 365 jours', i using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function public.insert_campaign_steps(p_campaign uuid, p_version int, p_steps jsonb)
returns void
language sql
as $$
  insert into public.campaign_steps (campaign_id, version, position, name, step_type, channel, delay_days, subject, message, instructions)
  select p_campaign, p_version, o::int, btrim(s ->> 'name'), s ->> 'step_type', public.step_channel(s ->> 'step_type'),
         coalesce(nullif(s ->> 'delay_days', '')::int, 0),
         nullif(btrim(coalesce(s ->> 'subject', '')), ''),
         nullif(coalesce(s ->> 'message', ''), ''),
         nullif(btrim(coalesce(s ->> 'instructions', '')), '')
    from jsonb_array_elements(p_steps) with ordinality as t(s, o);
$$;

create or replace function public.create_campaign_draft(p_name text, p_template uuid default null)
returns uuid
language plpgsql
as $$
declare v_id uuid; v_steps jsonb;
begin
  perform public.assert_owner();
  insert into public.campaigns (name, template_id, template_name, status)
  values (coalesce(nullif(btrim(p_name), ''), 'Nouvelle campagne'), p_template,
          (select name from public.templates where id = p_template), 'draft')
  returning id into v_id;
  if p_template is not null then
    select jsonb_agg(jsonb_build_object('name', name, 'step_type', step_type, 'delay_days', delay_days,
                     'subject', subject, 'message', message, 'instructions', instructions) order by position)
      into v_steps from public.template_steps where template_id = p_template;
    if v_steps is not null then perform public.insert_campaign_steps(v_id, 1, v_steps); end if;
  end if;
  return v_id;
end;
$$;

-- Enregistre la séquence. Si des participants ont déjà démarré sur la version courante et que la
-- structure change (ordre, types, délais, nombre), une nouvelle version est créée : les
-- participants démarrés gardent leur version, les participants à préparer passent à la nouvelle.
create or replace function public.save_campaign_sequence(p_campaign uuid, p_steps jsonb)
returns jsonb
language plpgsql
as $$
declare
  c public.campaigns;
  v_old_sig text;
  v_new_sig text;
  v_started int;
  v_new_version int;
begin
  perform public.assert_owner();
  perform public.validate_steps(p_steps);
  select * into c from public.campaigns where id = p_campaign for update;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  if c.status = 'archived' then raise exception 'Campagne archivée : désarchivez-la pour la modifier' using errcode = '22023'; end if;

  select coalesce(string_agg(step_type || ':' || delay_days, '|' order by position), '') into v_old_sig
    from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  select coalesce(string_agg((s ->> 'step_type') || ':' || coalesce(nullif(s ->> 'delay_days', '')::int, 0), '|' order by o), '')
    into v_new_sig from jsonb_array_elements(p_steps) with ordinality as t(s, o);
  select count(*) into v_started from public.campaign_participants
   where campaign_id = c.id and sequence_version = c.current_version and status <> 'a_preparer';

  if v_started > 0 and v_old_sig <> v_new_sig then
    v_new_version := c.current_version + 1;
    perform public.insert_campaign_steps(c.id, v_new_version, p_steps);
    update public.campaigns set current_version = v_new_version where id = c.id;
    update public.campaign_participants set sequence_version = v_new_version
     where campaign_id = c.id and status = 'a_preparer';
    return jsonb_build_object('version', v_new_version, 'new_version', true, 'kept_on_previous', v_started);
  end if;

  -- même structure (ou aucun participant démarré) : mise à jour de la version courante
  delete from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  perform public.insert_campaign_steps(c.id, c.current_version, p_steps);
  update public.campaigns set updated_at = now() where id = c.id;
  return jsonb_build_object('version', c.current_version, 'new_version', false);
end;
$$;

create or replace function public.set_campaign_status(p_campaign uuid, p_status text)
returns void
language plpgsql
as $$
declare c public.campaigns;
begin
  perform public.assert_owner();
  if p_status not in ('draft', 'active', 'paused', 'finished', 'archived') then
    raise exception 'Statut invalide' using errcode = '22023';
  end if;
  select * into c from public.campaigns where id = p_campaign for update;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  if p_status = 'active' and not exists (select 1 from public.campaign_steps where campaign_id = c.id and version = c.current_version) then
    raise exception 'La séquence est vide' using errcode = '22023';
  end if;
  update public.campaigns
     set status = p_status,
         archived_at = case when p_status = 'archived' then coalesce(archived_at, now()) else null end
   where id = c.id;
end;
$$;

-- Duplique structure et contenus, sans participants ni historique
create or replace function public.duplicate_campaign(p_campaign uuid)
returns uuid
language plpgsql
as $$
declare c public.campaigns; v_id uuid;
begin
  perform public.assert_owner();
  select * into c from public.campaigns where id = p_campaign;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  insert into public.campaigns (name, template_id, template_name, description, status)
  values (c.name || ' (copie)', c.template_id, c.template_name, c.description, 'draft') returning id into v_id;
  insert into public.campaign_steps (campaign_id, version, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, 1, position, name, step_type, channel, delay_days, subject, message, instructions
    from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  return v_id;
end;
$$;

create or replace function public.save_campaign_as_template(p_campaign uuid, p_name text)
returns uuid
language plpgsql
as $$
declare c public.campaigns; v_id uuid;
begin
  perform public.assert_owner();
  select * into c from public.campaigns where id = p_campaign;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  insert into public.templates (name) values (coalesce(nullif(btrim(p_name), ''), c.name)) returning id into v_id;
  insert into public.template_steps (template_id, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, position, name, step_type, channel, delay_days, subject, message, instructions
    from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  return v_id;
end;
$$;

-- Modèles : nouvelle signature avec types, objet et consignes
create or replace function public.save_template(p_id uuid, p_name text, p_steps jsonb)
returns uuid
language plpgsql
as $$
declare v_id uuid := p_id;
begin
  perform public.assert_owner();
  if coalesce(btrim(p_name), '') = '' then raise exception 'Le nom du modèle est obligatoire' using errcode = '22023'; end if;
  -- compatibilité v1 : un « channel » sans step_type est converti
  select jsonb_agg(case when s ? 'step_type' then s else s || jsonb_build_object('step_type',
           case s ->> 'channel' when 'linkedin' then 'linkedin_message' when 'email' then 'email' when 'phone' then 'call' else 'task' end) end)
    into p_steps from jsonb_array_elements(coalesce(p_steps, '[]')) s;
  perform public.validate_steps(coalesce(p_steps, '[]'));
  if v_id is null then
    insert into public.templates (name) values (btrim(p_name)) returning id into v_id;
  else
    update public.templates set name = btrim(p_name) where id = v_id;
    if not found then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
    delete from public.template_steps where template_id = v_id;
  end if;
  insert into public.template_steps (template_id, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, o::int, btrim(s ->> 'name'), s ->> 'step_type', public.step_channel(s ->> 'step_type'),
         coalesce(nullif(s ->> 'delay_days', '')::int, 0), nullif(btrim(coalesce(s ->> 'subject', '')), ''),
         nullif(coalesce(s ->> 'message', ''), ''), nullif(btrim(coalesce(s ->> 'instructions', '')), '')
    from jsonb_array_elements(p_steps) with ordinality as t(s, o);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Participants : inscription, préparation, activation
-- ---------------------------------------------------------------------------

-- Inscription « à préparer » : une entreprise n'apparaît qu'une fois, « Ne plus contacter » est exclu
create or replace function public.enroll_in_campaign(p_campaign uuid, p_company_ids uuid[] default '{}', p_list_ids uuid[] default '{}')
returns jsonb
language plpgsql
as $$
declare
  v_candidates uuid[];
  v_added int;
  v_blocked int;
  v_total int;
begin
  perform public.assert_owner();
  if not exists (select 1 from public.campaigns where id = p_campaign and status <> 'archived') then
    raise exception 'Campagne introuvable ou archivée' using errcode = 'P0002';
  end if;
  if cardinality(p_list_ids) > 0 then
    insert into public.campaign_lists (campaign_id, list_id) select p_campaign, l from unnest(p_list_ids) l on conflict do nothing;
  end if;
  select coalesce(array_agg(distinct c.id), '{}') into v_candidates
    from public.companies c
   where c.merged_into_id is null and c.archived_at is null
     and (c.id = any (p_company_ids)
          or c.id in (select company_id from public.list_members where list_id = any (p_list_ids)));
  v_total := cardinality(v_candidates);
  select count(*) into v_blocked from public.companies where id = any (v_candidates) and do_not_contact;

  insert into public.campaign_participants (campaign_id, company_id, person_id, status, next_due_date)
  select p_campaign, c.id,
         (select p.id from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1),
         'a_preparer', null
    from public.companies c
   where c.id = any (v_candidates) and not c.do_not_contact
  on conflict (campaign_id, company_id) do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object('added', v_added, 'blocked', v_blocked, 'already_present', v_total - v_added - v_blocked);
end;
$$;

-- Sollicitations simultanées : autres participations actives des mêmes entreprises
create or replace function public.campaign_conflicts(p_campaign uuid)
returns table (participant_id uuid, company_id uuid, other_participant_id uuid, other_campaign_id uuid,
               other_campaign_name text, other_status text, other_last_done_at timestamptz, other_person_id uuid)
language sql
stable
as $$
  select cp.id, cp.company_id, o.id, oc.id, oc.name, o.status, o.last_done_at, o.person_id
    from public.campaign_participants cp
    join public.campaign_participants o on o.company_id = cp.company_id and o.campaign_id <> cp.campaign_id
    join public.campaigns oc on oc.id = o.campaign_id
   where cp.campaign_id = p_campaign
     and o.status in ('a_contacter', 'en_cours', 'a_repondu')
     and oc.status in ('active', 'paused');
$$;

-- « Activer » : rend les actions disponibles et calcule les échéances. Aucun message n'est envoyé.
create or replace function public.activate_participants(p_campaign uuid, p_ids uuid[], p_confirm_conflicts boolean default false)
returns jsonb
language plpgsql
as $$
declare
  c public.campaigns;
  v_conflicts jsonb;
  v_blocked int;
  v_activated int;
  v_first_delay int;
begin
  perform public.assert_owner();
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or c.status = 'archived' then raise exception 'Campagne introuvable ou archivée' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.campaign_steps where campaign_id = c.id and version = c.current_version) then
    raise exception 'La séquence est vide : ajoutez au moins une étape' using errcode = '22023';
  end if;

  select count(*) into v_blocked from public.campaign_participants cp join public.companies co on co.id = cp.company_id
   where cp.id = any (p_ids) and cp.campaign_id = c.id and co.do_not_contact;

  select coalesce(jsonb_agg(jsonb_build_object('participant_id', k.participant_id, 'company_id', k.company_id,
           'company_name', co.name, 'other_campaign_id', k.other_campaign_id, 'other_campaign_name', k.other_campaign_name,
           'other_status', k.other_status, 'other_last_done_at', k.other_last_done_at, 'other_participant_id', k.other_participant_id)), '[]')
    into v_conflicts
    from public.campaign_conflicts(c.id) k join public.companies co on co.id = k.company_id
   where k.participant_id = any (p_ids);

  if jsonb_array_length(v_conflicts) > 0 and not p_confirm_conflicts then
    return jsonb_build_object('status', 'conflicts', 'conflicts', v_conflicts);
  end if;

  update public.campaign_participants cp
     set status = 'a_contacter',
         activated_at = now(),
         current_step = 1,
         next_due_date = public.today_paris() + coalesce((select delay_days from public.campaign_steps s
                          where s.campaign_id = c.id and s.version = cp.sequence_version and s.position = 1), 0)
   where cp.id = any (p_ids) and cp.campaign_id = c.id and cp.status = 'a_preparer'
     and not exists (select 1 from public.companies co where co.id = cp.company_id and co.do_not_contact);
  get diagnostics v_activated = row_count;

  if v_activated > 0 and c.status = 'draft' then
    update public.campaigns set status = 'active' where id = c.id;
  end if;
  return jsonb_build_object('status', 'activated', 'activated', v_activated, 'blocked', v_blocked,
                            'conflicts_confirmed', jsonb_array_length(v_conflicts));
end;
$$;

create or replace function public.save_participant_draft(p_participant uuid, p_position int, p_subject text, p_body text)
returns void
language plpgsql
as $$
declare cp public.campaign_participants;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  if p_subject is null and p_body is null then
    delete from public.participant_drafts where participant_id = cp.id and sequence_version = cp.sequence_version and step_position = p_position;
    return;
  end if;
  insert into public.participant_drafts (participant_id, sequence_version, step_position, subject, body)
  values (cp.id, cp.sequence_version, p_position, p_subject, p_body)
  on conflict (participant_id, sequence_version, step_position)
  do update set subject = excluded.subject, body = excluded.body, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Exécution des étapes
-- ---------------------------------------------------------------------------

create or replace function public.participant_state(cp public.campaign_participants)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('status', cp.status, 'current_step', cp.current_step, 'next_due_date', cp.next_due_date,
                            'last_done_at', cp.last_done_at, 'person_id', cp.person_id);
$$;

-- Réalise l'étape courante (envoi, appel, visite…). Une seule transaction : interaction,
-- avancement et prochaine échéance (calculée depuis la date réelle de réalisation).
create or replace function public.complete_step(
  p_participant uuid,
  p_content text default null,
  p_subject text default null,
  p_done_at timestamptz default null,
  p_person uuid default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  cp public.campaign_participants;
  st public.campaign_steps;
  nxt public.campaign_steps;
  v_camp public.campaigns;
  v_at timestamptz := coalesce(p_done_at, now());
  v_person uuid;
  v_kind text;
  v_var text;
  v_interaction uuid;
  v_action uuid;
  v_before jsonb;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  select * into v_camp from public.campaigns where id = cp.campaign_id;
  if v_camp.status in ('paused', 'archived') then
    raise exception 'Campagne % : reprenez-la avant de réaliser une étape', case v_camp.status when 'paused' then 'en pause' else 'archivée' end
      using errcode = '22023';
  end if;
  if cp.status = 'a_preparer' then raise exception 'Ce participant n''est pas encore activé' using errcode = '22023'; end if;
  if cp.status in ('termine', 'arrete') then raise exception 'Le suivi de cette fiche est terminé ou arrêté' using errcode = '22023'; end if;
  if exists (select 1 from public.companies where id = cp.company_id and do_not_contact) then
    raise exception 'Fiche marquée « Ne plus contacter »' using errcode = '22023';
  end if;
  if v_at > now() + interval '1 day' then raise exception 'La date ne peut pas être dans le futur' using errcode = '22023'; end if;

  select * into st from public.campaign_steps
   where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  select * into nxt from public.campaign_steps
   where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step + 1;

  -- jamais de variable non remplacée dans un contenu réellement envoyé
  v_var := substring(coalesce(p_subject, '') || ' ' || coalesce(p_content, '') from '\{\{\s*[[:alnum:]_]+\s*\}\}');
  if v_var is not null then
    raise exception 'Variable non remplacée : % — complétez la fiche ou retirez-la du message', v_var using errcode = '22023';
  end if;
  v_kind := public.step_interaction_kind(st.step_type);
  if st.step_type in ('email', 'linkedin_message') and coalesce(btrim(p_content), '') = '' then
    raise exception 'Le contenu réellement envoyé est obligatoire' using errcode = '22023';
  end if;

  v_person := coalesce(p_person, cp.person_id);
  if v_person is not null and not exists (select 1 from public.people where id = v_person and company_id = cp.company_id) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;

  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source,
                                   campaign_participant_id, meta)
  values (cp.company_id, v_person, v_kind, st.channel, v_at,
          coalesce(nullif(btrim(p_content), ''), case when v_kind = 'prospecting' then st.name end), 'user',
          case when public.current_actor() = 'claude' then 'claude' else 'user' end, cp.id,
          jsonb_build_object('campaign_id', v_camp.id, 'campaign_name', v_camp.name, 'step_position', st.position,
                             'step_name', st.name, 'step_type', st.step_type, 'subject', nullif(btrim(p_subject), ''),
                             'sequence_version', cp.sequence_version))
  returning id into v_interaction;

  v_before := public.participant_state(cp);
  if nxt.id is not null then
    update public.campaign_participants
       set status = 'en_cours', current_step = nxt.position, last_done_at = v_at, person_id = v_person,
           next_due_date = (v_at at time zone 'Europe/Paris')::date + nxt.delay_days
     where id = cp.id returning * into cp;
  else
    update public.campaign_participants
       set status = 'termine', current_step = st.position + 1, last_done_at = v_at, person_id = v_person, next_due_date = null
     where id = cp.id returning * into cp;
  end if;

  insert into public.participant_actions (participant_id, action, step_position, interaction_id, prev_state, next_state)
  values (cp.id, 'done', st.position, v_interaction, v_before, public.participant_state(cp))
  returning id into v_action;

  if v_kind = 'message_out' or v_kind = 'call' then
    update public.companies set prospect_status = 'contacte' where id = cp.company_id and prospect_status = 'nouveau';
  end if;

  return public.idem_put(p_idempotency_key, 'complete_step', jsonb_build_object(
    'status', 'done', 'action_id', v_action, 'finished', nxt.id is null,
    'next_due_date', cp.next_due_date, 'next_step', case when nxt.id is null then null else nxt.position end));
end;
$$;

-- Ignorer une étape : passe à la suivante sans rien enregistrer comme envoyé (≠ arrêter le suivi)
create or replace function public.skip_step(p_participant uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  cp public.campaign_participants;
  st public.campaign_steps;
  nxt public.campaign_steps;
  v_before jsonb;
  v_action uuid;
  v_interaction uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  if cp.status not in ('a_contacter', 'en_cours') then raise exception 'Seul un suivi actif peut ignorer une étape' using errcode = '22023'; end if;
  select * into st from public.campaign_steps where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step;
  select * into nxt from public.campaign_steps where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step + 1;
  v_interaction := public.log_event(cp.company_id, 'prospecting', 'Étape ignorée : ' || coalesce(st.name, '?'),
    jsonb_build_object('campaign_id', cp.campaign_id, 'step_position', cp.current_step, 'skipped', true));
  update public.interactions set campaign_participant_id = cp.id where id = v_interaction;
  v_before := public.participant_state(cp);
  update public.campaign_participants
     set current_step = cp.current_step + 1,
         status = case when nxt.id is null then 'termine' else cp.status end,
         next_due_date = case when nxt.id is null then null else public.today_paris() + nxt.delay_days end
   where id = cp.id returning * into cp;
  insert into public.participant_actions (participant_id, action, step_position, interaction_id, prev_state, next_state)
  values (cp.id, 'skip', st.position, v_interaction, v_before, public.participant_state(cp)) returning id into v_action;
  return public.idem_put(p_idempotency_key, 'skip_step', jsonb_build_object('status', 'skipped', 'action_id', v_action, 'finished', nxt.id is null));
end;
$$;

-- Annulation courte : rétablit l'état précédent si rien n'a changé depuis
create or replace function public.undo_participant_action(p_action uuid)
returns jsonb
language plpgsql
as $$
declare
  a public.participant_actions;
  cp public.campaign_participants;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Annulation');
  select * into a from public.participant_actions where id = p_action for update;
  if not found then raise exception 'Action introuvable' using errcode = 'P0002'; end if;
  if a.undone_at is not null then return jsonb_build_object('status', 'already_undone'); end if;
  if a.created_at < now() - interval '15 minutes' then
    raise exception 'Délai d''annulation dépassé' using errcode = '22023';
  end if;
  select * into cp from public.campaign_participants where id = a.participant_id for update;
  if public.participant_state(cp) is distinct from a.next_state then
    raise exception 'Annulation impossible : ce suivi a été modifié depuis' using errcode = '22023';
  end if;
  update public.campaign_participants
     set status = a.prev_state ->> 'status',
         current_step = (a.prev_state ->> 'current_step')::int,
         next_due_date = nullif(a.prev_state ->> 'next_due_date', '')::date,
         last_done_at = nullif(a.prev_state ->> 'last_done_at', '')::timestamptz,
         person_id = nullif(a.prev_state ->> 'person_id', '')::uuid
   where id = cp.id;
  if a.interaction_id is not null then
    delete from public.interactions where id = a.interaction_id;
  end if;
  update public.participant_actions set undone_at = now() where id = a.id;
  return jsonb_build_object('status', 'undone');
end;
$$;

-- compatibilité : l'ancienne action « Marquer comme envoyé » passe par complete_step
create or replace function public.mark_step_sent(
  p_participant uuid, p_content text, p_sent_at timestamptz default null, p_person uuid default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare r jsonb;
begin
  r := public.complete_step(p_participant, p_content, null, p_sent_at, p_person, p_idempotency_key);
  return jsonb_build_object('status', 'sent', 'finished', (r ->> 'finished')::boolean, 'action_id', r ->> 'action_id');
end;
$$;

create or replace function public.record_reply(
  p_participant uuid, p_content text, p_received_at timestamptz default null, p_person uuid default null, p_channel text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  st public.campaign_steps;
  v_res jsonb;
begin
  perform public.assert_owner();
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
  return jsonb_build_object('status', 'paused', 'paused_followups', (v_res ->> 'paused_followups')::int);
end;
$$;

-- Résultat commercial d'une participation (distinct du statut d'exécution et du statut CRM)
create or replace function public.set_participant_outcome(
  p_participant uuid, p_outcome text, p_stage uuid default null, p_note text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  v_stopped int := 0;
  v_move jsonb;
begin
  perform public.assert_owner();
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
  if p_outcome = 'interested' then
    update public.companies set prospect_status = 'qualifie' where id = cp.company_id and prospect_status <> 'qualifie';
    if p_stage is not null then
      v_move := public.move_company(cp.company_id, p_stage, true, null);
    end if;
  end if;
  if p_outcome = 'meeting' then
    update public.companies set prospect_status = 'qualifie' where id = cp.company_id and prospect_status in ('nouveau','contacte','en_discussion');
  end if;

  perform public.log_event(cp.company_id, 'prospecting',
    case p_outcome
      when 'replied' then 'Résultat : a répondu'
      when 'interested' then 'Résultat : intéressé'
      when 'not_interested' then 'Résultat : pas intéressé — prospection arrêtée'
      when 'meeting' then 'Résultat : rendez-vous obtenu'
      else 'Ne plus contacter' || coalesce(' : ' || nullif(btrim(p_note), ''), '') end,
    jsonb_build_object('campaign_id', cp.campaign_id, 'participant_id', cp.id, 'outcome', p_outcome));

  return jsonb_build_object('status', 'ok', 'stopped', v_stopped, 'moved', v_move is not null);
end;
$$;

create or replace function public.set_do_not_contact(p_company uuid, p_value boolean, p_reason text default null)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.companies
     set do_not_contact = p_value, do_not_contact_at = case when p_value then now() end,
         do_not_contact_reason = case when p_value then nullif(btrim(coalesce(p_reason, '')), '') end
   where id = p_company;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if p_value then
    update public.campaign_participants set status = 'arrete', next_due_date = null, stop_reason = 'Ne plus contacter'
     where company_id = p_company and status in ('a_preparer', 'a_contacter', 'en_cours', 'a_repondu');
  end if;
  perform public.log_event(p_company, 'prospecting', case when p_value then 'Marquée « Ne plus contacter »' else '« Ne plus contacter » retiré' end);
end;
$$;

-- reprise / report : versions compatibles avec les séquences versionnées
create or replace function public.update_participant(
  p_participant uuid, p_action text, p_due date default null, p_reason text default null)
returns jsonb
language plpgsql
as $$
declare cp public.campaign_participants;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;

  if p_action = 'postpone' then
    if p_due is null then raise exception 'Nouvelle date obligatoire' using errcode = '22023'; end if;
    if cp.status not in ('a_contacter','en_cours') then raise exception 'Seul un suivi actif peut être reporté' using errcode = '22023'; end if;
    update public.campaign_participants set next_due_date = p_due where id = cp.id;
  elsif p_action = 'resume' then
    if exists (select 1 from public.companies where id = cp.company_id and do_not_contact) then
      raise exception 'Fiche marquée « Ne plus contacter »' using errcode = '22023';
    end if;
    if not exists (select 1 from public.campaign_steps where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step) then
      raise exception 'Il ne reste aucune étape à réaliser' using errcode = '22023';
    end if;
    update public.campaign_participants
       set status = case when cp.last_done_at is null then 'a_contacter' else 'en_cours' end,
           next_due_date = coalesce(p_due, public.today_paris()), stop_reason = null
     where id = cp.id;
  elsif p_action = 'stop' then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null, stop_reason = coalesce(nullif(btrim(p_reason), ''), 'Arrêt manuel')
     where id = cp.id;
    perform public.log_event(cp.company_id, 'prospecting', 'Suivi de prospection arrêté : ' || coalesce(nullif(btrim(p_reason), ''), 'arrêt manuel'),
      jsonb_build_object('campaign_id', cp.campaign_id));
  elsif p_action = 'finish' then
    update public.campaign_participants set status = 'termine', next_due_date = null where id = cp.id;
  elsif p_action = 'unprepare' then
    if cp.status <> 'a_preparer' then raise exception 'Seul un participant à préparer peut être retiré' using errcode = '22023'; end if;
    delete from public.campaign_participants where id = cp.id;
  elsif p_action = 'set_person' then
    if p_reason is not null and not exists (select 1 from public.people where id = p_reason::uuid and company_id = cp.company_id) then
      raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
    end if;
    update public.campaign_participants set person_id = p_reason::uuid where id = cp.id;
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- Vues : file de travail et synthèse des campagnes
-- ---------------------------------------------------------------------------

create or replace view public.todo_items with (security_invoker = true) as
  select 'task'::text as item_type, t.id, t.company_id, c.name as company_name, t.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as person_name,
         t.title, t.due_date, null::uuid as campaign_id, null::text as campaign_name, null::text as channel,
         null::int as step_position, null::text as step_message,
         null::text as step_type, null::text as step_subject, null::text as step_instructions, null::int as sequence_version,
         null::int as step_count
    from public.tasks t
    join public.companies c on c.id = t.company_id
    left join public.people p on p.id = t.person_id
   where t.done_at is null and c.merged_into_id is null and c.archived_at is null
  union all
  select 'followup', cp.id, cp.company_id, c.name, cp.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         cs.name, cp.next_due_date, ca.id, ca.name, cs.channel, cs.position, cs.message,
         cs.step_type, cs.subject, cs.instructions, cp.sequence_version,
         (select count(*)::int from public.campaign_steps x where x.campaign_id = ca.id and x.version = cp.sequence_version)
    from public.campaign_participants cp
    join public.campaigns ca on ca.id = cp.campaign_id and ca.status = 'active'
    join public.companies c on c.id = cp.company_id
    join public.campaign_steps cs on cs.campaign_id = cp.campaign_id and cs.version = cp.sequence_version and cs.position = cp.current_step
    left join public.people p on p.id = cp.person_id
   where cp.status in ('a_contacter','en_cours') and cp.next_due_date is not null
     and c.merged_into_id is null and c.archived_at is null and not c.do_not_contact;

-- Synthèse par campagne, calculée uniquement à partir des événements enregistrés.
-- Une entreprise est comptée une seule fois par campagne (une participation par entreprise).
create or replace view public.campaign_overview with (security_invoker = true) as
  select ca.id, ca.name, ca.status, ca.current_version, ca.template_name, ca.created_at, ca.updated_at,
         coalesce((select array_agg(distinct s.channel) from public.campaign_steps s
                    where s.campaign_id = ca.id and s.version = ca.current_version), '{}') as channels,
         (select count(*) from public.campaign_steps s where s.campaign_id = ca.id and s.version = ca.current_version)::int as step_count,
         count(cp.id)::int as enrolled,
         count(*) filter (where cp.status = 'a_preparer')::int as to_prepare,
         count(*) filter (where cp.status in ('a_contacter','en_cours'))::int as in_progress,
         count(*) filter (where cp.status in ('a_contacter','en_cours') and cp.next_due_date = public.today_paris())::int as due_today,
         count(*) filter (where cp.status in ('a_contacter','en_cours') and cp.next_due_date < public.today_paris())::int as overdue,
         count(*) filter (where cp.last_done_at is not null or exists (
           select 1 from public.interactions i where i.campaign_participant_id = cp.id and i.kind in ('message_out','call')))::int as contacted,
         count(*) filter (where cp.outcome <> 'none' or cp.status = 'a_repondu' or exists (
           select 1 from public.interactions i where i.campaign_participant_id = cp.id and i.kind = 'message_in'))::int as replied,
         count(*) filter (where cp.outcome in ('interested','meeting'))::int as interested,
         count(*) filter (where cp.outcome = 'meeting')::int as meetings,
         count(*) filter (where cp.outcome in ('not_interested','do_not_contact'))::int as not_interested,
         count(*) filter (where cp.moved_to_pipeline_at is not null)::int as moved_to_pipeline,
         count(*) filter (where cp.status = 'termine')::int as finished,
         count(*) filter (where cp.status = 'arrete')::int as stopped,
         greatest(ca.updated_at, (select max(i.created_at) from public.interactions i
                                   join public.campaign_participants x on x.id = i.campaign_participant_id
                                  where x.campaign_id = ca.id)) as last_activity_at
    from public.campaigns ca
    left join public.campaign_participants cp on cp.campaign_id = ca.id
   group by ca.id;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.todo_items, public.company_overview, public.campaign_overview from anon;
grant select on public.todo_items, public.company_overview, public.campaign_overview to authenticated;

-- ---------------------------------------------------------------------------
-- Fonctions v1 mises à jour pour les nouvelles colonnes
-- ---------------------------------------------------------------------------

create or replace function public.create_campaign(p_name text, p_template uuid, p_list_ids uuid[] default '{}')
returns jsonb
language plpgsql
as $$
declare v_id uuid; v_res jsonb := '{}';
begin
  perform public.assert_owner();
  if not exists (select 1 from public.template_steps where template_id = p_template) then
    raise exception 'Le modèle ne contient aucune étape' using errcode = '22023';
  end if;
  v_id := public.create_campaign_draft(p_name, p_template);
  update public.campaigns set status = 'active' where id = v_id;
  if cardinality(p_list_ids) > 0 then
    v_res := public.add_lists_to_campaign(v_id, p_list_ids);
  end if;
  return jsonb_build_object('id', v_id) || v_res;
end;
$$;

create or replace function public.duplicate_template(p_id uuid)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  insert into public.templates (name) select name || ' (copie)' from public.templates where id = p_id returning id into v_id;
  if v_id is null then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
  insert into public.template_steps (template_id, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, position, name, step_type, channel, delay_days, subject, message, instructions
    from public.template_steps where template_id = p_id;
  return v_id;
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;


-- ===== 20261101000100_finance.sql =====
-- Module Finance : missions, factures (émises ailleurs, seulement enregistrées), paiements,
-- charges et abonnements, périodes URSSAF, réglages datés.
-- Migration additive : aucune table existante n'est modifiée ni vidée. Les clients sont les
-- fiches CRM (companies) : aucune seconde base clients.
-- Montants : numeric(12,2) en euros. Les calculs d'agrégats sont faits en centimes entiers
-- côté TypeScript (src/lib/finance/*).

-- ---------------------------------------------------------------------------
-- Réglages (versions datées : l'historique n'est jamais réécrit)
-- ---------------------------------------------------------------------------

create table public.finance_settings (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null unique,
  -- micro_bnc_ssi : micro-entrepreneur, BNC, régime général de la Sécurité sociale (SSI)
  -- micro_bnc_cipav, micro_bic_services, micro_bic_vente : taux à saisir par l'utilisateur
  -- manual : autre statut (EI au réel, SASU, EURL…) → suivi manuel, aucun calcul
  regime text not null default 'micro_bnc_ssi'
    check (regime in ('micro_bnc_ssi','micro_bnc_cipav','micro_bic_services','micro_bic_vente','manual')),
  periodicity text not null default 'monthly' check (periodicity in ('monthly','quarterly')),
  acre boolean not null default false,
  versement_liberatoire boolean not null default false,
  vat_enabled boolean not null default false,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now()
);

-- Taux en pourcentage (25.600 = 25,6 %), avec date d'effet et source.
create table public.finance_rates (
  id uuid primary key default gen_random_uuid(),
  regime text not null check (regime in ('micro_bnc_ssi','micro_bnc_cipav','micro_bic_services','micro_bic_vente')),
  kind text not null check (kind in ('social','cfp')),
  rate numeric(6,3) not null check (rate >= 0 and rate < 100),
  effective_from date not null,
  origin text not null default 'user' check (origin in ('official','user')),
  source_url text check (source_url is null or char_length(source_url) <= 500),
  verified_on date,
  note text check (note is null or char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  unique (regime, kind, effective_from)
);

-- Solde de trésorerie d'ouverture (facultatif) : une seule ligne.
create table public.finance_opening_balance (
  id boolean primary key default true check (id),
  amount numeric(12,2) not null,
  as_of date not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Missions (rattachées à une fiche CRM). Un deal gagné n'implique aucun encaissement.
-- ---------------------------------------------------------------------------

create table public.finance_missions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  label text not null check (char_length(btrim(label)) between 1 and 200),
  status text not null default 'actif' check (status in ('a_demarrer','actif','en_pause','termine')),
  kind text not null default 'ponctuel' check (kind in ('ponctuel','recurrent')),
  start_date date,
  end_date date,
  amount numeric(12,2) check (amount is null or amount >= 0),          -- HT ; null = inconnu
  frequency text check (frequency is null or frequency in ('mensuel','trimestriel','annuel')),
  next_due_date date,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'ponctuel' or frequency is not null),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index finance_missions_company on public.finance_missions (company_id);

-- ---------------------------------------------------------------------------
-- Factures et avoirs (émis dans un autre outil, enregistrés ici)
-- ---------------------------------------------------------------------------

create table public.finance_invoices (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'facture' check (kind in ('facture','avoir')),
  company_id uuid not null references public.companies (id) on delete restrict,
  mission_id uuid references public.finance_missions (id) on delete set null,
  credited_invoice_id uuid references public.finance_invoices (id) on delete restrict,
  reference text check (reference is null or char_length(reference) <= 100),
  issue_date date not null,
  due_date date,
  amount_ht numeric(12,2) not null check (amount_ht > 0),
  vat_rate numeric(5,2) check (vat_rate is null or (vat_rate >= 0 and vat_rate <= 100)),
  vat_amount numeric(12,2) check (vat_amount is null or vat_amount >= 0),
  amount_ttc numeric(12,2) not null check (amount_ttc > 0),
  forecast_due_date date,             -- échéance de mission que cette facture couvre
  note text check (note is null or char_length(note) <= 2000),
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (amount_ttc >= amount_ht),
  check (kind = 'facture' or credited_invoice_id is not null),
  check (kind = 'avoir' or credited_invoice_id is null),
  check (due_date is null or due_date >= issue_date)
);
create index finance_invoices_company on public.finance_invoices (company_id);
create index finance_invoices_mission on public.finance_invoices (mission_id);
create index finance_invoices_credited on public.finance_invoices (credited_invoice_id);

-- Paiements reçus (et remboursements versés au client). Jamais supprimés : annulés.
create table public.finance_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.finance_invoices (id) on delete restrict,
  kind text not null default 'paiement' check (kind in ('paiement','remboursement')),
  paid_on date not null,
  amount numeric(12,2) not null check (amount > 0),
  note text check (note is null or char_length(note) <= 1000),
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index finance_payments_invoice on public.finance_payments (invoice_id);

-- ---------------------------------------------------------------------------
-- Charges
-- ---------------------------------------------------------------------------

create table public.finance_expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 1 and 80),
  position int not null default 0,
  -- traitement dans le calculateur d'EBITDA indicatif
  ebitda_included boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.finance_expense_categories (name, position, ebitda_included) values
  ('Logiciels et abonnements', 1, true),
  ('Hébergement et infrastructure', 2, true),
  ('Sous-traitance', 3, true),
  ('Marketing', 4, true),
  ('Banque et assurance', 5, true),
  ('Matériel', 6, true),
  ('Déplacements', 7, true),
  ('Cotisations sociales', 8, true),
  ('Autres', 9, true);

-- Abonnements et charges récurrentes : des modèles, jamais comptés eux-mêmes.
-- Leurs échéances sont des lignes de finance_expenses (subscription_id renseigné).
create table public.finance_subscriptions (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  supplier text check (supplier is null or char_length(supplier) <= 200),
  category_id uuid references public.finance_expense_categories (id) on delete set null,
  amount numeric(12,2) check (amount is null or amount >= 0),    -- montant payé à chaque échéance (TTC)
  amount_ht numeric(12,2) check (amount_ht is null or amount_ht >= 0),
  frequency text not null default 'mensuel' check (frequency in ('mensuel','trimestriel','annuel')),
  start_date date not null,
  next_due_date date not null,
  renewal_date date,
  end_date date,                                                   -- résiliation : plus d'échéance après
  status text not null default 'actif' check (status in ('actif','resilie')),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.finance_expenses (
  id uuid primary key default gen_random_uuid(),
  label text not null check (char_length(btrim(label)) between 1 and 200),
  supplier text check (supplier is null or char_length(supplier) <= 200),
  category_id uuid references public.finance_expense_categories (id) on delete set null,
  amount numeric(12,2) check (amount is null or amount >= 0),      -- TTC (montant décaissé) ; null = inconnu
  amount_ht numeric(12,2) check (amount_ht is null or amount_ht >= 0),
  vat_amount numeric(12,2) check (vat_amount is null or vat_amount >= 0),
  planned_date date not null,
  paid_on date,
  status text not null default 'a_payer' check (status in ('a_payer','paye','annule')),
  subscription_id uuid references public.finance_subscriptions (id) on delete restrict,
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'paye') = (paid_on is not null)),
  check (status <> 'paye' or amount is not null),
  unique (subscription_id, planned_date)
);
create index finance_expenses_planned on public.finance_expenses (planned_date);

-- ---------------------------------------------------------------------------
-- Périodes URSSAF : trois suivis distincts (estimé / déclaré / payé)
-- ---------------------------------------------------------------------------

create table public.finance_urssaf_periods (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  deadline date,
  deadline_origin text check (deadline_origin is null or deadline_origin in ('regle_officielle','saisie')),
  -- déclaration : valeurs saisies par l'utilisateur, figées (jamais recalculées)
  declared_on date,
  declared_base numeric(12,2) check (declared_base is null or declared_base >= 0),
  declared_amount numeric(12,2) check (declared_amount is null or declared_amount >= 0),
  -- estimation de l'application au moment de la déclaration (historique des écarts)
  estimate_base_at_declaration numeric(12,2),
  estimate_amount_at_declaration numeric(12,2),
  estimate_rate_at_declaration numeric(6,3),
  -- paiement
  paid_on date,
  paid_amount numeric(12,2) check (paid_amount is null or paid_amount >= 0),
  reference text check (reference is null or char_length(reference) <= 100),
  note text check (note is null or char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_start, period_end),
  check (period_end >= period_start),
  check ((declared_on is null) = (declared_amount is null)),
  check (declared_on is not null or paid_on is null),
  check ((paid_on is null) = (paid_amount is null))
);

-- ---------------------------------------------------------------------------
-- Dates de modification, RLS (mêmes protections que le reste du CRM)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['finance_missions','finance_invoices','finance_subscriptions','finance_expenses','finance_urssaf_periods']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
  end loop;
  foreach t in array array[
    'finance_settings','finance_rates','finance_opening_balance','finance_missions','finance_invoices','finance_payments',
    'finance_expense_categories','finance_subscriptions','finance_expenses','finance_urssaf_periods']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- Factures et paiements ne se suppriment pas : on les annule (les totaux restent justes).
drop policy owner_delete on public.finance_invoices;
drop policy owner_delete on public.finance_payments;
drop policy owner_delete on public.finance_urssaf_periods;

-- ---------------------------------------------------------------------------
-- Réglages et taux initiaux (vérifiés le 2026-10-30)
-- ---------------------------------------------------------------------------

-- Réglage confirmé par l'utilisateur le 2026-10-30 : micro-entrepreneur BNC, déclaration
-- mensuelle, sans ACRE ni versement libératoire, sans TVA (franchise en base par défaut).
insert into public.finance_settings (effective_from, regime, periodicity, acre, versement_liberatoire, vat_enabled, note)
values ('2024-01-01', 'micro_bnc_ssi', 'monthly', false, false, false,
        'Réglage initial : micro-entrepreneur BNC (régime général), déclaration mensuelle, sans ACRE ni versement libératoire.');

-- Taux officiels. Sources consultées le 2026-10-30 :
--  https://www.urssaf.fr/accueil/actualites/taux-cotisations-autoentrepeneur.html
--  https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/lessentiel-du-statut.html
--  https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/incident---declarations-des-auto.html
--  (BNC régime général : 24,6 % du 1er janvier au 31 décembre 2025, 25,6 % à partir du 1er janvier 2026 ;
--   contribution à la formation professionnelle des professions libérales : 0,2 %.)
-- Aucun taux n'est encodé pour les autres régimes : l'utilisateur les saisit avec sa source.
insert into public.finance_rates (regime, kind, rate, effective_from, origin, source_url, verified_on, note) values
  ('micro_bnc_ssi', 'social', 24.600, '2025-01-01', 'official',
   'https://www.urssaf.fr/accueil/actualites/taux-cotisations-autoentrepeneur.html', '2026-10-30',
   'Taux global BNC régime général du 1er janvier au 31 décembre 2025'),
  ('micro_bnc_ssi', 'social', 25.600, '2026-01-01', 'official',
   'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/toutes-les-actualites/incident---declarations-des-auto.html', '2026-10-30',
   'Taux global BNC régime général à partir du 1er janvier 2026 (24,6 % → 25,6 %)'),
  ('micro_bnc_ssi', 'cfp', 0.200, '2025-01-01', 'official',
   'https://www.autoentrepreneur.urssaf.fr/portail/accueil/sinformer-sur-le-statut/lessentiel-du-statut.html', '2026-10-30',
   'Contribution à la formation professionnelle, professions libérales');

-- ---------------------------------------------------------------------------
-- Fusion de fiches CRM : missions et factures suivent la fiche conservée
-- ---------------------------------------------------------------------------

create or replace function public.tg_finance_follow_merge()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.finance_missions set company_id = new.merged_into_id where company_id = new.id;
    update public.finance_invoices set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger finance_follow_merge after update of merged_into_id on public.companies
  for each row execute function public.tg_finance_follow_merge();

-- ---------------------------------------------------------------------------
-- Utilitaires
-- ---------------------------------------------------------------------------

create or replace function public.finance_add_frequency(p_date date, p_frequency text, p_steps int default 1)
returns date
language sql
immutable
as $$
  select (p_date + (case p_frequency when 'mensuel' then 1 when 'trimestriel' then 3 when 'annuel' then 12 end * p_steps)
                    * interval '1 month')::date;
$$;

create or replace function public.finance_txt(p jsonb, k text)
returns text
language sql
immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), ''); $$;

create or replace function public.finance_num(p jsonb, k text)
returns numeric
language sql
immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), '')::numeric(12,2); $$;

create or replace function public.finance_date(p jsonb, k text)
returns date
language sql
immutable
as $$ select nullif(btrim(coalesce(p ->> k, '')), '')::date; $$;

-- ---------------------------------------------------------------------------
-- Missions
-- ---------------------------------------------------------------------------

create or replace function public.finance_save_mission(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid; v_company uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_company := nullif(p_data ->> 'company_id', '')::uuid;
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  if p_id is null then
    insert into public.finance_missions (company_id, label, status, kind, start_date, end_date, amount, frequency, next_due_date, note)
    values (v_company, btrim(p_data ->> 'label'), coalesce(public.finance_txt(p_data, 'status'), 'actif'),
            coalesce(public.finance_txt(p_data, 'kind'), 'ponctuel'), public.finance_date(p_data, 'start_date'),
            public.finance_date(p_data, 'end_date'), public.finance_num(p_data, 'amount'),
            public.finance_txt(p_data, 'frequency'), public.finance_date(p_data, 'next_due_date'), public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    update public.finance_missions set
      company_id = v_company, label = btrim(p_data ->> 'label'), status = coalesce(public.finance_txt(p_data, 'status'), status),
      kind = coalesce(public.finance_txt(p_data, 'kind'), kind), start_date = public.finance_date(p_data, 'start_date'),
      end_date = public.finance_date(p_data, 'end_date'), amount = public.finance_num(p_data, 'amount'),
      frequency = public.finance_txt(p_data, 'frequency'), next_due_date = public.finance_date(p_data, 'next_due_date'),
      note = public.finance_txt(p_data, 'note')
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Mission introuvable' using errcode = 'P0002'; end if;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_mission', jsonb_build_object('id', v_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Factures, avoirs, paiements
-- ---------------------------------------------------------------------------

-- Enregistre une facture émise ailleurs. Si elle couvre l'échéance d'une mission récurrente,
-- l'échéance suivante de la mission est avancée (prévision seulement, aucun encaissement fictif).
create or replace function public.finance_record_invoice(p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb; v_id uuid; v_company uuid; v_mission uuid; v_m public.finance_missions;
  v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2); v_cover date;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_company := nullif(p_data ->> 'company_id', '')::uuid;
  v_mission := nullif(p_data ->> 'mission_id', '')::uuid;
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche client introuvable' using errcode = 'P0002';
  end if;
  if v_mission is not null then
    select * into v_m from public.finance_missions where id = v_mission;
    if v_m.id is null or v_m.company_id <> v_company then
      raise exception 'La mission ne correspond pas à ce client' using errcode = '22023';
    end if;
  end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  if v_ht is null or v_ht <= 0 then raise exception 'Le montant HT doit être positif' using errcode = '22023'; end if;
  if v_vat is not null and v_ttc <> v_ht + v_vat then
    raise exception 'HT + TVA ne correspond pas au TTC' using errcode = '22023';
  end if;
  v_cover := public.finance_date(p_data, 'forecast_due_date');

  insert into public.finance_invoices (company_id, mission_id, reference, issue_date, due_date, amount_ht, vat_rate, vat_amount,
                                       amount_ttc, forecast_due_date, note)
  values (v_company, v_mission, public.finance_txt(p_data, 'reference'), public.finance_date(p_data, 'issue_date'),
          public.finance_date(p_data, 'due_date'), v_ht, nullif(p_data ->> 'vat_rate', '')::numeric(5,2), v_vat, v_ttc,
          v_cover, public.finance_txt(p_data, 'note'))
  returning id into v_id;

  if v_cover is not null and v_m.id is not null and v_m.kind = 'recurrent' and v_m.next_due_date = v_cover then
    update public.finance_missions set next_due_date = public.finance_add_frequency(v_cover, v_m.frequency) where id = v_m.id;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_record_invoice', jsonb_build_object('id', v_id));
end;
$$;

-- Corrige les informations d'une facture (montants compris) tant qu'aucun paiement ne la dépasse.
create or replace function public.finance_update_invoice(p_id uuid, p_data jsonb)
returns jsonb
language plpgsql
as $$
declare v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2); v_paid numeric(12,2);
begin
  perform public.assert_owner();
  perform 1 from public.finance_invoices where id = p_id for update;
  if not found then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  if v_vat is not null and v_ttc <> v_ht + v_vat then
    raise exception 'HT + TVA ne correspond pas au TTC' using errcode = '22023';
  end if;
  select paid_net into v_paid from public.finance_invoice_overview where id = p_id;
  if v_ttc < coalesce(v_paid, 0) then
    raise exception 'Le montant TTC serait inférieur aux paiements déjà reçus' using errcode = '22023';
  end if;
  update public.finance_invoices set
    reference = public.finance_txt(p_data, 'reference'), issue_date = public.finance_date(p_data, 'issue_date'),
    due_date = public.finance_date(p_data, 'due_date'), amount_ht = v_ht, vat_rate = nullif(p_data ->> 'vat_rate', '')::numeric(5,2),
    vat_amount = v_vat, amount_ttc = v_ttc, note = public.finance_txt(p_data, 'note'),
    mission_id = nullif(p_data ->> 'mission_id', '')::uuid
  where id = p_id;
  return jsonb_build_object('id', p_id);
end;
$$;

create or replace function public.finance_cancel_invoice(p_id uuid, p_reason text)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  if exists (select 1 from public.finance_payments where invoice_id = p_id and cancelled_at is null) then
    raise exception 'Cette facture a des paiements : enregistrez plutôt un avoir ou un remboursement' using errcode = '22023';
  end if;
  update public.finance_invoices set cancelled_at = coalesce(cancelled_at, now()), cancel_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_id;
  if not found then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id);
end;
$$;

-- Avoir : réduit ce que le client doit sans effacer la facture d'origine.
create or replace function public.finance_record_credit_note(p_invoice uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_inv public.finance_invoices; v_ht numeric(12,2); v_vat numeric(12,2); v_ttc numeric(12,2);
        v_credited numeric(12,2); v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_inv from public.finance_invoices where id = p_invoice for update;
  if v_inv.id is null or v_inv.kind <> 'facture' then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  if v_inv.cancelled_at is not null then raise exception 'Facture annulée' using errcode = '22023'; end if;
  v_ht := public.finance_num(p_data, 'amount_ht');
  v_vat := public.finance_num(p_data, 'vat_amount');
  v_ttc := coalesce(public.finance_num(p_data, 'amount_ttc'), v_ht + coalesce(v_vat, 0));
  select coalesce(sum(amount_ttc), 0) into v_credited from public.finance_invoices
   where credited_invoice_id = p_invoice and cancelled_at is null;
  if v_ttc + v_credited > v_inv.amount_ttc then
    raise exception 'Le total des avoirs dépasserait le montant de la facture' using errcode = '22023';
  end if;
  insert into public.finance_invoices (kind, company_id, mission_id, credited_invoice_id, reference, issue_date, amount_ht, vat_amount, amount_ttc, note)
  values ('avoir', v_inv.company_id, v_inv.mission_id, v_inv.id, public.finance_txt(p_data, 'reference'),
          coalesce(public.finance_date(p_data, 'issue_date'), public.today_paris()), v_ht, v_vat, v_ttc, public.finance_txt(p_data, 'note'))
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'finance_record_credit_note', jsonb_build_object('id', v_id));
end;
$$;

-- Paiement reçu (ou remboursement versé). La clé d'idempotence empêche le double paiement
-- en cas de double clic ; le verrou sur la facture empêche deux paiements simultanés de
-- dépasser le reste dû.
create or replace function public.finance_record_payment(
  p_invoice uuid, p_paid_on date, p_amount numeric, p_kind text default 'paiement', p_note text default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_inv public.finance_invoices; v_o record; v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_inv from public.finance_invoices where id = p_invoice for update;
  if v_inv.id is null or v_inv.kind <> 'facture' then raise exception 'Facture introuvable' using errcode = 'P0002'; end if;
  if v_inv.cancelled_at is not null then raise exception 'Facture annulée : paiement impossible' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Le montant doit être positif' using errcode = '22023'; end if;
  if p_paid_on is null then raise exception 'La date est obligatoire' using errcode = '22023'; end if;
  select * into v_o from public.finance_invoice_overview where id = p_invoice;
  if coalesce(p_kind, 'paiement') = 'paiement' and p_amount > v_o.balance then
    raise exception 'Le paiement (% €) dépasse le reste à encaisser (% €)', p_amount, v_o.balance using errcode = '22023';
  end if;
  if p_kind = 'remboursement' and p_amount > v_o.paid_net then
    raise exception 'Le remboursement dépasse les paiements reçus' using errcode = '22023';
  end if;
  insert into public.finance_payments (invoice_id, kind, paid_on, amount, note)
  values (p_invoice, coalesce(p_kind, 'paiement'), p_paid_on, p_amount, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'finance_record_payment', jsonb_build_object('id', v_id));
end;
$$;

create or replace function public.finance_cancel_payment(p_id uuid)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.finance_payments set cancelled_at = coalesce(cancelled_at, now()) where id = p_id;
  if not found then raise exception 'Paiement introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Charges et abonnements
-- ---------------------------------------------------------------------------

create or replace function public.finance_save_expense(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid; v_status text; v_paid date;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  v_status := coalesce(public.finance_txt(p_data, 'status'), 'a_payer');
  v_paid := case when v_status = 'paye' then coalesce(public.finance_date(p_data, 'paid_on'), public.finance_date(p_data, 'planned_date')) end;
  if v_status = 'paye' and public.finance_num(p_data, 'amount') is null then
    raise exception 'Indiquez le montant payé' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.finance_expenses (label, supplier, category_id, amount, amount_ht, vat_amount, planned_date, paid_on, status, note)
    values (btrim(p_data ->> 'label'), public.finance_txt(p_data, 'supplier'), nullif(p_data ->> 'category_id', '')::uuid,
            public.finance_num(p_data, 'amount'), public.finance_num(p_data, 'amount_ht'), public.finance_num(p_data, 'vat_amount'),
            public.finance_date(p_data, 'planned_date'), v_paid, v_status, public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    update public.finance_expenses set
      label = btrim(p_data ->> 'label'), supplier = public.finance_txt(p_data, 'supplier'),
      category_id = nullif(p_data ->> 'category_id', '')::uuid, amount = public.finance_num(p_data, 'amount'),
      amount_ht = public.finance_num(p_data, 'amount_ht'), vat_amount = public.finance_num(p_data, 'vat_amount'),
      planned_date = public.finance_date(p_data, 'planned_date'), paid_on = v_paid, status = v_status,
      note = public.finance_txt(p_data, 'note')
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Charge introuvable' using errcode = 'P0002'; end if;
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_expense', jsonb_build_object('id', v_id));
end;
$$;

-- Valide le paiement d'une charge (seule une charge validée compte comme payée).
create or replace function public.finance_pay_expense(p_id uuid, p_paid_on date, p_amount numeric default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_e public.finance_expenses;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into v_e from public.finance_expenses where id = p_id for update;
  if v_e.id is null then raise exception 'Charge introuvable' using errcode = 'P0002'; end if;
  if v_e.status = 'annule' then raise exception 'Charge annulée' using errcode = '22023'; end if;
  if coalesce(p_amount, v_e.amount) is null then raise exception 'Indiquez le montant payé' using errcode = '22023'; end if;
  update public.finance_expenses
     set status = 'paye', paid_on = coalesce(p_paid_on, public.today_paris()), amount = coalesce(p_amount, amount)
   where id = p_id;
  return public.idem_put(p_idempotency_key, 'finance_pay_expense', jsonb_build_object('id', p_id));
end;
$$;

create or replace function public.finance_set_expense_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  if p_status not in ('a_payer','annule') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  update public.finance_expenses set status = p_status, paid_on = null where id = p_id;
  if not found then raise exception 'Charge introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', p_id);
end;
$$;

create or replace function public.finance_save_subscription(p_id uuid, p_data jsonb, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_id is null then
    insert into public.finance_subscriptions (label, supplier, category_id, amount, amount_ht, frequency, start_date, next_due_date,
                                              renewal_date, end_date, status, note)
    values (btrim(p_data ->> 'label'), public.finance_txt(p_data, 'supplier'), nullif(p_data ->> 'category_id', '')::uuid,
            public.finance_num(p_data, 'amount'), public.finance_num(p_data, 'amount_ht'),
            coalesce(public.finance_txt(p_data, 'frequency'), 'mensuel'),
            coalesce(public.finance_date(p_data, 'start_date'), public.finance_date(p_data, 'next_due_date')),
            coalesce(public.finance_date(p_data, 'next_due_date'), public.finance_date(p_data, 'start_date')),
            public.finance_date(p_data, 'renewal_date'), public.finance_date(p_data, 'end_date'),
            coalesce(public.finance_txt(p_data, 'status'), 'actif'), public.finance_txt(p_data, 'note'))
    returning id into v_id;
  else
    update public.finance_subscriptions set
      label = btrim(p_data ->> 'label'), supplier = public.finance_txt(p_data, 'supplier'),
      category_id = nullif(p_data ->> 'category_id', '')::uuid, amount = public.finance_num(p_data, 'amount'),
      amount_ht = public.finance_num(p_data, 'amount_ht'), frequency = coalesce(public.finance_txt(p_data, 'frequency'), frequency),
      next_due_date = coalesce(public.finance_date(p_data, 'next_due_date'), next_due_date),
      renewal_date = public.finance_date(p_data, 'renewal_date'), end_date = public.finance_date(p_data, 'end_date'),
      status = coalesce(public.finance_txt(p_data, 'status'), status), note = public.finance_txt(p_data, 'note')
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'Abonnement introuvable' using errcode = 'P0002'; end if;
  end if;
  if (select start_date is null or next_due_date is null from public.finance_subscriptions where id = v_id) then
    raise exception 'Indiquez la prochaine échéance' using errcode = '22023';
  end if;
  return public.idem_put(p_idempotency_key, 'finance_save_subscription', jsonb_build_object('id', v_id));
end;
$$;

-- Crée les échéances (charges « à payer ») des abonnements jusqu'à p_until inclus.
-- Idempotent : une échéance par abonnement et par date (contrainte unique). Les échéances
-- ne sont comptées comme payées qu'après validation (finance_pay_expense).
create or replace function public.finance_generate_occurrences(p_until date)
returns int
language plpgsql
as $$
declare s public.finance_subscriptions; v_date date; v_n int := 0; v_guard int;
begin
  perform public.assert_owner();
  for s in select * from public.finance_subscriptions where status = 'actif' order by id for update
  loop
    v_date := s.next_due_date;
    v_guard := 0;
    while v_date <= p_until and (s.end_date is null or v_date <= s.end_date) and v_guard < 400 loop
      insert into public.finance_expenses (label, supplier, category_id, amount, amount_ht, planned_date, status, subscription_id)
      values (s.label, s.supplier, s.category_id, s.amount, s.amount_ht, v_date, 'a_payer', s.id)
      on conflict (subscription_id, planned_date) do nothing;
      if found then v_n := v_n + 1; end if;
      v_date := public.finance_add_frequency(v_date, s.frequency);
      v_guard := v_guard + 1;
    end loop;
    if v_date <> s.next_due_date then
      update public.finance_subscriptions set next_due_date = v_date where id = s.id;
    end if;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- URSSAF : déclaration et paiement (aucune télétransmission, aucun paiement réel)
-- ---------------------------------------------------------------------------

create or replace function public.finance_urssaf_declare(
  p_start date, p_end date, p_declared_on date, p_base numeric, p_amount numeric,
  p_estimate jsonb default '{}', p_deadline date default null, p_deadline_origin text default null,
  p_reference text default null, p_note text default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb; v_id uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_declared_on is null or p_amount is null then
    raise exception 'Indiquez la date et le montant déclaré' using errcode = '22023';
  end if;
  insert into public.finance_urssaf_periods as u (period_start, period_end, deadline, deadline_origin, declared_on, declared_base, declared_amount,
      estimate_base_at_declaration, estimate_amount_at_declaration, estimate_rate_at_declaration, reference, note)
  values (p_start, p_end, p_deadline, p_deadline_origin, p_declared_on, p_base, p_amount,
          public.finance_num(p_estimate, 'base'), public.finance_num(p_estimate, 'amount'),
          nullif(p_estimate ->> 'rate', '')::numeric(6,3), nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(p_note, '')), ''))
  on conflict (period_start, period_end) do update set
    declared_on = excluded.declared_on, declared_base = excluded.declared_base, declared_amount = excluded.declared_amount,
    estimate_base_at_declaration = excluded.estimate_base_at_declaration,
    estimate_amount_at_declaration = excluded.estimate_amount_at_declaration,
    estimate_rate_at_declaration = excluded.estimate_rate_at_declaration,
    deadline = coalesce(excluded.deadline, u.deadline), deadline_origin = coalesce(excluded.deadline_origin, u.deadline_origin),
    reference = coalesce(excluded.reference, u.reference), note = coalesce(excluded.note, u.note)
  returning id into v_id;
  return public.idem_put(p_idempotency_key, 'finance_urssaf_declare', jsonb_build_object('id', v_id));
end;
$$;

create or replace function public.finance_urssaf_pay(p_id uuid, p_paid_on date, p_amount numeric, p_reference text default null,
                                                     p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare v_prev jsonb;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_paid_on is null or p_amount is null then raise exception 'Indiquez la date et le montant payé' using errcode = '22023'; end if;
  update public.finance_urssaf_periods
     set paid_on = p_paid_on, paid_amount = p_amount, reference = coalesce(nullif(btrim(coalesce(p_reference, '')), ''), reference)
   where id = p_id and declared_on is not null;
  if not found then raise exception 'Période non déclarée : enregistrez d''abord la déclaration' using errcode = '22023'; end if;
  return public.idem_put(p_idempotency_key, 'finance_urssaf_pay', jsonb_build_object('id', p_id));
end;
$$;

-- Échéance saisie à la main (lorsque la règle officielle ne s'applique pas ou diffère).
create or replace function public.finance_urssaf_set_deadline(p_start date, p_end date, p_deadline date)
returns jsonb
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  insert into public.finance_urssaf_periods as u (period_start, period_end, deadline, deadline_origin)
  values (p_start, p_end, p_deadline, case when p_deadline is null then null else 'saisie' end)
  on conflict (period_start, period_end) do update
    set deadline = excluded.deadline, deadline_origin = excluded.deadline_origin
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- Corrige une erreur de saisie (retire le paiement ou la déclaration). L'utilisateur peut
-- ensuite ressaisir les bons chiffres ; les calculs de l'application ne réécrivent jamais rien.
create or replace function public.finance_urssaf_reset(p_id uuid, p_what text)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  if p_what = 'payment' then
    update public.finance_urssaf_periods set paid_on = null, paid_amount = null where id = p_id;
  elsif p_what = 'declaration' then
    update public.finance_urssaf_periods
       set paid_on = null, paid_amount = null, declared_on = null, declared_base = null, declared_amount = null,
           estimate_base_at_declaration = null, estimate_amount_at_declaration = null, estimate_rate_at_declaration = null
     where id = p_id;
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return jsonb_build_object('id', p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Réglages
-- ---------------------------------------------------------------------------

create or replace function public.finance_save_settings(p_data jsonb)
returns jsonb
language plpgsql
as $$
declare v_id uuid; v_from date;
begin
  perform public.assert_owner();
  v_from := coalesce(public.finance_date(p_data, 'effective_from'), public.today_paris());
  insert into public.finance_settings as s (effective_from, regime, periodicity, acre, versement_liberatoire, vat_enabled, note)
  values (v_from, p_data ->> 'regime', coalesce(p_data ->> 'periodicity', 'monthly'),
          coalesce((p_data ->> 'acre')::boolean, false), coalesce((p_data ->> 'versement_liberatoire')::boolean, false),
          coalesce((p_data ->> 'vat_enabled')::boolean, false), public.finance_txt(p_data, 'note'))
  on conflict (effective_from) do update set
    regime = excluded.regime, periodicity = excluded.periodicity, acre = excluded.acre,
    versement_liberatoire = excluded.versement_liberatoire, vat_enabled = excluded.vat_enabled, note = excluded.note
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Vues de lecture (security invoker : RLS des tables sous-jacentes)
-- ---------------------------------------------------------------------------

-- Une ligne par facture : payé, avoirs, reste dû et statut calculé.
create or replace view public.finance_invoice_overview with (security_invoker = true) as
  select i.*,
         c.name as company_name,
         m.label as mission_label,
         coalesce(p.paid, 0)::numeric(12,2) as paid,
         coalesce(p.refunded, 0)::numeric(12,2) as refunded,
         (coalesce(p.paid, 0) - coalesce(p.refunded, 0))::numeric(12,2) as paid_net,
         coalesce(cr.credited, 0)::numeric(12,2) as credited,
         case when i.kind = 'avoir' or i.cancelled_at is not null then 0
              else greatest(i.amount_ttc - coalesce(cr.credited, 0) - (coalesce(p.paid, 0) - coalesce(p.refunded, 0)), 0)
         end::numeric(12,2) as balance,
         p.last_paid_on,
         case
           when i.cancelled_at is not null then 'annulee'
           when i.kind = 'avoir' then 'avoir'
           when i.amount_ttc - coalesce(cr.credited, 0) - (coalesce(p.paid, 0) - coalesce(p.refunded, 0)) <= 0 then 'payee'
           when i.due_date is not null and i.due_date < public.today_paris() then 'en_retard'
           when coalesce(p.paid, 0) - coalesce(p.refunded, 0) > 0 then 'partielle'
           else 'a_encaisser'
         end as status
    from public.finance_invoices i
    join public.companies c on c.id = i.company_id
    left join public.finance_missions m on m.id = i.mission_id
    left join lateral (
      select sum(amount) filter (where kind = 'paiement') as paid,
             sum(amount) filter (where kind = 'remboursement') as refunded,
             max(paid_on) filter (where kind = 'paiement') as last_paid_on
        from public.finance_payments where invoice_id = i.id and cancelled_at is null) p on true
    left join lateral (
      select sum(amount_ttc) as credited from public.finance_invoices a
       where a.credited_invoice_id = i.id and a.cancelled_at is null) cr on true;

-- Totaux par mission (facturé net d'avoirs, encaissé, reste).
create or replace view public.finance_mission_overview with (security_invoker = true) as
  select m.*,
         c.name as company_name,
         (coalesce(sum(o.amount_ht) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)
           - coalesce(sum(o.amount_ht) filter (where o.kind = 'avoir' and o.cancelled_at is null), 0))::numeric(12,2) as invoiced_ht,
         (coalesce(sum(o.amount_ttc) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)
           - coalesce(sum(o.amount_ttc) filter (where o.kind = 'avoir' and o.cancelled_at is null), 0))::numeric(12,2) as invoiced_ttc,
         coalesce(sum(o.paid_net) filter (where o.kind = 'facture' and o.cancelled_at is null), 0)::numeric(12,2) as received,
         coalesce(sum(o.balance), 0)::numeric(12,2) as remaining
    from public.finance_missions m
    join public.companies c on c.id = m.company_id
    left join public.finance_invoice_overview o on o.mission_id = m.id
   group by m.id, c.name;

-- Mouvements de trésorerie réels : source unique des encaissements et décaissements.
-- Une cotisation URSSAF payée y figure une seule fois (depuis la période URSSAF), même si elle
-- est aussi affichée dans les charges. Une charge de catégorie « Cotisations sociales » saisie
-- à la main y figure aussi : l'interface invite à ne pas saisir l'URSSAF en double.
create or replace view public.finance_cash_movements with (security_invoker = true) as
  select p.id, p.paid_on as date,
         case when p.kind = 'paiement' then 'in' else 'out' end as direction,
         case when p.kind = 'paiement' then 'paiement_client' else 'remboursement_client' end as source,
         p.amount,
         case when i.amount_ttc > 0 then round(p.amount * i.amount_ht / i.amount_ttc, 2) else p.amount end::numeric(12,2) as amount_ht,
         i.company_id, null::uuid as category_id, i.id as invoice_id, null::uuid as expense_id, null::uuid as urssaf_period_id,
         coalesce(c.name, '') || coalesce(' · ' || i.reference, '') as label
    from public.finance_payments p
    join public.finance_invoices i on i.id = p.invoice_id
    join public.companies c on c.id = i.company_id
   where p.cancelled_at is null
  union all
  select e.id, e.paid_on, 'out', 'charge', e.amount, coalesce(e.amount_ht, e.amount), null, e.category_id, null, e.id, null, e.label
    from public.finance_expenses e
   where e.status = 'paye'
  union all
  select u.id, u.paid_on, 'out', 'urssaf', u.paid_amount, u.paid_amount, null, null, null, null, u.id,
         'Cotisations URSSAF ' || to_char(u.period_start, 'YYYY-MM') || case when u.period_end > (u.period_start + interval '1 month' - interval '1 day')::date then ' → ' || to_char(u.period_end, 'YYYY-MM') else '' end
    from public.finance_urssaf_periods u
   where u.paid_on is not null;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.finance_invoice_overview, public.finance_mission_overview, public.finance_cash_movements from anon;
grant select on public.finance_invoice_overview, public.finance_mission_overview, public.finance_cash_movements to authenticated;


-- ===== 20261105000100_perf_sources_fichiers.sql =====
-- Performance (index, pagination serveur), sources personnalisables, fichiers des fiches.
-- Migration additive : aucune donnée supprimée.

-- ---------------------------------------------------------------------------
-- Index justifiés par les filtres, tris et relations réellement utilisés
-- ---------------------------------------------------------------------------

create index if not exists companies_active_created_idx on public.companies (created_at desc) where merged_into_id is null;
create index if not exists companies_source_idx on public.companies (source_id) where merged_into_id is null;
create index if not exists companies_status_idx on public.companies (prospect_status) where merged_into_id is null;
create index if not exists companies_pipeline_deal_idx on public.companies (pipeline_id, deal_status) where merged_into_id is null;
create index if not exists companies_domain_trgm on public.companies using gin (domain_norm extensions.gin_trgm_ops);
create index if not exists people_name_trgm on public.people using gin (full_name_norm extensions.gin_trgm_ops);
create index if not exists people_email_trgm on public.people using gin (email_norm extensions.gin_trgm_ops);
create index if not exists tasks_company_open_idx on public.tasks (company_id, due_date) where done_at is null;
create index if not exists interactions_participant_idx on public.interactions (campaign_participant_id) where campaign_participant_id is not null;
create index if not exists participants_replies_idx on public.campaign_participants (status, outcome);

-- ---------------------------------------------------------------------------
-- Sources du contact : couleur, ordre, archivage (évolution de lead_sources)
-- ---------------------------------------------------------------------------

alter table public.lead_sources
  add column color text not null default 'slate'
    check (color in ('slate','violet','blue','green','amber','red','pink','teal')),
  add column archived_at timestamptz;

update public.lead_sources set color = case lower(name)
  when 'linkedin' then 'blue' when 'email sortant' then 'violet' when 'recommandation' then 'green'
  when 'site web' then 'teal' when 'événement' then 'amber' else 'slate' end;

insert into public.lead_sources (name, position, color) values
  ('Ancien client', 7, 'pink'), ('Partenaire', 8, 'teal')
on conflict do nothing;

create or replace function public.reorder_sources(p_ids uuid[])
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.lead_sources s set position = o.ord
    from unnest(p_ids) with ordinality o(id, ord) where s.id = o.id;
end;
$$;

-- Suppression définitive : les fiches sont réaffectées ou leur source est vidée, jamais supprimées.
create or replace function public.delete_source(p_id uuid, p_replacement uuid default null)
returns jsonb
language plpgsql
as $$
declare v_moved int;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression de source');
  if p_replacement = p_id then raise exception 'Choisissez une autre source' using errcode = '22023'; end if;
  if p_replacement is not null and not exists (select 1 from public.lead_sources where id = p_replacement) then
    raise exception 'Source de remplacement introuvable' using errcode = 'P0002';
  end if;
  update public.companies set source_id = p_replacement where source_id = p_id;
  get diagnostics v_moved = row_count;
  delete from public.lead_sources where id = p_id;
  if not found then raise exception 'Source introuvable' using errcode = 'P0002'; end if;
  return jsonb_build_object('moved', v_moved);
end;
$$;

-- Modification groupée
create or replace function public.set_companies_source(p_ids uuid[], p_source uuid)
returns int
language plpgsql
as $$
declare n int;
begin
  perform public.assert_owner();
  if public.current_actor() = 'claude' and cardinality(p_ids) > 1 then
    perform public.assert_not_claude('Modification groupée');
  end if;
  update public.companies set source_id = p_source where id = any (p_ids) and merged_into_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Base de prospects : pagination, filtres et tri côté serveur.
-- Seules les lignes de la page sont enrichies (contact, listes, prochaine action).
-- ---------------------------------------------------------------------------

create or replace function public.companies_page(
  p_filters jsonb default '{}', p_sort text default 'created', p_asc boolean default false,
  p_limit int default 50, p_offset int default 0, p_ids_only boolean default false)
returns jsonb
language plpgsql
stable
as $$
declare
  v_q text := nullif(lower(btrim(coalesce(p_filters ->> 'q', ''))), '');
  v_qn text := public.norm_company_name(p_filters ->> 'q');
  v_qp text := public.norm_person_name(p_filters ->> 'q', null);
  v_list uuid := nullif(p_filters ->> 'list', '')::uuid;
  v_source text := nullif(p_filters ->> 'source', '');
  v_tag text := nullif(p_filters ->> 'tag', '');
  v_status text := nullif(p_filters ->> 'status', '');
  v_pipeline text := nullif(p_filters ->> 'pipeline', '');
  v_archived boolean := coalesce((p_filters ->> 'archived')::boolean, false);
  v_order text;
  v_where text := $w$
    c.merged_into_id is null
    and (case when $5 then c.archived_at is not null else c.archived_at is null end)
    and ($1 is null or c.name ilike '%' || $1 || '%' or c.name_norm like '%' || coalesce($2, $1) || '%'
         or c.domain_norm like '%' || $1 || '%'
         or exists (select 1 from public.people p where p.company_id = c.id
                    and (p.full_name_norm like '%' || coalesce($3, $1) || '%' or p.email_norm like '%' || $1 || '%')))
    and ($4 is null or exists (select 1 from public.list_members m where m.company_id = c.id and m.list_id = $4))
    and ($6 is null or ($6 = 'none' and c.source_id is null) or c.source_id::text = $6)
    and ($7 is null or c.tags @> array[$7])
    and ($8 is null or c.prospect_status = $8)
    and ($9 is null or ($9 = 'yes' and c.pipeline_id is not null) or ($9 = 'no' and c.pipeline_id is null))
  $w$;
  v_res jsonb;
begin
  perform public.assert_owner();
  if p_ids_only then
    execute 'select coalesce(jsonb_agg(c.id), ''[]'') from (select c.id from public.companies c where ' || v_where || ' limit 5000) c'
      into v_res using v_q, v_qn, v_qp, v_list, v_archived, v_source, v_tag, v_status, v_pipeline;
    return v_res;
  end if;

  v_order := case p_sort
    when 'name' then 'c.name_norm'
    when 'contact' then '(select p.full_name_norm from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1)'
    when 'source' then '(select s.position from public.lead_sources s where s.id = c.source_id)'
    when 'status' then 'c.prospect_status'
    when 'last' then 'c.last_interaction_at'
    when 'next' then '(select min(t.due_date) from public.todo_items t where t.company_id = c.id)'
    else 'c.created_at' end;

  execute format($q$
    with filtered as (select c.id from public.companies c where %1$s),
    page as (
      select c.* from public.companies c join filtered f on f.id = c.id
       order by %2$s %3$s nulls last, c.id
       limit greatest(1, least($10, 200)) offset greatest($11, 0)
    )
    select jsonb_build_object(
      'total', (select count(*) from filtered),
      'rows', coalesce((select jsonb_agg(r) from (
        select c.id, c.name, c.website, c.domain_norm, c.source_id, c.tags, c.prospect_status, c.pipeline_id, c.stage_id,
               c.deal_status, c.amount, c.last_interaction_at, c.archived_at, c.do_not_contact, c.created_at, c.updated_at,
               pp.id as primary_person_id,
               nullif(btrim(coalesce(pp.first_name,'') || ' ' || coalesce(pp.last_name,'')), '') as primary_person_name,
               (select count(*) from public.people p where p.company_id = c.id)::int as people_count,
               coalesce((select array_agg(m.list_id) from public.list_members m where m.company_id = c.id), '{}') as list_ids,
               na.title as next_action_title, na.due_date as next_action_due, na.item_type as next_action_type
          from page c
          left join lateral (select * from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1) pp on true
          left join lateral (select t.title, t.due_date, t.item_type from public.todo_items t where t.company_id = c.id order by t.due_date, t.item_type limit 1) na on true
         order by %2$s %3$s nulls last, c.id
      ) r), '[]'))
  $q$, v_where, v_order, case when p_asc then 'asc' else 'desc' end)
  into v_res using v_q, v_qn, v_qp, v_list, v_archived, v_source, v_tag, v_status, v_pipeline, p_limit, p_offset;
  return v_res;
end;
$$;

create or replace function public.company_tags()
returns text[]
language sql
stable
as $$
  select coalesce(array_agg(distinct t order by t), '{}')
    from public.companies c, unnest(c.tags) t where c.merged_into_id is null;
$$;

-- Compteurs de la barre latérale, en une seule requête
create or replace function public.nav_counters(p_today date)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'todo', (select count(*) from public.todo_items where due_date <= p_today),
    'due', (select count(*) from public.todo_items where item_type = 'followup' and due_date <= p_today),
    'replies', (select count(*) from public.campaign_participants where status = 'a_repondu' and outcome in ('none', 'replied')));
$$;

-- ---------------------------------------------------------------------------
-- Fichiers : métadonnées en base, contenu dans un bucket Storage privé
-- ---------------------------------------------------------------------------

create table public.company_files (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  storage_path text not null unique,          -- nom de stockage unique, distinct du nom affiché
  display_name text not null check (char_length(btrim(display_name)) between 1 and 200),
  category text check (category is null or category in ('Proposition', 'Contrat', 'Brief', 'Présentation', 'Autre')),
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 26214400),
  -- pending : transfert en cours ; ready : disponible ; deleting : suppression à terminer
  status text not null default 'pending' check (status in ('pending', 'ready', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index company_files_company_idx on public.company_files (company_id, created_at desc);
create index company_files_pending_idx on public.company_files (created_at) where status <> 'ready';
create trigger set_updated_at before update on public.company_files
  for each row execute function public.tg_set_updated_at();

alter table public.company_files enable row level security;
create policy owner_select on public.company_files for select to authenticated using ((select public.is_app_owner()));
create policy owner_insert on public.company_files for insert to authenticated with check ((select public.is_app_owner()));
create policy owner_update on public.company_files for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()));
create policy owner_delete on public.company_files for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.company_files from anon;

-- Une fusion de fiches conserve les fichiers
create or replace function public.tg_companies_merge_files()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.company_files set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger companies_merge_files after update of merged_into_id on public.companies
  for each row execute function public.tg_companies_merge_files();

-- Bucket privé : taille et formats contrôlés par Storage lui-même
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('company-files', 'company-files', false, 26214400, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy company_files_select on storage.objects for select to authenticated
  using (bucket_id = 'company-files' and (select public.is_app_owner()));
create policy company_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'company-files' and (select public.is_app_owner()));
create policy company_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'company-files' and (select public.is_app_owner()) and public.current_actor() = 'user');

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;


-- ===== 20261105120000_rendez_vous.sql =====
-- Module Rendez-vous : types de rendez-vous, plannings, réservations publiques, Google Calendar (côté
-- données), rattachement CRM. Migration additive : aucune table existante n'est modifiée.
--
-- Sécurité
-- * Back-office : tables réservées au propriétaire (RLS), écritures sensibles par fonctions.
-- * Réservation publique : le visiteur n'a pas de compte. Le serveur Next appelle les fonctions
--   appt_public_* / appt_book… avec la clé publique Supabase ET une clé serveur (dérivée de
--   APPOINTMENTS_SECRET, jamais envoyée au navigateur) dont l'empreinte est enregistrée par le
--   propriétaire (appt_register_server_key). Sans cette clé, ces fonctions refusent tout.
-- * Liens privés (annulation, report) : jeton HMAC propre au rendez-vous ; la base n'en garde que
--   l'empreinte SHA-256 et la compare à chaque opération.
-- * Fonctions internes : schéma appt_private, non exposé par l'API (aucun appel direct possible).

create extension if not exists btree_gist with schema extensions;
create schema if not exists appt_private;
revoke all on schema appt_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Réglages (une seule ligne)
-- ---------------------------------------------------------------------------

create table public.appt_settings (
  id boolean primary key default true check (id),
  server_key_hash text check (server_key_hash is null or server_key_hash ~ '^[0-9a-f]{64}$'),
  display_name text not null default 'Cely Growth' check (char_length(btrim(display_name)) between 1 and 120),
  intro text check (intro is null or char_length(intro) <= 1000),
  updated_at timestamptz not null default now()
);
insert into public.appt_settings (id) values (true);

create or replace function appt_private.valid_tz(p_tz text)
returns boolean
language sql
stable
set search_path = ''
as $$ select p_tz is not null and exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz); $$;

-- ---------------------------------------------------------------------------
-- Plannings réutilisables : horaires hebdomadaires (plusieurs plages par jour) et exceptions datées
-- ---------------------------------------------------------------------------

create table public.appt_schedules (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  timezone text not null default 'Europe/Paris',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index appt_schedules_one_default on public.appt_schedules ((true)) where is_default;

-- weekday : 1 = lundi … 7 = dimanche (ISO). end_time peut valoir 24:00.
create table public.appt_schedule_rules (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.appt_schedules (id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  start_time time not null,
  end_time time not null,
  check (start_time < end_time)
);
create index appt_schedule_rules_idx on public.appt_schedule_rules (schedule_id, weekday);

-- Exception datée : une ligne sans horaires = journée indisponible ; des lignes avec horaires
-- remplacent les horaires hebdomadaires de ce jour-là.
create table public.appt_schedule_overrides (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.appt_schedules (id) on delete cascade,
  on_date date not null,
  start_time time,
  end_time time,
  check ((start_time is null) = (end_time is null)),
  check (start_time is null or start_time < end_time)
);
create index appt_schedule_overrides_idx on public.appt_schedule_overrides (schedule_id, on_date);

-- Congés et blocages : communs à tous les plannings
create table public.appt_blocks (
  id uuid primary key default gen_random_uuid(),
  label text check (label is null or char_length(label) <= 120),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appt_blocks_range_idx on public.appt_blocks using gist (tstzrange(starts_at, ends_at));

-- ---------------------------------------------------------------------------
-- Types de rendez-vous
-- ---------------------------------------------------------------------------

create table public.appt_event_types (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 80),
  description text check (description is null or char_length(description) <= 2000),
  duration_min int not null check (duration_min between 5 and 480),
  location_kind text not null default 'video' check (location_kind in ('video','phone','other')),
  location_detail text check (location_detail is null or char_length(location_detail) <= 500),
  meeting_url text check (meeting_url is null or (meeting_url ~ '^https://' and char_length(meeting_url) <= 500)),
  google_meet boolean not null default false,
  schedule_id uuid not null references public.appt_schedules (id) on delete restrict,
  buffer_before_min int not null default 0 check (buffer_before_min between 0 and 240),
  buffer_after_min int not null default 0 check (buffer_after_min between 0 and 240),
  min_notice_min int not null default 240 check (min_notice_min between 0 and 43200),
  horizon_days int not null default 60 check (horizon_days between 1 and 365),
  daily_limit int check (daily_limit is null or daily_limit between 1 and 50),
  slot_interval_min int check (slot_interval_min is null or slot_interval_min between 5 and 240),
  phone_required boolean not null default false,
  questions jsonb not null default '[]' check (jsonb_typeof(questions) = 'array' and jsonb_array_length(questions) <= 20),
  active boolean not null default true,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index appt_event_types_slug_uniq on public.appt_event_types (slug);

-- ---------------------------------------------------------------------------
-- Réservations
-- status : pending (créneau retenu, opérations externes en cours) → confirmed ;
--          failed (échec, créneau libéré) ; expired (retenue abandonnée) ; cancelled.
-- version : incrémentée à chaque changement visible (report, annulation…). Sert à la
--           synchronisation Google et, plus tard, à l'invalidation des rappels.
-- ---------------------------------------------------------------------------

create table public.appt_bookings (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references public.appt_event_types (id) on delete restrict,
  status text not null default 'pending' check (status in ('pending','confirmed','cancelled','failed','expired')),
  outcome text check (outcome in ('done','no_show')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  buffer_before_min int not null default 0,
  buffer_after_min int not null default 0,
  schedule_timezone text not null,
  invitee_timezone text not null,
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  email text not null check (char_length(email) <= 254),
  email_norm text not null,
  phone text check (phone is null or char_length(phone) <= 50),
  company_name text check (company_name is null or char_length(company_name) <= 200),
  website text check (website is null or char_length(website) <= 300),
  answers jsonb not null default '[]',
  -- copie figée du type au moment de la réservation : modifier le type ne touche pas aux rendez-vous
  event_snapshot jsonb not null,
  meeting_url text check (meeting_url is null or char_length(meeting_url) <= 500),
  company_id uuid references public.companies (id) on delete set null,
  person_id uuid references public.people (id) on delete set null,
  crm_status text not null default 'to_link' check (crm_status in ('linked','created','to_link')),
  crm_candidates jsonb not null default '[]',
  internal_note text check (internal_note is null or char_length(internal_note) <= 5000),
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) <= 1000),
  cancelled_by text check (cancelled_by in ('invitee','owner')),
  cancelled_at timestamptz,
  version int not null default 1,
  idempotency_key text not null unique check (char_length(idempotency_key) between 8 and 200),
  manage_token_hash text not null check (manage_token_hash ~ '^[0-9a-f]{64}$'),
  -- Google Calendar
  calendar_target boolean not null default false,
  calendar_id text,
  google_event_id text,
  calendar_synced_version int not null default 0,
  calendar_sync_error text,
  calendar_sync_attempts int not null default 0,
  hold_expires_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index appt_bookings_starts_idx on public.appt_bookings (starts_at);
create index appt_bookings_company_idx on public.appt_bookings (company_id, starts_at desc);
create index appt_bookings_email_idx on public.appt_bookings (email_norm);
create index appt_bookings_type_idx on public.appt_bookings (event_type_id, starts_at);
create index appt_bookings_sync_idx on public.appt_bookings (updated_at) where calendar_target and calendar_synced_version < version;

-- Occupation des créneaux (battements compris). La contrainte d'exclusion interdit en base deux
-- occupations actives qui se chevauchent pour deux rendez-vous différents. Un report crée une
-- occupation « hold » du nouveau créneau avant de libérer l'ancien.
create table public.appt_reservations (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.appt_bookings (id) on delete cascade,
  kind text not null check (kind in ('main','hold')),
  occupied tstzrange not null check (not isempty(occupied)),
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint appt_reservations_no_overlap exclude using gist (booking_id with <>, occupied with &&) where (active)
);
create index appt_reservations_booking_idx on public.appt_reservations (booking_id);

-- Historique de chaque rendez-vous (jamais supprimé)
create table public.appt_booking_events (
  id bigint generated always as identity primary key,
  booking_id uuid not null references public.appt_bookings (id) on delete cascade,
  kind text not null,
  actor text not null check (actor in ('invitee','owner','system')),
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index appt_booking_events_idx on public.appt_booking_events (booking_id, id);

-- ---------------------------------------------------------------------------
-- Connexion Google Calendar (une seule). Le jeton de rafraîchissement est chiffré côté serveur
-- (AES-256-GCM) avant d'arriver ici : la base ne voit jamais le jeton en clair.
-- ---------------------------------------------------------------------------

create table public.appt_google_connection (
  id boolean primary key default true check (id),
  google_email text,
  refresh_token_enc text not null,
  scopes text not null,
  calendars jsonb not null default '[]',
  check_calendar_ids text[] not null default '{}',
  destination_calendar_id text,
  status text not null default 'connected' check (status in ('connected','error')),
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Dates de modification, RLS
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['appt_schedules','appt_event_types','appt_bookings','appt_settings','appt_google_connection']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
  end loop;
  foreach t in array array['appt_settings','appt_schedules','appt_schedule_rules','appt_schedule_overrides','appt_blocks',
                           'appt_event_types','appt_bookings','appt_reservations','appt_booking_events','appt_google_connection']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  -- écriture directe autorisée pour la configuration ; réservations, occupations et historique
  -- ne s'écrivent que par les fonctions ci-dessous (règles de cohérence)
  foreach t in array array['appt_settings','appt_schedules','appt_schedule_rules','appt_schedule_overrides','appt_blocks','appt_event_types']
  loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
  end loop;
end $$;

-- le jeton chiffré ne quitte la base que par appt_server_google (clé serveur) : pas de lecture directe
drop policy owner_select on public.appt_google_connection;
create policy owner_select on public.appt_google_connection for select to authenticated using (false);
revoke select on public.appt_google_connection from authenticated;
grant select (google_email, scopes, calendars, check_calendar_ids, destination_calendar_id, status, last_error, connected_at, updated_at)
  on public.appt_google_connection to authenticated;
drop policy owner_select on public.appt_google_connection;
create policy owner_select on public.appt_google_connection for select to authenticated using ((select public.is_app_owner()));
-- la clé serveur n'est lisible par personne via l'API
revoke select on public.appt_settings from authenticated;
grant select (id, display_name, intro, updated_at) on public.appt_settings to authenticated;
revoke update on public.appt_settings from authenticated;
grant update (display_name, intro) on public.appt_settings to authenticated;

-- ---------------------------------------------------------------------------
-- Contrôles d'accès
-- ---------------------------------------------------------------------------

create or replace function appt_private.hash(p text)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(pg_catalog.sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex'); $$;

create or replace function appt_private.assert_server(p_key text)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare v_hash text;
begin
  select server_key_hash into v_hash from public.appt_settings where id;
  if p_key is null or char_length(p_key) < 32 or v_hash is null or v_hash <> appt_private.hash(p_key) then
    raise exception 'Accès refusé' using errcode = '42501';
  end if;
end;
$$;

-- Propriétaire (session de l'application, pas un jeton Claude)
create or replace function appt_private.assert_owner_user()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then
    raise exception 'Rendez-vous : action réservée à l''application' using errcode = '42501';
  end if;
end;
$$;

-- Propriétaire, ou serveur + jeton privé du rendez-vous (lien d'annulation / report)
create or replace function appt_private.authorize(p_booking uuid, p_server_key text, p_token_hash text)
returns text
language plpgsql
stable
set search_path = ''
as $$
begin
  if public.is_app_owner() and public.current_actor() = 'user' and p_server_key is null then
    return 'owner';
  end if;
  perform appt_private.assert_server(p_server_key);
  if p_token_hash is null or not exists (
       select 1 from public.appt_bookings where id = p_booking and manage_token_hash = p_token_hash) then
    raise exception 'Lien invalide ou expiré' using errcode = '42501';
  end if;
  return 'invitee';
end;
$$;

-- Le propriétaire enregistre l'empreinte de la clé serveur (calculée côté serveur, jamais transmise en clair)
create or replace function public.appt_register_server_key(p_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  if p_hash !~ '^[0-9a-f]{64}$' then raise exception 'Empreinte invalide' using errcode = '22023'; end if;
  update public.appt_settings set server_key_hash = p_hash where id and server_key_hash is distinct from p_hash;
end;
$$;

create or replace function public.appt_server_key_registered(p_hash text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$ select public.is_app_owner() and exists (select 1 from public.appt_settings where id and server_key_hash = p_hash); $$;

create or replace function appt_private.log(p_booking uuid, p_kind text, p_actor text, p_data jsonb default '{}')
returns void
language sql
set search_path = ''
as $$
  insert into public.appt_booking_events (booking_id, kind, actor, data) values (p_booking, p_kind, p_actor, coalesce(p_data, '{}'));
$$;

-- ---------------------------------------------------------------------------
-- Plannings : enregistrement complet et validé (plages qui ne se chevauchent pas)
-- p_data : {name, timezone, is_default, rules:[{weekday,start,end}], overrides:[{date,start?,end?}]}
-- ---------------------------------------------------------------------------

create or replace function public.appt_save_schedule(p_id uuid, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_tz text := coalesce(nullif(btrim(p_data ->> 'timezone'), ''), 'Europe/Paris');
  v_bad int;
begin
  perform appt_private.assert_owner_user();
  if not appt_private.valid_tz(v_tz) then raise exception 'Fuseau horaire inconnu : %', v_tz using errcode = '22023'; end if;
  if coalesce(btrim(p_data ->> 'name'), '') = '' then raise exception 'Le nom du planning est obligatoire' using errcode = '22023'; end if;

  create temporary table if not exists pg_temp.appt_rules (weekday smallint, start_time time, end_time time) on commit drop;
  create temporary table if not exists pg_temp.appt_overrides (on_date date, start_time time, end_time time) on commit drop;
  delete from pg_temp.appt_rules;
  delete from pg_temp.appt_overrides;
  insert into pg_temp.appt_rules
    select (x ->> 'weekday')::smallint, (x ->> 'start')::time, (x ->> 'end')::time
      from jsonb_array_elements(coalesce(p_data -> 'rules', '[]')) x;
  insert into pg_temp.appt_overrides
    select (x ->> 'date')::date, nullif(x ->> 'start', '')::time, nullif(x ->> 'end', '')::time
      from jsonb_array_elements(coalesce(p_data -> 'overrides', '[]')) x;

  if exists (select 1 from pg_temp.appt_rules where weekday not between 1 and 7 or start_time >= end_time)
     or exists (select 1 from pg_temp.appt_overrides where (start_time is null) <> (end_time is null) or start_time >= end_time) then
    raise exception 'Une plage horaire est invalide (le début doit précéder la fin)' using errcode = '22023';
  end if;
  select count(*) into v_bad from pg_temp.appt_rules a join pg_temp.appt_rules b
    on a.weekday = b.weekday and a.ctid < b.ctid and a.start_time < b.end_time and b.start_time < a.end_time;
  if v_bad > 0 then raise exception 'Deux plages du même jour se chevauchent' using errcode = '22023'; end if;
  select count(*) into v_bad from pg_temp.appt_overrides a join pg_temp.appt_overrides b
    on a.on_date = b.on_date and a.ctid < b.ctid
   and (a.start_time is null or b.start_time is null or (a.start_time < b.end_time and b.start_time < a.end_time));
  if v_bad > 0 then raise exception 'Les exceptions d''une même date se chevauchent' using errcode = '22023'; end if;

  if v_id is null then
    insert into public.appt_schedules (name, timezone) values (btrim(p_data ->> 'name'), v_tz) returning id into v_id;
  else
    update public.appt_schedules set name = btrim(p_data ->> 'name'), timezone = v_tz where id = v_id;
    if not found then raise exception 'Planning introuvable' using errcode = 'P0002'; end if;
  end if;
  if coalesce((p_data ->> 'is_default')::boolean, false) or not exists (select 1 from public.appt_schedules where is_default) then
    update public.appt_schedules set is_default = false where is_default and id <> v_id;
    update public.appt_schedules set is_default = true where id = v_id;
  end if;

  delete from public.appt_schedule_rules where schedule_id = v_id;
  insert into public.appt_schedule_rules (schedule_id, weekday, start_time, end_time)
    select v_id, weekday, start_time, end_time from pg_temp.appt_rules;
  delete from public.appt_schedule_overrides where schedule_id = v_id;
  insert into public.appt_schedule_overrides (schedule_id, on_date, start_time, end_time)
    select v_id, on_date, start_time, end_time from pg_temp.appt_overrides;
  return v_id;
end;
$$;

-- Congé ou blocage saisi en heure locale (conversion faite par Postgres, changements d'heure compris)
create or replace function public.appt_save_block(
  p_id uuid, p_label text, p_start_date date, p_end_date date,
  p_start_time time default null, p_end_time time default null, p_timezone text default 'Europe/Paris')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := p_id;
  v_all_day boolean := p_start_time is null and p_end_time is null;
  v_start timestamptz;
  v_end timestamptz;
begin
  perform appt_private.assert_owner_user();
  if not appt_private.valid_tz(p_timezone) then raise exception 'Fuseau horaire inconnu' using errcode = '22023'; end if;
  if p_start_date is null or p_end_date is null or p_end_date < p_start_date then
    raise exception 'Dates du blocage invalides' using errcode = '22023';
  end if;
  if v_all_day then
    v_start := p_start_date::timestamp at time zone p_timezone;
    v_end := (p_end_date + 1)::timestamp at time zone p_timezone;
  else
    v_start := (p_start_date + coalesce(p_start_time, time '00:00')) at time zone p_timezone;
    v_end := (p_end_date + coalesce(p_end_time, time '24:00')) at time zone p_timezone;
  end if;
  if v_end <= v_start then raise exception 'La fin du blocage doit suivre son début' using errcode = '22023'; end if;
  if v_id is null then
    insert into public.appt_blocks (label, starts_at, ends_at, all_day)
    values (nullif(btrim(coalesce(p_label, '')), ''), v_start, v_end, v_all_day) returning id into v_id;
  else
    update public.appt_blocks set label = nullif(btrim(coalesce(p_label, '')), ''), starts_at = v_start, ends_at = v_end, all_day = v_all_day
     where id = v_id;
    if not found then raise exception 'Blocage introuvable' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Calcul des créneaux (source unique : liste publique ET vérification finale)
-- p_busy : occupations externes (Google Calendar) [{start, end}], déjà débarrassées de nos propres événements.
-- Règles : plages hebdomadaires ou exceptions du jour (fuseau du planning), délai minimum,
-- horizon, congés/blocages, occupations de tous les types (battements compris, des deux côtés),
-- occupations Google (battements compris), limite quotidienne du type.
-- ---------------------------------------------------------------------------

create or replace function appt_private.compute_slots(
  p_type_id uuid, p_from timestamptz, p_to timestamptz, p_busy jsonb default '[]', p_exclude_booking uuid default null)
returns table (slot timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  t public.appt_event_types;
  v_tz text;
  v_step interval;
  v_dur interval;
  v_before interval;
  v_after interval;
  v_from timestamptz;
  v_to timestamptz;
begin
  select * into t from public.appt_event_types where id = p_type_id;
  if not found then return; end if;
  select s.timezone into v_tz from public.appt_schedules s where s.id = t.schedule_id;
  if v_tz is null then return; end if;
  v_dur := make_interval(mins => t.duration_min);
  v_step := make_interval(mins => coalesce(t.slot_interval_min, t.duration_min));
  v_before := make_interval(mins => t.buffer_before_min);
  v_after := make_interval(mins => t.buffer_after_min);
  v_from := greatest(p_from, now() + make_interval(mins => t.min_notice_min));
  -- horizon : jusqu'à la fin du jour local (aujourd'hui + horizon_days)
  v_to := least(p_to, (((now() at time zone v_tz)::date + t.horizon_days + 1)::timestamp at time zone v_tz));
  if v_to <= v_from then return; end if;

  return query
  with days as (
    select d::date as day
      from generate_series(((v_from at time zone v_tz)::date)::timestamp, ((v_to at time zone v_tz)::date)::timestamp, interval '1 day') d
  ), windows as (
    select dd.day, o.start_time, o.end_time
      from days dd join public.appt_schedule_overrides o on o.schedule_id = t.schedule_id and o.on_date = dd.day
     where o.start_time is not null
    union all
    select dd.day, r.start_time, r.end_time
      from days dd join public.appt_schedule_rules r on r.schedule_id = t.schedule_id and r.weekday = extract(isodow from dd.day)
     where not exists (select 1 from public.appt_schedule_overrides o where o.schedule_id = t.schedule_id and o.on_date = dd.day)
  ), bounds as (
    select w.day, (w.day + w.start_time) at time zone v_tz as ws, (w.day + w.end_time) at time zone v_tz as we from windows w
  ), cands as (
    select b.day, g as s
      from bounds b, generate_series(b.ws, b.we - v_dur, v_step) g
  ), busy as (
    select tstzrange((x ->> 'start')::timestamptz, (x ->> 'end')::timestamptz) as r
      from jsonb_array_elements(case when jsonb_typeof(p_busy) = 'array' then p_busy else '[]'::jsonb end) x
     where (x ->> 'end')::timestamptz > (x ->> 'start')::timestamptz
  )
  select distinct c.s
    from cands c
   where c.s >= v_from and c.s < v_to
     and not exists (
       select 1 from public.appt_reservations rv
        where rv.active and (rv.expires_at is null or rv.expires_at > now())
          and (p_exclude_booking is null or rv.booking_id <> p_exclude_booking)
          and rv.occupied && tstzrange(c.s - v_before, c.s + v_dur + v_after))
     and not exists (
       select 1 from public.appt_blocks bl where tstzrange(bl.starts_at, bl.ends_at) && tstzrange(c.s, c.s + v_dur))
     and not exists (select 1 from busy where busy.r && tstzrange(c.s - v_before, c.s + v_dur + v_after))
     and (t.daily_limit is null or (
       select count(*) from public.appt_bookings bk
        where bk.event_type_id = t.id
          and (bk.status = 'confirmed' or (bk.status = 'pending' and bk.hold_expires_at > now()))
          and (p_exclude_booking is null or bk.id <> p_exclude_booking)
          and (bk.starts_at at time zone v_tz)::date = c.day) < t.daily_limit)
   order by 1;
end;
$$;

-- Retenues abandonnées (serveur interrompu entre la base et Google) : libérées avant toute réservation.
create or replace function appt_private.sweep()
returns void
language plpgsql
set search_path = ''
as $$
declare r record;
begin
  for r in
    update public.appt_bookings set status = 'expired', version = version + 1, hold_expires_at = null
     where status = 'pending' and hold_expires_at < now()
    returning id
  loop
    update public.appt_reservations set active = false where booking_id = r.id and active;
    perform appt_private.log(r.id, 'expired', 'system', jsonb_build_object('reason', 'Retenue du créneau expirée avant confirmation'));
  end loop;
  update public.appt_reservations set active = false where active and kind = 'hold' and expires_at < now();
end;
$$;

create or replace function appt_private.lock()
returns void
language sql
set search_path = ''
as $$ select pg_advisory_xact_lock(hashtextextended('appt:booking', 0)); $$;

-- ---------------------------------------------------------------------------
-- Rattachement CRM automatique (jamais de fusion, jamais d'écrasement)
-- 1. Email déjà connu chez une seule personne → rattaché.
-- 2. Sinon, indices (domaine professionnel, nom d'entreprise proche, email chez plusieurs fiches)
--    → « À rattacher » avec les suggestions.
-- 3. Aucun indice et entreprise renseignée → nouvelle fiche (entreprise + personne).
-- 4. Aucun indice et pas d'entreprise → « À rattacher » (rien n'est déduit d'un domaine grand public).
-- ---------------------------------------------------------------------------

create or replace function appt_private.crm_note(p_booking uuid, p_company uuid, p_person uuid, p_text text)
returns void
language sql
set search_path = ''
as $$
  insert into public.interactions (company_id, person_id, kind, content, content_origin, source, meta)
  values (p_company, p_person, 'system', p_text, 'system', 'system', jsonb_build_object('appointment_id', p_booking));
$$;

create or replace function appt_private.booking_label(b public.appt_bookings)
returns text
language sql
stable
set search_path = ''
as $$
  select (b.event_snapshot ->> 'name') || ' le ' || to_char(b.starts_at at time zone b.schedule_timezone, 'DD/MM/YYYY à HH24"h"MI');
$$;

create or replace function appt_private.link_crm(p_booking uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  b public.appt_bookings;
  v_people int;
  v_person uuid;
  v_company uuid;
  v_candidates jsonb;
  v_email_domain text;
  v_site_domain text;
  v_name text;
begin
  select * into b from public.appt_bookings where id = p_booking for update;
  if b.company_id is not null then return; end if;

  select count(*), min(p.id::text)::uuid into v_people, v_person
    from public.people p join public.companies c on c.id = p.company_id
   where p.email_norm = b.email_norm and c.merged_into_id is null;

  if v_people = 1 then
    select company_id into v_company from public.people where id = v_person;
    update public.appt_bookings set company_id = v_company, person_id = v_person, crm_status = 'linked', crm_candidates = '[]'
     where id = b.id;
    perform appt_private.log(b.id, 'crm_linked', 'system', jsonb_build_object('company_id', v_company, 'reason', 'Email déjà connu'));
    perform appt_private.crm_note(b.id, v_company, v_person, 'Rendez-vous réservé : ' || appt_private.booking_label(b));
    return;
  end if;

  v_email_domain := public.email_domain(b.email_norm);
  if public.is_free_email_domain(v_email_domain) then v_email_domain := null; end if;
  v_site_domain := public.norm_domain(b.website);
  if public.is_free_email_domain(v_site_domain) then v_site_domain := null; end if;
  v_name := public.norm_company_name(b.company_name);

  with hits as (
    select p.company_id as id, 'Même email : ' || p.email_norm as reason
      from public.people p where p.email_norm = b.email_norm
    union all
    select c.id, 'Domaine professionnel identique : ' || c.domain_norm
      from public.companies c where c.domain_norm is not null and c.domain_norm in (v_email_domain, v_site_domain)
    union all
    select p.company_id, 'Email au même domaine professionnel : ' || p.email_norm
      from public.people p where v_email_domain is not null and public.email_domain(p.email_norm) = v_email_domain
    union all
    select c.id, 'Nom d''entreprise identique'
      from public.companies c where v_name is not null and c.name_norm = v_name
    union all
    select c.id, 'Nom d''entreprise proche'
      from public.companies c
     where v_name is not null and char_length(v_name) >= 3 and c.name_norm <> v_name
       and extensions.similarity(c.name_norm, v_name) >= 0.55
  )
  select coalesce(jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.name, 'archived', c.archived_at is not null, 'reasons', h.reasons)
                            order by c.name), '[]')
    into v_candidates
    from (select id, array_agg(distinct reason) as reasons from hits group by id) h
    join public.companies c on c.id = h.id
   where c.merged_into_id is null;

  if jsonb_array_length(v_candidates) > 0 or b.company_name is null then
    update public.appt_bookings set crm_status = 'to_link', crm_candidates = v_candidates where id = b.id;
    perform appt_private.log(b.id, 'crm_to_link', 'system', jsonb_build_object('candidates', jsonb_array_length(v_candidates)));
    return;
  end if;

  insert into public.companies (name, website) values (b.company_name, b.website) returning id into v_company;
  insert into public.people (company_id, first_name, last_name, email, phone, is_primary)
  values (v_company, b.first_name, b.last_name, b.email, b.phone, true) returning id into v_person;
  insert into public.interactions (company_id, kind, content, content_origin, source, meta)
  values (v_company, 'system', 'Fiche créée depuis une prise de rendez-vous', 'system', 'system', jsonb_build_object('appointment_id', b.id));
  update public.appt_bookings set company_id = v_company, person_id = v_person, crm_status = 'created', crm_candidates = '[]' where id = b.id;
  perform appt_private.log(b.id, 'crm_created', 'system', jsonb_build_object('company_id', v_company));
  perform appt_private.crm_note(b.id, v_company, v_person, 'Rendez-vous réservé : ' || appt_private.booking_label(b));
end;
$$;

create or replace function appt_private.confirm(p_booking uuid, p_actor text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  update public.appt_bookings set status = 'confirmed', confirmed_at = now(), hold_expires_at = null where id = p_booking;
  update public.appt_reservations set expires_at = null where booking_id = p_booking and kind = 'main' and active;
  perform appt_private.log(p_booking, 'confirmed', p_actor);
  perform appt_private.link_crm(p_booking);
end;
$$;

-- ---------------------------------------------------------------------------
-- Points d'entrée publics (clé serveur obligatoire)
-- ---------------------------------------------------------------------------

create or replace function appt_private.public_type(t public.appt_event_types)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'slug', t.slug, 'name', t.name, 'description', t.description, 'duration_min', t.duration_min,
    'location_kind', t.location_kind, 'location_detail', t.location_detail,
    'has_meeting_link', t.meeting_url is not null or t.google_meet,
    'phone_required', t.phone_required or t.location_kind = 'phone',
    'questions', t.questions, 'horizon_days', t.horizon_days,
    'timezone', (select s.timezone from public.appt_schedules s where s.id = t.schedule_id),
    'display_name', (select display_name from public.appt_settings where id),
    'intro', (select intro from public.appt_settings where id));
$$;

create or replace function public.appt_public_event(p_server_key text, p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare t public.appt_event_types;
begin
  perform appt_private.assert_server(p_server_key);
  select * into t from public.appt_event_types where slug = lower(btrim(p_slug)) and active;
  if not found then return null; end if;
  return appt_private.public_type(t);
end;
$$;

-- Créneaux disponibles (instants UTC) ; p_exclude_booking : rendez-vous en cours de report
create or replace function public.appt_public_slots(
  p_server_key text, p_slug text, p_from timestamptz, p_to timestamptz, p_busy jsonb default '[]',
  p_exclude_booking uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_type uuid;
begin
  perform appt_private.assert_server(p_server_key);
  if p_to - p_from > interval '62 days' then raise exception 'Période trop longue' using errcode = '22023'; end if;
  select id into v_type from public.appt_event_types where slug = lower(btrim(p_slug)) and active;
  if v_type is null then return null; end if;
  return coalesce((select jsonb_agg(s.slot order by s.slot)
                     from appt_private.compute_slots(v_type, p_from, p_to, p_busy, p_exclude_booking) s), '[]');
end;
$$;

-- Nos propres rendez-vous (pour les retirer des occupations Google, où ils apparaissent aussi)
create or replace function public.appt_server_own_events(p_server_key text, p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  return coalesce((
    select jsonb_agg(jsonb_build_object('start', b.starts_at, 'end', b.ends_at))
      from public.appt_bookings b
     where b.google_event_id is not null and b.status in ('confirmed','pending')
       and b.starts_at < p_to and b.ends_at > p_from), '[]');
end;
$$;

-- Réservation : vérification finale sous verrou, puis retenue du créneau.
-- Sans agenda de destination : confirmée immédiatement. Avec : « pending » jusqu'à la création
-- de l'événement Google (appt_confirm_booking), libérée automatiquement si rien ne suit.
-- p_invitee : {first_name, last_name, email, phone, company_name, website, timezone}
-- p_answers : {question_id: valeur}
create or replace function public.appt_book(
  p_server_key text, p_booking_id uuid, p_slug text, p_starts_at timestamptz, p_invitee jsonb, p_answers jsonb,
  p_busy jsonb, p_calendar_target boolean, p_token_hash text, p_idempotency_key text, p_hold_minutes int default 10)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.appt_event_types;
  v_existing public.appt_bookings;
  v_tz text;
  v_inv_tz text := nullif(btrim(p_invitee ->> 'timezone'), '');
  v_first text := nullif(btrim(p_invitee ->> 'first_name'), '');
  v_last text := nullif(btrim(p_invitee ->> 'last_name'), '');
  v_email text := nullif(btrim(p_invitee ->> 'email'), '');
  v_phone text := nullif(btrim(p_invitee ->> 'phone'), '');
  v_company text := nullif(btrim(p_invitee ->> 'company_name'), '');
  v_website text := nullif(btrim(p_invitee ->> 'website'), '');
  v_answers jsonb := '[]';
  q jsonb;
  v_val text;
  v_end timestamptz;
  v_pending boolean := coalesce(p_calendar_target, false);
begin
  perform appt_private.assert_server(p_server_key);
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Jeton invalide' using errcode = '22023'; end if;
  perform appt_private.lock();

  -- double clic / nouvel envoi : même clé → même rendez-vous, rien n'est recréé
  select * into v_existing from public.appt_bookings where idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('status', 'existing', 'id', v_existing.id, 'booking_status', v_existing.status);
  end if;

  perform appt_private.sweep();

  select * into t from public.appt_event_types where slug = lower(btrim(p_slug)) and active;
  if not found then raise exception 'Ce type de rendez-vous n''est plus disponible' using errcode = 'P0002'; end if;
  select timezone into v_tz from public.appt_schedules where id = t.schedule_id;

  if v_first is null or v_last is null then raise exception 'Prénom et nom sont obligatoires' using errcode = '22023'; end if;
  if char_length(v_first) > 100 or char_length(v_last) > 100 then raise exception 'Nom trop long' using errcode = '22023'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or char_length(v_email) > 254 then
    raise exception 'Email invalide' using errcode = '22023';
  end if;
  if (t.phone_required or t.location_kind = 'phone') and v_phone is null then
    raise exception 'Le téléphone est obligatoire pour ce rendez-vous' using errcode = '22023';
  end if;
  if not appt_private.valid_tz(v_inv_tz) then v_inv_tz := v_tz; end if;

  for q in select x from jsonb_array_elements(t.questions) x
  loop
    v_val := nullif(btrim(coalesce(p_answers ->> (q ->> 'id'), '')), '');
    if v_val is null and coalesce((q ->> 'required')::boolean, false) then
      raise exception 'Réponse obligatoire : %', q ->> 'label' using errcode = '22023';
    end if;
    if v_val is not null and q ->> 'kind' = 'choice'
       and not exists (select 1 from jsonb_array_elements_text(coalesce(q -> 'options', '[]')) o where o = v_val) then
      raise exception 'Choix invalide : %', q ->> 'label' using errcode = '22023';
    end if;
    if v_val is not null and char_length(v_val) > (case when q ->> 'kind' = 'long' then 5000 else 500 end) then
      raise exception 'Réponse trop longue : %', q ->> 'label' using errcode = '22023';
    end if;
    if v_val is not null then
      v_answers := v_answers || jsonb_build_array(jsonb_build_object('id', q ->> 'id', 'label', q ->> 'label', 'kind', q ->> 'kind', 'value', v_val));
    end if;
  end loop;

  if not exists (select 1 from appt_private.compute_slots(t.id, p_starts_at, p_starts_at + interval '1 minute', p_busy) s
                  where s.slot = p_starts_at) then
    return jsonb_build_object('status', 'unavailable');
  end if;

  v_end := p_starts_at + make_interval(mins => t.duration_min);
  insert into public.appt_bookings (
    id, event_type_id, status, starts_at, ends_at, buffer_before_min, buffer_after_min, schedule_timezone, invitee_timezone,
    first_name, last_name, email, email_norm, phone, company_name, website, answers, event_snapshot, meeting_url,
    idempotency_key, manage_token_hash, calendar_target, hold_expires_at)
  values (
    p_booking_id, t.id, case when v_pending then 'pending' else 'confirmed' end, p_starts_at, v_end,
    t.buffer_before_min, t.buffer_after_min, v_tz, v_inv_tz,
    v_first, v_last, v_email, public.norm_email(v_email), v_phone, v_company, v_website, v_answers,
    jsonb_build_object('name', t.name, 'slug', t.slug, 'description', t.description, 'duration_min', t.duration_min,
                       'location_kind', t.location_kind, 'location_detail', t.location_detail, 'google_meet', t.google_meet),
    t.meeting_url, p_idempotency_key, p_token_hash, v_pending,
    case when v_pending then now() + make_interval(mins => greatest(2, least(p_hold_minutes, 30))) end);

  insert into public.appt_reservations (booking_id, kind, occupied, expires_at)
  values (p_booking_id, 'main',
          tstzrange(p_starts_at - make_interval(mins => t.buffer_before_min), v_end + make_interval(mins => t.buffer_after_min)),
          case when v_pending then now() + make_interval(mins => greatest(2, least(p_hold_minutes, 30))) end);

  perform appt_private.log(p_booking_id, 'created', 'invitee', jsonb_build_object('starts_at', p_starts_at));
  if not v_pending then
    perform appt_private.confirm(p_booking_id, 'system');
  end if;
  return jsonb_build_object('status', case when v_pending then 'pending' else 'confirmed' end, 'id', p_booking_id);
exception
  when exclusion_violation then
    return jsonb_build_object('status', 'unavailable');
end;
$$;

-- Événement Google créé : confirmation définitive (refusée si la retenue a expiré entre-temps)
create or replace function public.appt_confirm_booking(
  p_server_key text, p_id uuid, p_calendar_id text, p_event_id text, p_meeting_url text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare b public.appt_bookings;
begin
  perform appt_private.assert_server(p_server_key);
  perform appt_private.lock();
  select * into b from public.appt_bookings where id = p_id for update;
  if not found then raise exception 'Rendez-vous introuvable' using errcode = 'P0002'; end if;
  if b.status = 'confirmed' then return jsonb_build_object('status', 'confirmed'); end if;
  if b.status <> 'pending' or b.hold_expires_at < now() then
    return jsonb_build_object('status', 'expired');
  end if;
  update public.appt_bookings
     set calendar_id = p_calendar_id, google_event_id = p_event_id, calendar_synced_version = version,
         calendar_sync_error = null, meeting_url = coalesce(meeting_url, nullif(btrim(p_meeting_url), ''))
   where id = p_id;
  perform appt_private.confirm(p_id, 'system');
  return jsonb_build_object('status', 'confirmed');
end;
$$;

-- Échec d'une opération nécessaire : le créneau est libéré, l'historique conservé.
create or replace function public.appt_abandon_booking(p_server_key text, p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.appt_bookings set status = 'failed', version = version + 1, hold_expires_at = null
   where id = p_id and status = 'pending';
  if found then
    update public.appt_reservations set active = false where booking_id = p_id and active;
    perform appt_private.log(p_id, 'failed', 'system', jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));
  end if;
end;
$$;

-- Détail d'un rendez-vous pour son lien privé (et pour le serveur après réservation)
create or replace function public.appt_public_booking(p_server_key text, p_id uuid, p_token_hash text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare b public.appt_bookings;
begin
  perform appt_private.authorize(p_id, p_server_key, p_token_hash);
  select * into b from public.appt_bookings where id = p_id;
  return jsonb_build_object(
    'id', b.id, 'status', b.status, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
    'invitee_timezone', b.invitee_timezone, 'schedule_timezone', b.schedule_timezone,
    'first_name', b.first_name, 'last_name', b.last_name, 'email', b.email,
    'event', b.event_snapshot, 'meeting_url', b.meeting_url, 'version', b.version,
    'cancelled_at', b.cancelled_at, 'cancelled_by', b.cancelled_by,
    'event_active', exists (select 1 from public.appt_event_types t where t.id = b.event_type_id and t.active),
    'slug', (select t.slug from public.appt_event_types t where t.id = b.event_type_id),
    'display_name', (select display_name from public.appt_settings where id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Annulation et report (lien privé ou back-office)
-- ---------------------------------------------------------------------------

create or replace function public.appt_cancel(
  p_id uuid, p_reason text default null, p_server_key text default null, p_token_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := appt_private.authorize(p_id, p_server_key, p_token_hash);
  b public.appt_bookings;
begin
  perform appt_private.lock();
  select * into b from public.appt_bookings where id = p_id for update;
  if b.status = 'cancelled' then return jsonb_build_object('status', 'cancelled', 'already', true); end if;
  if b.status <> 'confirmed' then raise exception 'Ce rendez-vous ne peut pas être annulé' using errcode = '22023'; end if;
  if v_actor = 'invitee' and b.starts_at <= now() then
    raise exception 'Ce rendez-vous est déjà passé' using errcode = '22023';
  end if;
  update public.appt_bookings
     set status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor,
         cancel_reason = nullif(btrim(coalesce(p_reason, '')), ''), version = version + 1
   where id = p_id;
  update public.appt_reservations set active = false where booking_id = p_id and active;
  perform appt_private.log(p_id, 'cancelled', v_actor, jsonb_build_object('reason', nullif(btrim(coalesce(p_reason, '')), '')));
  if b.company_id is not null then
    perform appt_private.crm_note(p_id, b.company_id, b.person_id,
      'Rendez-vous annulé' || case when v_actor = 'invitee' then ' par le contact' else '' end || ' : ' || appt_private.booking_label(b)
      || coalesce(' — motif : ' || nullif(btrim(coalesce(p_reason, '')), ''), ''));
  end if;
  return jsonb_build_object('status', 'cancelled', 'version', b.version + 1);
end;
$$;

-- Report, étape 1 : le nouveau créneau est vérifié et retenu ; l'ancien reste occupé.
create or replace function public.appt_reschedule_begin(
  p_id uuid, p_starts_at timestamptz, p_busy jsonb default '[]', p_server_key text default null, p_token_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := appt_private.authorize(p_id, p_server_key, p_token_hash);
  b public.appt_bookings;
  v_hold uuid;
  v_dur interval;
begin
  perform appt_private.lock();
  perform appt_private.sweep();
  select * into b from public.appt_bookings where id = p_id for update;
  if b.status <> 'confirmed' then raise exception 'Ce rendez-vous ne peut plus être reporté' using errcode = '22023'; end if;
  if v_actor = 'invitee' and b.starts_at <= now() then raise exception 'Ce rendez-vous est déjà passé' using errcode = '22023'; end if;
  if p_starts_at = b.starts_at then raise exception 'Choisissez un autre créneau' using errcode = '22023'; end if;
  if not exists (select 1 from appt_private.compute_slots(b.event_type_id, p_starts_at, p_starts_at + interval '1 minute', p_busy, p_id) s
                  where s.slot = p_starts_at) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_dur := b.ends_at - b.starts_at;
  insert into public.appt_reservations (booking_id, kind, occupied, expires_at)
  values (p_id, 'hold', tstzrange(p_starts_at - make_interval(mins => b.buffer_before_min), p_starts_at + v_dur + make_interval(mins => b.buffer_after_min)),
          now() + interval '10 minutes')
  returning id into v_hold;
  return jsonb_build_object('status', 'held', 'hold_id', v_hold, 'version', b.version,
                            'old_starts_at', b.starts_at, 'old_ends_at', b.ends_at,
                            'starts_at', p_starts_at, 'ends_at', p_starts_at + v_dur);
exception
  when exclusion_violation then
    return jsonb_build_object('status', 'unavailable');
end;
$$;

-- Report, étape 2 : bascule atomique vers le nouveau créneau (après mise à jour de Google).
create or replace function public.appt_reschedule_commit(
  p_id uuid, p_hold_id uuid, p_calendar_synced boolean, p_server_key text default null, p_token_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := appt_private.authorize(p_id, p_server_key, p_token_hash);
  b public.appt_bookings;
  h public.appt_reservations;
  v_start timestamptz;
begin
  perform appt_private.lock();
  select * into b from public.appt_bookings where id = p_id for update;
  select * into h from public.appt_reservations where id = p_hold_id and booking_id = p_id and kind = 'hold' for update;
  if not found or not h.active or h.expires_at < now() or b.status <> 'confirmed' then
    if found then update public.appt_reservations set active = false where id = p_hold_id; end if;
    return jsonb_build_object('status', 'expired');
  end if;
  v_start := lower(h.occupied) + make_interval(mins => b.buffer_before_min);
  update public.appt_reservations set active = false where booking_id = p_id and kind = 'main' and active;
  update public.appt_reservations set kind = 'main', expires_at = null where id = p_hold_id;
  update public.appt_bookings
     set starts_at = v_start, ends_at = v_start + (b.ends_at - b.starts_at), version = version + 1,
         outcome = null,
         calendar_synced_version = case when p_calendar_synced then version + 1 else calendar_synced_version end,
         calendar_sync_error = case when p_calendar_synced then null else calendar_sync_error end
   where id = p_id;
  perform appt_private.log(p_id, 'rescheduled', v_actor, jsonb_build_object('from', b.starts_at, 'to', v_start));
  if b.company_id is not null then
    perform appt_private.crm_note(p_id, b.company_id, b.person_id,
      'Rendez-vous reporté : ' || (b.event_snapshot ->> 'name') || ' du '
      || to_char(b.starts_at at time zone b.schedule_timezone, 'DD/MM/YYYY à HH24"h"MI') || ' au '
      || to_char(v_start at time zone b.schedule_timezone, 'DD/MM/YYYY à HH24"h"MI'));
  end if;
  return jsonb_build_object('status', 'rescheduled', 'version', b.version + 1, 'starts_at', v_start);
end;
$$;

create or replace function public.appt_reschedule_abort(
  p_id uuid, p_hold_id uuid, p_reason text default null, p_server_key text default null, p_token_hash text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_actor text := appt_private.authorize(p_id, p_server_key, p_token_hash);
begin
  update public.appt_reservations set active = false where id = p_hold_id and booking_id = p_id and kind = 'hold' and active;
  if found then
    perform appt_private.log(p_id, 'reschedule_failed', v_actor, jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Synchronisation Google : état attendu = la base. Un rendez-vous dont la version n'a pas été
-- répercutée est repris (création/mise à jour si confirmé, suppression sinon).
-- ---------------------------------------------------------------------------

create or replace function public.appt_mark_calendar(
  p_id uuid, p_version int, p_error text default null, p_event_id text default null, p_calendar_id text default null,
  p_server_key text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  if p_error is null then
    update public.appt_bookings
       set calendar_synced_version = greatest(calendar_synced_version, p_version), calendar_sync_error = null,
           google_event_id = coalesce(p_event_id, google_event_id), calendar_id = coalesce(p_calendar_id, calendar_id)
     where id = p_id;
  else
    update public.appt_bookings set calendar_sync_error = left(p_error, 500), calendar_sync_attempts = calendar_sync_attempts + 1
     where id = p_id;
  end if;
end;
$$;

-- Données complètes d'un rendez-vous pour construire / reprendre son événement Google (serveur uniquement)
create or replace function public.appt_server_booking(p_server_key text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  return (select jsonb_build_object(
             'id', b.id, 'status', b.status, 'version', b.version, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
             'calendar_target', b.calendar_target, 'calendar_id', b.calendar_id, 'google_event_id', b.google_event_id,
             'event', b.event_snapshot, 'first_name', b.first_name, 'last_name', b.last_name, 'email', b.email, 'phone', b.phone,
             'company_name', b.company_name, 'meeting_url', b.meeting_url, 'answers', b.answers,
             'schedule_timezone', b.schedule_timezone, 'invitee_timezone', b.invitee_timezone)
            from public.appt_bookings b where b.id = p_id);
end;
$$;

-- Google peut diverger de la base (compensation impossible après un report refusé) : reprise forcée.
create or replace function public.appt_calendar_resync(p_id uuid, p_error text, p_server_key text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  update public.appt_bookings
     set calendar_synced_version = least(calendar_synced_version, version - 1), calendar_sync_error = left(p_error, 500),
         calendar_sync_attempts = 0
   where id = p_id and calendar_target;
end;
$$;

create or replace function public.appt_calendar_backlog(p_server_key text default null, p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  perform appt_private.lock();
  perform appt_private.sweep();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', b.id, 'status', b.status, 'version', b.version, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
             'calendar_id', b.calendar_id, 'google_event_id', b.google_event_id, 'event', b.event_snapshot,
             'first_name', b.first_name, 'last_name', b.last_name, 'email', b.email, 'phone', b.phone,
             'company_name', b.company_name, 'meeting_url', b.meeting_url, 'answers', b.answers,
             'schedule_timezone', b.schedule_timezone, 'invitee_timezone', b.invitee_timezone)
             order by b.updated_at)
      from (select * from public.appt_bookings
             where calendar_target and calendar_synced_version < version and status <> 'pending'
               and calendar_sync_attempts < 20
             order by updated_at limit greatest(1, least(p_limit, 50))) b), '[]');
end;
$$;

-- Connexion Google : enregistrement (propriétaire) et lecture du jeton chiffré (serveur uniquement)
create or replace function public.appt_save_google_connection(p_email text, p_refresh_token_enc text, p_scopes text, p_calendars jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  insert into public.appt_google_connection (id, google_email, refresh_token_enc, scopes, calendars, check_calendar_ids, destination_calendar_id)
  values (true, p_email, p_refresh_token_enc, p_scopes, coalesce(p_calendars, '[]'),
          coalesce(array(select x ->> 'id' from jsonb_array_elements(coalesce(p_calendars, '[]')) x where (x ->> 'primary')::boolean), '{}'),
          (select x ->> 'id' from jsonb_array_elements(coalesce(p_calendars, '[]')) x where (x ->> 'primary')::boolean limit 1))
  on conflict (id) do update set
    google_email = excluded.google_email, refresh_token_enc = excluded.refresh_token_enc, scopes = excluded.scopes,
    calendars = excluded.calendars, status = 'connected', last_error = null, connected_at = now(),
    -- reconnexion du même compte : les choix précédents sont conservés
    check_calendar_ids = case when public.appt_google_connection.google_email = excluded.google_email
                              then public.appt_google_connection.check_calendar_ids else excluded.check_calendar_ids end,
    destination_calendar_id = case when public.appt_google_connection.google_email = excluded.google_email
                                   then public.appt_google_connection.destination_calendar_id else excluded.destination_calendar_id end;
end;
$$;

create or replace function public.appt_set_google_calendars(p_check text[], p_destination text, p_calendars jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.appt_google_connection
     set check_calendar_ids = coalesce(p_check, '{}'), destination_calendar_id = nullif(btrim(coalesce(p_destination, '')), ''),
         calendars = coalesce(p_calendars, calendars)
   where id;
  if not found then raise exception 'Aucun agenda Google connecté' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.appt_disconnect_google()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  delete from public.appt_google_connection where id;
end;
$$;

create or replace function public.appt_server_google(p_server_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  return (select jsonb_build_object('refresh_token_enc', refresh_token_enc, 'check_calendar_ids', check_calendar_ids,
                                    'destination_calendar_id', destination_calendar_id, 'status', status, 'google_email', google_email)
            from public.appt_google_connection where id);
end;
$$;

create or replace function public.appt_google_status(p_server_key text, p_ok boolean, p_error text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  update public.appt_google_connection
     set status = case when p_ok then 'connected' else 'error' end, last_error = case when p_ok then null else left(p_error, 500) end
   where id and (status is distinct from case when p_ok then 'connected' else 'error' end or last_error is distinct from p_error);
end;
$$;

-- ---------------------------------------------------------------------------
-- Back-office (propriétaire)
-- ---------------------------------------------------------------------------

create or replace function public.appt_set_outcome(p_id uuid, p_outcome text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare b public.appt_bookings;
begin
  perform appt_private.assert_owner_user();
  if p_outcome is not null and p_outcome not in ('done','no_show') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  select * into b from public.appt_bookings where id = p_id for update;
  if not found then raise exception 'Rendez-vous introuvable' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'Seul un rendez-vous confirmé peut être qualifié' using errcode = '22023'; end if;
  if b.starts_at > now() then raise exception 'Ce rendez-vous n''a pas encore eu lieu' using errcode = '22023'; end if;
  if b.outcome is not distinct from p_outcome then return; end if;
  update public.appt_bookings set outcome = p_outcome where id = p_id;
  perform appt_private.log(p_id, 'outcome', 'owner', jsonb_build_object('outcome', p_outcome, 'previous', b.outcome));
  if b.company_id is not null and p_outcome = 'done' and not exists (
       select 1 from public.interactions i where i.company_id = b.company_id and i.kind = 'meeting' and i.meta ->> 'appointment_id' = p_id::text) then
    insert into public.interactions (company_id, person_id, kind, occurred_at, content, content_origin, source, meta)
    values (b.company_id, b.person_id, 'meeting', b.starts_at, 'Rendez-vous réalisé : ' || (b.event_snapshot ->> 'name'),
            'system', 'user', jsonb_build_object('appointment_id', p_id));
  end if;
end;
$$;

create or replace function public.appt_set_note(p_id uuid, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.appt_bookings set internal_note = nullif(btrim(coalesce(p_note, '')), '') where id = p_id;
  if not found then raise exception 'Rendez-vous introuvable' using errcode = 'P0002'; end if;
  perform appt_private.log(p_id, 'note', 'owner');
end;
$$;

-- Rattachement manuel à une fiche. p_person : personne existante de la fiche ; sinon, avec
-- p_add_person, le contact est ajouté à la fiche (ou retrouvé par son email). Rien n'est écrasé.
create or replace function public.appt_link_booking(p_id uuid, p_company uuid, p_person uuid default null, p_add_person boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.appt_bookings;
  v_person uuid := p_person;
begin
  perform appt_private.assert_owner_user();
  select * into b from public.appt_bookings where id = p_id for update;
  if not found then raise exception 'Rendez-vous introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if v_person is not null and not exists (select 1 from public.people where id = v_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;
  if v_person is null then
    select id into v_person from public.people where company_id = p_company and email_norm = b.email_norm limit 1;
  end if;
  if v_person is null and p_add_person then
    insert into public.people (company_id, first_name, last_name, email, phone, is_primary)
    values (p_company, b.first_name, b.last_name, b.email, b.phone, not exists (select 1 from public.people where company_id = p_company))
    returning id into v_person;
  end if;
  update public.appt_bookings set company_id = p_company, person_id = v_person, crm_status = 'linked', crm_candidates = '[]' where id = p_id;
  perform appt_private.log(p_id, 'crm_linked', 'owner', jsonb_build_object('company_id', p_company, 'previous', b.company_id));
  perform appt_private.crm_note(p_id, p_company, v_person, 'Rendez-vous rattaché : ' || appt_private.booking_label(b));
  return jsonb_build_object('company_id', p_company, 'person_id', v_person);
end;
$$;

-- Vue du back-office : un rendez-vous passé confirmé sans qualification est « à renseigner »
create or replace view public.appt_booking_overview with (security_invoker = true) as
  select b.id, b.event_type_id, b.status, b.outcome, b.starts_at, b.ends_at, b.schedule_timezone, b.invitee_timezone,
         b.first_name, b.last_name, b.email, b.phone, b.company_name, b.website, b.answers, b.event_snapshot,
         b.meeting_url, b.company_id, b.person_id, b.crm_status, b.crm_candidates, b.internal_note, b.cancel_reason,
         b.cancelled_by, b.cancelled_at, b.version, b.calendar_target, b.google_event_id,
         (b.calendar_target and b.calendar_synced_version < b.version and b.status <> 'pending') as calendar_out_of_sync,
         b.calendar_sync_error, b.created_at, b.updated_at,
         c.name as crm_company_name,
         case
           when b.status = 'confirmed' and b.outcome is null and b.ends_at <= now() then 'a_renseigner'
           when b.status = 'confirmed' and b.outcome is not null then b.outcome
           when b.status = 'confirmed' then 'a_venir'
           else b.status
         end as display_status
    from public.appt_bookings b
    left join public.companies c on c.id = b.company_id
   where b.status in ('confirmed','cancelled') or (b.status = 'pending' and b.hold_expires_at > now());

-- ---------------------------------------------------------------------------
-- Droits d'exécution
-- Les points d'entrée publics sont appelés par le serveur avec la clé publique (rôle anon) ;
-- ils exigent la clé serveur ou un jeton de rendez-vous. Le reste : propriétaire.
-- ---------------------------------------------------------------------------

revoke all on all functions in schema appt_private from public, anon, authenticated;
revoke all on public.appt_booking_overview from anon;
grant select on public.appt_booking_overview to authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'appt_public_event(text, text)',
    'appt_public_slots(text, text, timestamptz, timestamptz, jsonb, uuid)',
    'appt_server_own_events(text, timestamptz, timestamptz)',
    'appt_book(text, uuid, text, timestamptz, jsonb, jsonb, jsonb, boolean, text, text, int)',
    'appt_confirm_booking(text, uuid, text, text, text)',
    'appt_abandon_booking(text, uuid, text)',
    'appt_public_booking(text, uuid, text)',
    'appt_cancel(uuid, text, text, text)',
    'appt_reschedule_begin(uuid, timestamptz, jsonb, text, text)',
    'appt_reschedule_commit(uuid, uuid, boolean, text, text)',
    'appt_reschedule_abort(uuid, uuid, text, text, text)',
    'appt_mark_calendar(uuid, int, text, text, text, text)',
    'appt_calendar_backlog(text, int)',
    'appt_calendar_resync(uuid, text, text)',
    'appt_server_booking(text, uuid)',
    'appt_server_google(text)',
    'appt_google_status(text, boolean, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array[
    'appt_register_server_key(text)', 'appt_server_key_registered(text)', 'appt_save_schedule(uuid, jsonb)',
    'appt_save_block(uuid, text, date, date, time, time, text)', 'appt_save_google_connection(text, text, text, jsonb)',
    'appt_set_google_calendars(text[], text, jsonb)', 'appt_disconnect_google()',
    'appt_set_outcome(uuid, text)',
    'appt_set_note(uuid, text)', 'appt_link_booking(uuid, uuid, uuid, boolean)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- Planning par défaut (modifiable) : lundi–vendredi, 9 h–12 h et 14 h–18 h, Europe/Paris
with s as (
  insert into public.appt_schedules (name, timezone, is_default) values ('Horaires habituels', 'Europe/Paris', true) returning id
)
insert into public.appt_schedule_rules (schedule_id, weekday, start_time, end_time)
select s.id, d, x.st, x.en from s, generate_series(1, 5) d,
  (values (time '09:00', time '12:00'), (time '14:00', time '18:00')) x(st, en);


-- ===== 20261105130000_rendez_vous_rappels.sql =====
-- Rendez-vous, phase 2 : règles de rappel et échéances par rendez-vous.
-- Ce module calcule QUAND et QUOI rappeler. Il n'envoie rien : la file d'envoi, la livraison et
-- l'historique des emails appartiennent au module Mail (contrat : docs/integrations/appointments-mail.md).
-- Migration additive.

-- ---------------------------------------------------------------------------
-- Réglages
-- ---------------------------------------------------------------------------

alter table public.appt_settings
  add column reminders_paused boolean not null default false,
  -- renseigné par le module Mail lors de son raccordement : aucune échéance antérieure n'est jamais envoyée
  add column mail_connected_at timestamptz;
grant select (reminders_paused, mail_connected_at) on public.appt_settings to authenticated;
grant update (reminders_paused) on public.appt_settings to authenticated;

alter table public.appt_event_types add column reminders_enabled boolean not null default false;

-- Désactivation des rappels pour un seul rendez-vous (réversible, sans perte de configuration)
alter table public.appt_bookings add column reminders_off boolean not null default false;

-- ---------------------------------------------------------------------------
-- Règles (modèle global, par type de rendez-vous). Délais exacts avant le début.
-- ---------------------------------------------------------------------------

create table public.appt_reminder_rules (
  id uuid primary key default gen_random_uuid(),
  event_type_id uuid not null references public.appt_event_types (id) on delete cascade,
  position int not null default 0,
  enabled boolean not null default true,
  offset_value int not null check (offset_value between 1 and 10000),
  offset_unit text not null check (offset_unit in ('days','hours','minutes')),
  offset_minutes int generated always as (
    offset_value * case offset_unit when 'days' then 1440 when 'hours' then 60 else 1 end) stored,
  subject text not null check (char_length(btrim(subject)) between 1 and 200),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (offset_value * case offset_unit when 'days' then 1440 when 'hours' then 60 else 1 end between 5 and 43200)
);
create index appt_reminder_rules_type_idx on public.appt_reminder_rules (event_type_id, position);

-- ---------------------------------------------------------------------------
-- Rappels d'un rendez-vous (échéancier). Une ligne = un rappel pour UNE version du rendez-vous.
-- reminder_key : identifiant stable du rappel (conservé lors d'un report).
-- dedup_key    : un seul envoi possible par rappel et par version du rendez-vous.
-- revision     : incrémentée à chaque modification locale ; le module Mail la revérifie avant d'envoyer.
-- status       : scheduled → sent | failed (posés par le module Mail uniquement)
--                scheduled → cancelled (annulation du rdv, ou choix explicite) | superseded (report, réapplication)
-- ---------------------------------------------------------------------------

create table public.appt_reminders (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.appt_bookings (id) on delete cascade,
  reminder_key uuid not null default gen_random_uuid(),
  rule_id uuid references public.appt_reminder_rules (id) on delete set null,
  origin text not null check (origin in ('rule','custom')),
  customized boolean not null default false,
  booking_version int not null,
  offset_value int not null check (offset_value between 1 and 10000),
  offset_unit text not null check (offset_unit in ('days','hours','minutes')),
  offset_minutes int not null check (offset_minutes between 5 and 43200),
  send_at timestamptz not null,
  subject text not null check (char_length(subject) between 1 and 200),
  body text not null check (char_length(body) between 1 and 5000),
  status text not null default 'scheduled' check (status in ('scheduled','sent','failed','cancelled','superseded')),
  status_reason text,
  revision int not null default 1,
  dedup_key text generated always as ('appt-reminder:' || reminder_key::text || ':v' || booking_version::text) stored,
  mail_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index appt_reminders_dedup_uniq on public.appt_reminders (dedup_key);
create index appt_reminders_booking_idx on public.appt_reminders (booking_id, send_at);
create index appt_reminders_due_idx on public.appt_reminders (send_at) where status = 'scheduled';

do $$
declare t text;
begin
  foreach t in array array['appt_reminder_rules','appt_reminders']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
-- règles : écriture directe par le propriétaire ; rappels : uniquement par les fonctions ci-dessous
create policy owner_insert on public.appt_reminder_rules for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = 'user');
create policy owner_update on public.appt_reminder_rules for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = 'user') with check ((select public.is_app_owner()));
create policy owner_delete on public.appt_reminder_rules for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke insert, update, delete on public.appt_reminders from authenticated;

create or replace function appt_private.offset_minutes(p_value int, p_unit text)
returns int
language sql
immutable
set search_path = ''
as $$ select p_value * case p_unit when 'days' then 1440 when 'hours' then 60 when 'minutes' then 1 end; $$;

-- ---------------------------------------------------------------------------
-- Génération : uniquement les échéances encore futures (une réservation tardive ne déclenche
-- jamais un rappel déjà dépassé).
-- ---------------------------------------------------------------------------

create or replace function appt_private.generate_reminders(p_booking uuid)
returns int
language plpgsql
set search_path = ''
as $$
declare
  b public.appt_bookings;
  n int;
begin
  select * into b from public.appt_bookings where id = p_booking;
  if b.status <> 'confirmed' then return 0; end if;
  insert into public.appt_reminders (booking_id, rule_id, origin, booking_version, offset_value, offset_unit, offset_minutes, send_at, subject, body)
  select b.id, r.id, 'rule', b.version, r.offset_value, r.offset_unit, r.offset_minutes,
         b.starts_at - make_interval(mins => r.offset_minutes), r.subject, r.body
    from public.appt_reminder_rules r
    join public.appt_event_types t on t.id = r.event_type_id
   where r.event_type_id = b.event_type_id and r.enabled and t.reminders_enabled
     and b.starts_at - make_interval(mins => r.offset_minutes) > now()
   order by r.position;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Report : chaque rappel conserve sa configuration (y compris personnalisée) et est recalculé sur le
-- nouvel horaire ; l'ancienne version est invalidée ; les rappels envoyés restent dans l'historique ;
-- un rappel annulé explicitement n'est pas recréé.
create or replace function appt_private.recalculate_reminders(p_booking uuid, p_old_version int)
returns void
language plpgsql
set search_path = ''
as $$
declare b public.appt_bookings;
begin
  select * into b from public.appt_bookings where id = p_booking;
  with latest as (
    select distinct on (reminder_key) *
      from public.appt_reminders
     where booking_id = p_booking and booking_version <= p_old_version
     order by reminder_key, booking_version desc, created_at desc
  )
  insert into public.appt_reminders (booking_id, reminder_key, rule_id, origin, customized, booking_version, offset_value, offset_unit,
                                     offset_minutes, send_at, subject, body)
  select b.id, l.reminder_key, l.rule_id, l.origin, l.customized, b.version, l.offset_value, l.offset_unit, l.offset_minutes,
         b.starts_at - make_interval(mins => l.offset_minutes), l.subject, l.body
    from latest l
   where l.status in ('scheduled','sent','failed','superseded')
     and not (l.status = 'superseded' and l.status_reason = 'Règles réappliquées')
     and b.starts_at - make_interval(mins => l.offset_minutes) > now()
  on conflict (dedup_key) do nothing;
  update public.appt_reminders
     set status = 'superseded', status_reason = 'Rendez-vous reporté', revision = revision + 1
   where booking_id = p_booking and status = 'scheduled' and booking_version < b.version;
end;
$$;

create or replace function appt_private.tg_booking_reminders()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'confirmed' and old.status is distinct from 'confirmed' then
    perform appt_private.generate_reminders(new.id);
  elsif new.status <> 'confirmed' and old.status = 'confirmed' then
    update public.appt_reminders
       set status = 'cancelled', status_reason = 'Rendez-vous annulé', revision = revision + 1
     where booking_id = new.id and status = 'scheduled';
  elsif new.status = 'confirmed' and new.starts_at is distinct from old.starts_at then
    perform appt_private.recalculate_reminders(new.id, old.version);
  end if;
  return null;
end;
$$;
create trigger appt_booking_reminders after update of status, starts_at on public.appt_bookings
  for each row execute function appt_private.tg_booking_reminders();
-- réservation confirmée dès l'insertion (sans agenda de destination) : la confirmation passe par
-- appt_private.confirm, qui fait un update (status déjà confirmé) ; on génère donc aussi à l'insertion
create or replace function appt_private.tg_booking_reminders_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'confirmed' then perform appt_private.generate_reminders(new.id); end if;
  return null;
end;
$$;
create trigger appt_booking_reminders_insert after insert on public.appt_bookings
  for each row execute function appt_private.tg_booking_reminders_insert();

-- ---------------------------------------------------------------------------
-- Règles d'un type : enregistrement complet (identifiants conservés)
-- p_rules : [{id?, enabled, offset_value, offset_unit, subject, body}]
-- ---------------------------------------------------------------------------

create or replace function public.appt_save_reminder_rules(p_type uuid, p_enabled boolean, p_rules jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  i int := 0;
  v_keep uuid[] := '{}';
  v_id uuid;
begin
  perform appt_private.assert_owner_user();
  if not exists (select 1 from public.appt_event_types where id = p_type) then
    raise exception 'Type de rendez-vous introuvable' using errcode = 'P0002';
  end if;
  if jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules) > 10 then
    raise exception '10 rappels maximum' using errcode = '22023';
  end if;
  update public.appt_event_types set reminders_enabled = coalesce(p_enabled, false) where id = p_type;
  for r in select x from jsonb_array_elements(p_rules) x
  loop
    i := i + 1;
    v_id := nullif(r ->> 'id', '')::uuid;
    if v_id is not null and exists (select 1 from public.appt_reminder_rules where id = v_id and event_type_id = p_type) then
      update public.appt_reminder_rules
         set position = i, enabled = coalesce((r ->> 'enabled')::boolean, true), offset_value = (r ->> 'offset_value')::int,
             offset_unit = r ->> 'offset_unit', subject = btrim(r ->> 'subject'), body = btrim(r ->> 'body')
       where id = v_id;
    else
      insert into public.appt_reminder_rules (event_type_id, position, enabled, offset_value, offset_unit, subject, body)
      values (p_type, i, coalesce((r ->> 'enabled')::boolean, true), (r ->> 'offset_value')::int, r ->> 'offset_unit',
              btrim(r ->> 'subject'), btrim(r ->> 'body'))
      returning id into v_id;
    end if;
    v_keep := v_keep || v_id;
  end loop;
  -- les rappels déjà programmés gardent leur copie : supprimer une règle ne les touche pas
  delete from public.appt_reminder_rules where event_type_id = p_type and not (id = any (v_keep));
end;
$$;

-- ---------------------------------------------------------------------------
-- Personnalisation d'un rendez-vous (ne modifie jamais le modèle global)
-- ---------------------------------------------------------------------------

create or replace function appt_private.assert_editable(p_reminder uuid)
returns public.appt_reminders
language plpgsql
set search_path = ''
as $$
declare r public.appt_reminders;
begin
  select * into r from public.appt_reminders where id = p_reminder for update;
  if not found then raise exception 'Rappel introuvable' using errcode = 'P0002'; end if;
  if r.status <> 'scheduled' or r.send_at <= now() then
    raise exception 'Ce rappel n''est plus modifiable (déjà passé, envoyé ou annulé)' using errcode = '22023';
  end if;
  return r;
end;
$$;

create or replace function public.appt_reminder_update(p_id uuid, p_offset_value int, p_offset_unit text, p_subject text, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.appt_reminders;
  b public.appt_bookings;
  v_min int := appt_private.offset_minutes(p_offset_value, p_offset_unit);
begin
  perform appt_private.assert_owner_user();
  r := appt_private.assert_editable(p_id);
  select * into b from public.appt_bookings where id = r.booking_id;
  if v_min is null or v_min not between 5 and 43200 then raise exception 'Délai invalide (5 minutes à 30 jours)' using errcode = '22023'; end if;
  if b.starts_at - make_interval(mins => v_min) <= now() then
    raise exception 'Cette échéance est déjà passée : choisissez un délai plus court' using errcode = '22023';
  end if;
  update public.appt_reminders
     set offset_value = p_offset_value, offset_unit = p_offset_unit, offset_minutes = v_min,
         send_at = b.starts_at - make_interval(mins => v_min), subject = btrim(p_subject), body = btrim(p_body),
         customized = true, revision = revision + 1
   where id = p_id;
end;
$$;

create or replace function public.appt_reminder_cancel(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  perform appt_private.assert_editable(p_id);
  update public.appt_reminders set status = 'cancelled', status_reason = 'Annulé manuellement', revision = revision + 1 where id = p_id;
end;
$$;

create or replace function public.appt_reminder_add(p_booking uuid, p_offset_value int, p_offset_unit text, p_subject text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.appt_bookings;
  v_min int := appt_private.offset_minutes(p_offset_value, p_offset_unit);
  v_id uuid;
begin
  perform appt_private.assert_owner_user();
  select * into b from public.appt_bookings where id = p_booking;
  if not found or b.status <> 'confirmed' then raise exception 'Rendez-vous non confirmé' using errcode = '22023'; end if;
  if v_min is null or v_min not between 5 and 43200 then raise exception 'Délai invalide (5 minutes à 30 jours)' using errcode = '22023'; end if;
  if b.starts_at - make_interval(mins => v_min) <= now() then
    raise exception 'Cette échéance est déjà passée' using errcode = '22023';
  end if;
  insert into public.appt_reminders (booking_id, origin, customized, booking_version, offset_value, offset_unit, offset_minutes, send_at, subject, body)
  values (b.id, 'custom', true, b.version, p_offset_value, p_offset_unit, v_min, b.starts_at - make_interval(mins => v_min), btrim(p_subject), btrim(p_body))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.appt_booking_reminders_off(p_booking uuid, p_off boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.appt_bookings set reminders_off = coalesce(p_off, false) where id = p_booking;
  if not found then raise exception 'Rendez-vous introuvable' using errcode = 'P0002'; end if;
  insert into public.appt_booking_events (booking_id, kind, actor, data)
  values (p_booking, 'reminders', 'owner', jsonb_build_object('off', p_off));
end;
$$;

-- Réapplication explicite des règles actuelles à un rendez-vous existant : aperçu, puis application.
create or replace function public.appt_reapply_rules_preview(p_booking uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare b public.appt_bookings;
begin
  perform appt_private.assert_owner_user();
  select * into b from public.appt_bookings where id = p_booking;
  return jsonb_build_object(
    'removed', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'send_at', send_at, 'subject', subject, 'customized', customized) order by send_at)
                           from public.appt_reminders where booking_id = p_booking and status = 'scheduled' and send_at > now()), '[]'),
    'added', coalesce((select jsonb_agg(jsonb_build_object('send_at', b.starts_at - make_interval(mins => r.offset_minutes), 'subject', r.subject) order by r.position)
                         from public.appt_reminder_rules r join public.appt_event_types t on t.id = r.event_type_id
                        where r.event_type_id = b.event_type_id and r.enabled and t.reminders_enabled
                          and b.starts_at - make_interval(mins => r.offset_minutes) > now()), '[]'),
    'skipped_past', coalesce((select count(*) from public.appt_reminder_rules r join public.appt_event_types t on t.id = r.event_type_id
                               where r.event_type_id = b.event_type_id and r.enabled and t.reminders_enabled
                                 and b.starts_at - make_interval(mins => r.offset_minutes) <= now()), 0));
end;
$$;

create or replace function public.appt_reapply_rules(p_booking uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare b public.appt_bookings;
begin
  perform appt_private.assert_owner_user();
  select * into b from public.appt_bookings where id = p_booking for update;
  if b.status <> 'confirmed' or b.starts_at <= now() then raise exception 'Seul un rendez-vous à venir peut être mis à jour' using errcode = '22023'; end if;
  -- anciens rappels invalidés ; les nouveaux ont de nouvelles clés (donc de nouvelles clés de déduplication)
  update public.appt_reminders set status = 'superseded', status_reason = 'Règles réappliquées', revision = revision + 1
   where booking_id = p_booking and status = 'scheduled';
  insert into public.appt_booking_events (booking_id, kind, actor, data) values (p_booking, 'reminders_reapplied', 'owner', '{}');
  return appt_private.generate_reminders(p_booking);
end;
$$;

-- Aperçu en masse pour un type : rendez-vous à venir dont les rappels diffèrent des règles actuelles
create or replace function public.appt_type_reapply_preview(p_type uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'starts_at', b.starts_at, 'name', b.first_name || ' ' || b.last_name,
                                        'customized', exists (select 1 from public.appt_reminders r where r.booking_id = b.id and r.customized and r.status = 'scheduled'))
                     order by b.starts_at)
      from public.appt_bookings b
     where b.event_type_id = p_type and b.status = 'confirmed' and b.starts_at > now()), '[]');
end;
$$;

-- ---------------------------------------------------------------------------
-- Interface avec le module Mail (voir docs/integrations/appointments-mail.md)
-- ---------------------------------------------------------------------------

-- Raccordement : à appeler UNE fois par le module Mail quand l'envoi devient opérationnel.
-- Toute échéance antérieure à cet instant n'est jamais envoyée (pas de stock d'anciens rappels).
create or replace function public.appt_mail_connect(p_server_key text default null)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare v timestamptz;
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  update public.appt_settings set mail_connected_at = coalesce(mail_connected_at, now()) where id returning mail_connected_at into v;
  return v;
end;
$$;

create or replace function public.appt_mail_disconnect()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.appt_settings set mail_connected_at = null where id;
end;
$$;

-- Rappels à remettre au module Mail : programmés, échéance atteinte dans la fenêtre de validité
-- (p_grace_minutes, 15 min par défaut), envoi raccordé avant l'échéance, pas de suspension globale,
-- rappels du rendez-vous actifs, rendez-vous confirmé, version courante, rendez-vous pas encore commencé.
create or replace function public.appt_mail_due_reminders(p_server_key text default null, p_limit int default 50, p_grace_minutes int default 15)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  return coalesce((
    select jsonb_agg(x order by x ->> 'send_at')
      from (
        select jsonb_build_object(
                 'reminder_id', r.id, 'reminder_key', r.reminder_key, 'dedup_key', r.dedup_key, 'revision', r.revision,
                 'send_at', r.send_at, 'subject', r.subject, 'body', r.body, 'offset_minutes', r.offset_minutes,
                 'booking_id', b.id, 'booking_version', b.version, 'starts_at', b.starts_at, 'ends_at', b.ends_at,
                 'invitee_timezone', b.invitee_timezone, 'first_name', b.first_name, 'last_name', b.last_name, 'email', b.email,
                 'company_name', coalesce(c.name, b.company_name), 'meeting_url', b.meeting_url, 'event', b.event_snapshot,
                 'company_id', b.company_id, 'person_id', b.person_id) as x
          from public.appt_reminders r
          join public.appt_bookings b on b.id = r.booking_id
          left join public.companies c on c.id = b.company_id
          cross join public.appt_settings s
         where s.id and r.status = 'scheduled' and not s.reminders_paused and s.mail_connected_at is not null
           and r.send_at <= now() and r.send_at > now() - make_interval(mins => greatest(1, least(p_grace_minutes, 120)))
           and r.send_at >= s.mail_connected_at
           and b.status = 'confirmed' and not b.reminders_off and r.booking_version = b.version and b.starts_at > now()
         order by r.send_at
         limit greatest(1, least(p_limit, 200))) q), '[]');
end;
$$;

-- Validité d'un rappel juste avant l'envoi (le module Mail doit l'appeler au dernier moment)
create or replace function public.appt_mail_reminder_valid(p_reminder uuid, p_revision int, p_server_key text default null)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  return exists (
    select 1 from public.appt_reminders r join public.appt_bookings b on b.id = r.booking_id cross join public.appt_settings s
     where r.id = p_reminder and r.revision = p_revision and r.status = 'scheduled' and s.id and not s.reminders_paused
       and s.mail_connected_at is not null and r.send_at >= s.mail_connected_at
       and b.status = 'confirmed' and not b.reminders_off and r.booking_version = b.version and b.starts_at > now());
end;
$$;

-- Résultat de l'envoi : seul le module Mail l'appelle. Refusé si le rappel a changé entre-temps.
create or replace function public.appt_mail_mark_reminder(
  p_reminder uuid, p_revision int, p_status text, p_message_id text default null, p_error text default null, p_server_key text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  if p_status not in ('sent','failed') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  update public.appt_reminders
     set status = p_status, mail_message_id = p_message_id, status_reason = left(p_error, 500),
         sent_at = case when p_status = 'sent' then now() end
   where id = p_reminder and revision = p_revision and status = 'scheduled';
  return found;
end;
$$;

-- Événements de rendez-vous pour le module Mail (confirmation, report, annulation) : lecture par curseur
create or replace function public.appt_mail_events(p_after bigint default 0, p_limit int default 100, p_server_key text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('event_id', e.id, 'kind', e.kind, 'actor', e.actor, 'created_at', e.created_at, 'data', e.data,
                                        'booking_id', b.id, 'booking_version', b.version, 'status', b.status, 'starts_at', b.starts_at,
                                        'email', b.email, 'company_id', b.company_id, 'person_id', b.person_id) order by e.id)
      from (select * from public.appt_booking_events where id > coalesce(p_after, 0) and kind in ('confirmed','rescheduled','cancelled')
             order by id limit greatest(1, least(p_limit, 500))) e
      join public.appt_bookings b on b.id = e.booking_id), '[]');
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------

revoke all on all functions in schema appt_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'appt_save_reminder_rules(uuid, boolean, jsonb)', 'appt_reminder_update(uuid, int, text, text, text)', 'appt_reminder_cancel(uuid)',
    'appt_reminder_add(uuid, int, text, text, text)', 'appt_booking_reminders_off(uuid, boolean)', 'appt_reapply_rules_preview(uuid)',
    'appt_reapply_rules(uuid)', 'appt_type_reapply_preview(uuid)', 'appt_mail_disconnect()']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'appt_mail_connect(text)', 'appt_mail_due_reminders(text, int, int)', 'appt_mail_reminder_valid(uuid, int, text)',
    'appt_mail_mark_reminder(uuid, int, text, text, text, text)', 'appt_mail_events(bigint, int, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;


-- ===== 20261106000100_mail.sql =====
-- Système mail partagé : comptes expéditeurs, jetons chiffrés, messages et leurs états.
-- Aucun module n'appelle Gmail directement : tout passe par src/lib/mail/service.ts.
-- Le connecteur Claude n'a aucun accès à ces tables (ni lecture, ni envoi).

create table public.mail_accounts (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'gmail' check (provider in ('gmail')),
  email text not null check (char_length(email) between 3 and 320),
  display_name text check (display_name is null or char_length(display_name) <= 200),
  -- connected : envois possibles ; needs_reconnect : accès refusé par Google ; disconnected : déconnecté
  status text not null default 'connected' check (status in ('connected', 'needs_reconnect', 'disconnected')),
  is_default boolean not null default false,
  scopes text[] not null default '{}',
  signature text not null default '' check (char_length(signature) <= 5000),
  last_error text,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index mail_accounts_email_idx on public.mail_accounts (provider, lower(email));
create unique index mail_accounts_one_default_idx on public.mail_accounts ((true)) where is_default;
create trigger set_updated_at before update on public.mail_accounts
  for each row execute function public.tg_set_updated_at();

-- Séparée des comptes : les jetons, chiffrés par l'application, ne sont jamais lus par une liste.
create table public.mail_account_secrets (
  account_id uuid primary key references public.mail_accounts (id) on delete cascade,
  refresh_token_enc text not null,
  access_token_enc text,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.mail_account_secrets
  for each row execute function public.tg_set_updated_at();

create table public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.mail_accounts (id) on delete restrict,
  -- draft : brouillon ; pending : en attente ; sending : en cours ; accepted : accepté par Gmail
  -- (pas « livré » ni « lu ») ; failed : échec certain ; uncertain : résultat inconnu ; cancelled : annulé
  status text not null default 'draft' check (status in ('draft', 'pending', 'sending', 'accepted', 'failed', 'uncertain', 'cancelled')),
  origin text not null default 'manual' check (origin in ('manual', 'prospection', 'appointment', 'system')),
  company_id uuid references public.companies (id) on delete restrict,
  person_id uuid references public.people (id) on delete set null,
  to_addrs text[] not null default '{}',
  cc_addrs text[] not null default '{}',
  bcc_addrs text[] not null default '{}',
  subject text not null default '' check (char_length(subject) <= 500),
  body_text text not null default '' check (char_length(body_text) <= 200000),
  body_html text check (body_html is null or char_length(body_html) <= 500000),
  signature text not null default '' check (char_length(signature) <= 5000),
  in_reply_to text,
  references_hdr text,
  provider_thread_id text,
  provider_message_id text,
  dedupe_key text check (dedupe_key is null or char_length(dedupe_key) between 1 and 200),
  business_type text,
  business_id text,
  scheduled_at timestamptz,
  claimed_at timestamptz,
  sent_at timestamptz,
  error_code text,
  last_error text,
  attempts integer not null default 0,
  interaction_id uuid references public.interactions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index mail_messages_dedupe_idx on public.mail_messages (dedupe_key) where dedupe_key is not null;
create unique index mail_messages_provider_idx on public.mail_messages (account_id, provider_message_id) where provider_message_id is not null;
create index mail_messages_company_idx on public.mail_messages (company_id, updated_at desc) where company_id is not null;
create index mail_messages_status_idx on public.mail_messages (status, updated_at desc);
create trigger set_updated_at before update on public.mail_messages
  for each row execute function public.tg_set_updated_at();

-- Pièces jointes : références vers les fichiers de la fiche (aucun second stockage).
-- Le nom et la taille sont conservés pour l'historique si le fichier est supprimé plus tard.
create table public.mail_attachments (
  mail_id uuid not null references public.mail_messages (id) on delete cascade,
  file_id uuid references public.company_files (id) on delete set null,
  name text not null,
  mime_type text not null,
  size_bytes bigint not null,
  position integer not null default 0,
  id uuid primary key default gen_random_uuid()
);
create index mail_attachments_mail_idx on public.mail_attachments (mail_id, position);
create index mail_attachments_file_idx on public.mail_attachments (file_id) where file_id is not null;

-- ---------------------------------------------------------------------------
-- États : un brouillon ne devient jamais « accepté » sans passer par un envoi réel
-- ---------------------------------------------------------------------------
create or replace function public.tg_mail_messages_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status not in ('draft', 'pending') then
      raise exception 'Un message commence comme brouillon ou en attente.' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.status <> old.status and not (
       (old.status = 'draft' and new.status in ('pending', 'sending', 'cancelled'))
    or (old.status = 'pending' and new.status in ('sending', 'cancelled', 'failed'))
    or (old.status = 'sending' and new.status in ('accepted', 'failed', 'uncertain'))
    or (old.status = 'uncertain' and new.status in ('accepted', 'failed'))
    or (old.status = 'failed' and new.status in ('draft', 'cancelled'))
  ) then
    raise exception 'Changement d''état interdit : % vers %.', old.status, new.status using errcode = 'P0001';
  end if;
  if old.status <> 'draft' and new.status <> 'draft' and (
       new.to_addrs is distinct from old.to_addrs or new.cc_addrs is distinct from old.cc_addrs
    or new.bcc_addrs is distinct from old.bcc_addrs or new.subject is distinct from old.subject
    or new.body_text is distinct from old.body_text or new.body_html is distinct from old.body_html
  ) then
    raise exception 'Ce message n''est plus un brouillon : il ne peut pas être modifié.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger mail_messages_guard before insert or update on public.mail_messages
  for each row execute function public.tg_mail_messages_guard();

-- Une fusion de fiches conserve les emails
create or replace function public.tg_companies_merge_mail()
returns trigger
language plpgsql
as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.mail_messages set company_id = new.merged_into_id where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger companies_merge_mail after update of merged_into_id on public.companies
  for each row execute function public.tg_companies_merge_mail();

-- ---------------------------------------------------------------------------
-- Droits : propriétaire uniquement, jamais le connecteur Claude
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['mail_accounts', 'mail_account_secrets', 'mail_messages', 'mail_attachments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated
      using ((select public.is_app_owner()) and public.current_actor() = ''user'')
      with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Comptes
-- ---------------------------------------------------------------------------
create or replace function public.mail_connect(p_email text, p_name text, p_scopes text[], p_refresh_enc text, p_access_enc text, p_expires timestamptz)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Connexion Gmail');
  update public.mail_accounts set is_default = false where is_default and lower(email) <> lower(p_email);
  insert into public.mail_accounts (email, display_name, scopes, status, is_default, connected_at)
  values (lower(p_email), p_name, p_scopes, 'connected', true, now())
  on conflict (provider, lower(email)) do update
    set display_name = excluded.display_name, scopes = excluded.scopes, status = 'connected', is_default = true,
        last_error = null, connected_at = now(), disconnected_at = null
  returning id into v_id;
  insert into public.mail_account_secrets (account_id, refresh_token_enc, access_token_enc, access_token_expires_at)
  values (v_id, p_refresh_enc, p_access_enc, p_expires)
  on conflict (account_id) do update
    set refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
        access_token_expires_at = excluded.access_token_expires_at;
  return v_id;
end;
$$;

-- Les envois s'arrêtent dès cet appel : mail_claim exige un compte connecté. Les messages en attente
-- ne partent pas tout seuls à la reconnexion : ils sont annulés et restent consultables.
create or replace function public.mail_disconnect(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Déconnexion Gmail');
  delete from public.mail_account_secrets where account_id = p_id;
  update public.mail_accounts set status = 'disconnected', is_default = false, disconnected_at = now() where id = p_id;
  if not found then raise exception 'Compte introuvable.' using errcode = 'P0001'; end if;
  update public.mail_messages
     set status = 'cancelled', error_code = 'disconnected', last_error = 'Annulé : compte Gmail déconnecté.'
   where account_id = p_id and status = 'pending';
end;
$$;

create or replace function public.mail_account_secret(p_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('refresh_token_enc', s.refresh_token_enc, 'access_token_enc', s.access_token_enc, 'access_token_expires_at', s.access_token_expires_at)
    from public.mail_account_secrets s
    join public.mail_accounts a on a.id = s.account_id
   where s.account_id = p_id and a.status = 'connected';
$$;

create or replace function public.mail_store_access(p_id uuid, p_access_enc text, p_expires timestamptz, p_refresh_enc text default null)
returns void
language sql
as $$
  update public.mail_account_secrets
     set access_token_enc = p_access_enc, access_token_expires_at = p_expires,
         refresh_token_enc = coalesce(p_refresh_enc, refresh_token_enc)
   where account_id = p_id;
$$;

-- Google refuse l'accès (révocation, expiration) : plus aucun envoi jusqu'à la reconnexion.
create or replace function public.mail_mark_reconnect(p_id uuid, p_error text)
returns void
language plpgsql
as $$
begin
  delete from public.mail_account_secrets where account_id = p_id;
  update public.mail_accounts set status = 'needs_reconnect', last_error = left(p_error, 500) where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------
create or replace function public.mail_row(p_id uuid)
returns jsonb
language sql
stable
as $$
  select to_jsonb(m) || jsonb_build_object('attachments', coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'file_id', a.file_id, 'name', a.name, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes) order by a.position)
      from public.mail_attachments a where a.mail_id = m.id), '[]'::jsonb))
    from public.mail_messages m where m.id = p_id;
$$;

create or replace function public.mail_replace_attachments(p_mail uuid, p_company uuid, p_file_ids uuid[])
returns void
language plpgsql
as $$
declare v_found int;
begin
  delete from public.mail_attachments where mail_id = p_mail;
  if coalesce(array_length(p_file_ids, 1), 0) = 0 then return; end if;
  select count(*) into v_found from public.company_files f
   where f.id = any (p_file_ids) and f.company_id = p_company and f.status = 'ready';
  if v_found <> (select count(distinct x) from unnest(p_file_ids) x) then
    raise exception 'Pièce jointe indisponible sur cette fiche.' using errcode = 'P0001';
  end if;
  insert into public.mail_attachments (mail_id, file_id, name, mime_type, size_bytes, position)
  select p_mail, f.id, f.display_name, f.mime_type, f.size_bytes, array_position(p_file_ids, f.id)
    from public.company_files f where f.id = any (p_file_ids);
end;
$$;

-- Enregistre un brouillon. L'identifiant vient du client : un second enregistrement met à jour,
-- il ne crée jamais de doublon. Refusé dès que le message n'est plus un brouillon.
create or replace function public.mail_save_draft(p_id uuid, p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_status text;
  v_company uuid := nullif(p ->> 'company_id', '')::uuid;
  arr text[];
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Brouillon d''email');
  select status into v_status from public.mail_messages where id = p_id for update;
  if v_status is not null and v_status <> 'draft' then
    raise exception 'Ce message n''est plus un brouillon.' using errcode = 'P0001';
  end if;
  insert into public.mail_messages (id, account_id, company_id, person_id, to_addrs, cc_addrs, bcc_addrs, subject, body_text, signature, in_reply_to, references_hdr, provider_thread_id)
  values (p_id,
    nullif(p ->> 'account_id', '')::uuid, v_company, nullif(p ->> 'person_id', '')::uuid,
    array(select jsonb_array_elements_text(coalesce(p -> 'to', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'cc', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'bcc', '[]'))),
    coalesce(p ->> 'subject', ''), coalesce(p ->> 'body', ''), coalesce(p ->> 'signature', ''),
    p ->> 'in_reply_to', p ->> 'references', p ->> 'thread_id')
  on conflict (id) do update set
    account_id = excluded.account_id, person_id = excluded.person_id, to_addrs = excluded.to_addrs,
    cc_addrs = excluded.cc_addrs, bcc_addrs = excluded.bcc_addrs, subject = excluded.subject,
    body_text = excluded.body_text, signature = excluded.signature;
  if p ? 'file_ids' then
    select array(select jsonb_array_elements_text(p -> 'file_ids')) into arr;
    perform public.mail_replace_attachments(p_id, v_company, arr::uuid[]);
  end if;
  return public.mail_row(p_id);
end;
$$;

-- Point d'entrée des modules. La clé de déduplication empêche de créer deux fois le même envoi.
create or replace function public.mail_enqueue(p jsonb)
returns jsonb
language plpgsql
as $$
declare
  v_id uuid;
  v_key text := nullif(p ->> 'dedupe_key', '');
  v_company uuid := nullif(p ->> 'company_id', '')::uuid;
  arr text[];
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Envoi d''email');
  if v_key is not null then
    select id into v_id from public.mail_messages where dedupe_key = v_key;
    if found then return public.mail_row(v_id) || jsonb_build_object('duplicate', true); end if;
  end if;
  insert into public.mail_messages (account_id, status, origin, company_id, person_id, to_addrs, cc_addrs, bcc_addrs, subject, body_text, body_html, signature, in_reply_to, references_hdr, provider_thread_id, dedupe_key, business_type, business_id, scheduled_at)
  values (
    (p ->> 'account_id')::uuid, 'pending', coalesce(p ->> 'origin', 'system'), v_company, nullif(p ->> 'person_id', '')::uuid,
    array(select jsonb_array_elements_text(coalesce(p -> 'to', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'cc', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'bcc', '[]'))),
    coalesce(p ->> 'subject', ''), coalesce(p ->> 'body', ''), p ->> 'html', coalesce(p ->> 'signature', ''),
    p ->> 'in_reply_to', p ->> 'references', p ->> 'thread_id', v_key, p ->> 'business_type', p ->> 'business_id',
    (p ->> 'scheduled_at')::timestamptz)
  returning id into v_id;
  if p ? 'file_ids' then
    select array(select jsonb_array_elements_text(p -> 'file_ids')) into arr;
    perform public.mail_replace_attachments(v_id, v_company, arr::uuid[]);
  end if;
  return public.mail_row(v_id) || jsonb_build_object('duplicate', false);
end;
$$;

-- Prend le message pour l'envoyer, une seule fois : le double clic et un second traitement
-- concurrent repartent avec claimed = false, sans appeler Gmail.
create or replace function public.mail_claim(p_id uuid)
returns jsonb
language plpgsql
as $$
declare
  v public.mail_messages;
  v_account public.mail_accounts;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Envoi d''email');
  select * into v from public.mail_messages where id = p_id for update;
  if not found then raise exception 'Message introuvable.' using errcode = 'P0001'; end if;
  if v.status not in ('draft', 'pending') then
    return jsonb_build_object('claimed', false, 'status', v.status, 'message', public.mail_row(p_id));
  end if;
  if v.account_id is null then
    select * into v_account from public.mail_accounts where is_default;
  else
    select * into v_account from public.mail_accounts where id = v.account_id;
  end if;
  if v_account.id is null or v_account.status <> 'connected' then
    raise exception 'Aucun compte Gmail connecté pour envoyer ce message.' using errcode = 'P0001';
  end if;
  if coalesce(array_length(v.to_addrs, 1), 0) = 0 then
    raise exception 'Indiquez au moins un destinataire.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.mail_attachments a where a.mail_id = p_id and a.file_id is null) then
    raise exception 'Une pièce jointe n''existe plus sur la fiche : retirez-la avant d''envoyer.' using errcode = 'P0001';
  end if;
  update public.mail_messages
     set status = 'sending', account_id = v_account.id, claimed_at = now(), attempts = attempts + 1, error_code = null, last_error = null
   where id = p_id;
  return jsonb_build_object(
    'claimed', true,
    'message', public.mail_row(p_id),
    'account', jsonb_build_object('id', v_account.id, 'email', v_account.email, 'display_name', v_account.display_name),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'storage_path', f.storage_path) order by a.position)
        from public.mail_attachments a join public.company_files f on f.id = a.file_id
       where a.mail_id = p_id and f.status = 'ready'), '[]'::jsonb),
    'attachment_count', (select count(*) from public.mail_attachments a where a.mail_id = p_id));
end;
$$;

-- Historique de la fiche : une seule entrée, créée quand Gmail a accepté le message.
create or replace function public.mail_log_interaction(p_id uuid)
returns void
language plpgsql
as $$
declare
  v public.mail_messages;
  v_interaction uuid;
begin
  select * into v from public.mail_messages where id = p_id;
  if v.company_id is null or v.interaction_id is not null then return; end if;
  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source, meta)
  values (v.company_id, v.person_id, 'message_out', 'email', coalesce(v.sent_at, now()),
          left(case when v.subject = '' then v.body_text else 'Objet : ' || v.subject || E'\n\n' || v.body_text end, 20000),
          'user', case when v.origin = 'manual' then 'user' else 'system' end,
          jsonb_build_object('mail_id', v.id, 'mail_origin', v.origin, 'to', v.to_addrs, 'attachments',
            (select count(*) from public.mail_attachments a where a.mail_id = v.id)))
  returning id into v_interaction;
  update public.mail_messages set interaction_id = v_interaction where id = p_id;
end;
$$;

create or replace function public.mail_mark_accepted(p_id uuid, p_message_id text, p_thread_id text)
returns jsonb
language plpgsql
as $$
begin
  update public.mail_messages
     set status = 'accepted', provider_message_id = p_message_id, provider_thread_id = coalesce(p_thread_id, provider_thread_id), sent_at = now()
   where id = p_id and status = 'sending';
  if not found then raise exception 'Ce message n''est pas en cours d''envoi.' using errcode = 'P0001'; end if;
  perform public.mail_log_interaction(p_id);
  return public.mail_row(p_id);
end;
$$;

create or replace function public.mail_mark_failed(p_id uuid, p_code text, p_error text, p_uncertain boolean default false)
returns jsonb
language plpgsql
as $$
begin
  update public.mail_messages
     set status = case when p_uncertain then 'uncertain' else 'failed' end, error_code = p_code, last_error = left(p_error, 1000)
   where id = p_id and status = 'sending';
  if not found then raise exception 'Ce message n''est pas en cours d''envoi.' using errcode = 'P0001'; end if;
  return public.mail_row(p_id);
end;
$$;

-- Résultat inconnu : seul l'utilisateur, après avoir regardé dans Gmail, peut trancher.
create or replace function public.mail_resolve_uncertain(p_id uuid, p_sent boolean)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Résolution d''email');
  if p_sent then
    update public.mail_messages set status = 'accepted', sent_at = coalesce(claimed_at, now()), error_code = 'confirmed_by_user', last_error = null
     where id = p_id and status = 'uncertain';
  else
    update public.mail_messages set status = 'failed', error_code = 'not_sent_by_user', last_error = 'Non reçu par Gmail, d''après votre vérification.'
     where id = p_id and status = 'uncertain';
  end if;
  if not found then raise exception 'Ce message n''a pas de résultat incertain.' using errcode = 'P0001'; end if;
  if p_sent then perform public.mail_log_interaction(p_id); end if;
  return public.mail_row(p_id);
end;
$$;

-- Un envoi échoué redevient un brouillon modifiable : rien de ce qui a été écrit n'est perdu.
create or replace function public.mail_reopen(p_id uuid)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Reprise d''email');
  update public.mail_messages set status = 'draft', error_code = null, last_error = null, claimed_at = null, dedupe_key = null
   where id = p_id and status = 'failed';
  if not found then raise exception 'Seul un envoi en échec peut être repris.' using errcode = 'P0001'; end if;
  return public.mail_row(p_id);
end;
$$;

create or replace function public.mail_discard(p_id uuid)
returns void
language plpgsql
as $$
declare v_status text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression d''email');
  select status into v_status from public.mail_messages where id = p_id for update;
  if v_status = 'draft' then
    delete from public.mail_messages where id = p_id;
  elsif v_status in ('pending', 'failed') then
    update public.mail_messages set status = 'cancelled' where id = p_id;
  else
    raise exception 'Ce message ne peut plus être annulé.' using errcode = 'P0001';
  end if;
end;
$$;

-- Un traitement interrompu (fonction coupée) laisse un message « en cours » : Gmail a pu le recevoir,
-- donc il devient incertain et n'est jamais relancé automatiquement.
create or replace function public.mail_reap_stale()
returns integer
language plpgsql
as $$
declare n integer;
begin
  update public.mail_messages
     set status = 'uncertain', error_code = 'interrupted', last_error = 'Envoi interrompu avant d''avoir la réponse de Gmail.'
   where status = 'sending' and claimed_at < now() - interval '5 minutes';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Uniquement les fonctions de ce fichier : une autre migration peut ouvrir ses propres fonctions au public
-- (réservation de rendez-vous, par exemple), et elle doit garder ses droits.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and (p.proname like 'mail\_%' or p.proname in ('tg_mail_messages_guard', 'tg_companies_merge_mail'))
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;


-- ===== 20261107000100_projets.sql =====
-- Projets et portail client — phase 1 : projets, membres, accès par code, sessions, cloisonnement.
-- Migration additive.
--
-- Modèle de sécurité du portail
-- * Les clients n'ont pas de compte Supabase. Le serveur Next appelle les fonctions portal_* avec la clé
--   publique, la clé serveur (même mécanisme que la réservation publique : empreinte enregistrée en base,
--   secret APPOINTMENTS_SECRET côté serveur uniquement) et l'empreinte du jeton de session du client
--   (cookie httpOnly). Chaque fonction revérifie : session valide, accès non révoqué ni expiré, personne
--   membre du projet, projet publié et ouvert. Aucune table n'est lisible par le rôle anon.
-- * Le code d'accès n'est jamais stocké : seule son empreinte HMAC (poivrée côté serveur) l'est.
-- * Les fonctions internes sont dans le schéma non exposé portal_private.

create schema if not exists portal_private;
revoke all on schema portal_private from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Projets
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  description text check (description is null or char_length(description) <= 2000),
  status text not null default 'a_preparer' check (status in ('a_preparer','en_cours','en_attente','termine','archive')),
  start_date date,
  end_date date,
  -- visible du client : message d'état rédigé par l'administrateur
  client_update text check (client_update is null or char_length(client_update) <= 2000),
  -- interne uniquement, jamais renvoyé au portail
  internal_note text check (internal_note is null or char_length(internal_note) <= 10000),
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 500),
  -- le portail n'affiche le projet qu'une fois publié explicitement
  portal_published boolean not null default false,
  -- projet archivé : lecture seule pour le client, ou accès fermé
  archived_portal text not null default 'read_only' check (archived_portal in ('read_only','closed')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index projects_company_idx on public.projects (company_id);
create index projects_status_idx on public.projects (status);

-- Contacts clients d'un projet (personnes de la fiche CRM)
create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  person_id uuid not null references public.people (id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (project_id, person_id)
);
create index project_members_person_idx on public.project_members (person_id);

-- Un accès individuel par personne, valable pour tous les projets dont elle est membre
create table public.portal_accesses (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null unique references public.people (id) on delete cascade,
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  code_hint text not null check (char_length(code_hint) between 2 and 8),
  code_generated_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  access_id uuid not null references public.portal_accesses (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index portal_sessions_access_idx on public.portal_sessions (access_id);

create table public.portal_login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index portal_login_attempts_idx on public.portal_login_attempts (ip_hash, created_at desc);

-- Journal du projet : qui a fait quoi (administrateur ou client identifié)
create table public.project_activity (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  actor text not null check (actor in ('owner','client','system')),
  person_id uuid references public.people (id) on delete set null,
  kind text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index project_activity_idx on public.project_activity (project_id, id desc);

create trigger set_updated_at before update on public.projects for each row execute function public.tg_set_updated_at();

do $$
declare t text;
begin
  foreach t in array array['projects','project_members','portal_accesses','portal_sessions','portal_login_attempts','project_activity']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['projects','project_members']
  loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
  end loop;
end $$;
-- empreintes jamais lisibles par l'API, même par le propriétaire
revoke select on public.portal_accesses from authenticated;
grant select (id, person_id, code_hint, code_generated_at, expires_at, revoked_at, last_used_at, created_at) on public.portal_accesses to authenticated;
revoke select on public.portal_sessions from authenticated;
grant select (id, access_id, user_agent, created_at, expires_at, last_seen_at, revoked_at) on public.portal_sessions to authenticated;

-- ---------------------------------------------------------------------------
-- Contrôles
-- ---------------------------------------------------------------------------

create or replace function portal_private.assert_owner_user()
returns void language plpgsql stable set search_path = '' as $$
begin
  perform public.assert_owner();
  if public.current_actor() <> 'user' then
    raise exception 'Projets : action réservée à l''application' using errcode = '42501';
  end if;
end; $$;

create or replace function portal_private.assert_server(p_key text)
returns void language plpgsql stable set search_path = '' as $$
begin
  perform appt_private.assert_server(p_key);
end; $$;

create or replace function portal_private.log(p_project uuid, p_actor text, p_person uuid, p_kind text, p_data jsonb default '{}')
returns void language sql set search_path = '' as $$
  insert into public.project_activity (project_id, actor, person_id, kind, data) values (p_project, p_actor, p_person, p_kind, coalesce(p_data, '{}'));
$$;

-- Session du portail → personne. Lève une erreur « session » si elle n'est plus valable
-- (expirée, révoquée, accès révoqué ou expiré). Prolonge l'activité.
create or replace function portal_private.session_person(p_server_key text, p_session_hash text)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_person uuid;
  v_session uuid;
begin
  perform portal_private.assert_server(p_server_key);
  select a.person_id, s.id into v_person, v_session
    from public.portal_sessions s
    join public.portal_accesses a on a.id = s.access_id
   where s.token_hash = p_session_hash and s.revoked_at is null and s.expires_at > now()
     and a.revoked_at is null and (a.expires_at is null or a.expires_at > now());
  if v_person is null then
    raise exception 'Session expirée' using errcode = '28000';
  end if;
  update public.portal_sessions set last_seen_at = now() where id = v_session and last_seen_at < now() - interval '5 minutes';
  return v_person;
end;
$$;

-- Projets visibles par une personne : membre, projet publié, non fermé.
create or replace function portal_private.visible_projects(p_person uuid)
returns table (project_id uuid, read_only boolean)
language sql
stable
set search_path = ''
as $$
  select p.id, p.status = 'archive'
    from public.project_members m
    join public.projects p on p.id = m.project_id
   where m.person_id = p_person and p.portal_published
     and (p.status <> 'archive' or p.archived_portal = 'read_only');
$$;

create or replace function portal_private.assert_project(p_person uuid, p_project uuid, p_write boolean default false)
returns void
language plpgsql
stable
set search_path = ''
as $$
declare v_ro boolean;
begin
  select read_only into v_ro from portal_private.visible_projects(p_person) where project_id = p_project;
  if not found then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
  if p_write and v_ro then raise exception 'Ce projet est archivé : il est consultable mais plus modifiable' using errcode = '42501'; end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Administration (propriétaire)
-- ---------------------------------------------------------------------------

-- p_data : {company_id, name, description, start_date, end_date, status}
create or replace function public.project_create(p_data jsonb, p_person_ids uuid[] default '{}')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_company uuid := nullif(p_data ->> 'company_id', '')::uuid;
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
    raise exception 'Fiche CRM introuvable' using errcode = 'P0002';
  end if;
  if exists (select 1 from unnest(coalesce(p_person_ids, '{}')) x where not exists (
               select 1 from public.people p where p.id = x and p.company_id = v_company)) then
    raise exception 'Un contact choisi n''appartient pas à cette entreprise' using errcode = '22023';
  end if;
  insert into public.projects (company_id, name, description, start_date, end_date, status)
  values (v_company, btrim(p_data ->> 'name'), nullif(btrim(coalesce(p_data ->> 'description', '')), ''),
          nullif(p_data ->> 'start_date', '')::date, nullif(p_data ->> 'end_date', '')::date,
          coalesce(nullif(p_data ->> 'status', ''), 'a_preparer'))
  returning id into v_id;
  insert into public.project_members (project_id, person_id) select v_id, x from unnest(coalesce(p_person_ids, '{}')) x on conflict do nothing;
  perform portal_private.log(v_id, 'owner', null, 'created');
  insert into public.interactions (company_id, kind, content, content_origin, source, meta)
  values (v_company, 'system', 'Projet créé : ' || btrim(p_data ->> 'name'), 'system', 'user', jsonb_build_object('project_id', v_id));
  return v_id;
end;
$$;

create or replace function public.project_add_member(p_project uuid, p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.projects pr join public.people p on p.company_id = pr.company_id where pr.id = p_project and p.id = p_person) then
    raise exception 'Ce contact n''appartient pas à l''entreprise du projet' using errcode = '22023';
  end if;
  insert into public.project_members (project_id, person_id) values (p_project, p_person) on conflict do nothing;
  if found then perform portal_private.log(p_project, 'owner', p_person, 'member_added'); end if;
end;
$$;

create or replace function public.project_remove_member(p_project uuid, p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  delete from public.project_members where project_id = p_project and person_id = p_person;
  if found then perform portal_private.log(p_project, 'owner', p_person, 'member_removed'); end if;
end;
$$;

-- Nouveau code (création ou régénération) : l'ancien code et toutes les sessions sont invalidés.
-- Le code est généré et haché par le serveur ; il n'est jamais transmis à la base.
create or replace function public.portal_access_issue(p_person uuid, p_code_hash text, p_code_hint text, p_expires_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.people where id = p_person) then raise exception 'Contact introuvable' using errcode = 'P0002'; end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'La date d''expiration est déjà passée' using errcode = '22023'; end if;
  insert into public.portal_accesses (person_id, code_hash, code_hint, expires_at)
  values (p_person, p_code_hash, p_code_hint, p_expires_at)
  on conflict (person_id) do update set code_hash = excluded.code_hash, code_hint = excluded.code_hint, code_generated_at = now(),
    expires_at = excluded.expires_at, revoked_at = null
  returning id into v_id;
  update public.portal_sessions set revoked_at = now() where access_id = v_id and revoked_at is null;
  return v_id;
end;
$$;

create or replace function public.portal_access_set_expiry(p_person uuid, p_expires_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  update public.portal_accesses set expires_at = p_expires_at where person_id = p_person;
  if not found then raise exception 'Aucun accès pour ce contact' using errcode = 'P0002'; end if;
end;
$$;

create or replace function public.portal_access_revoke(p_person uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform portal_private.assert_owner_user();
  update public.portal_accesses set revoked_at = coalesce(revoked_at, now()) where person_id = p_person returning id into v_id;
  if v_id is null then raise exception 'Aucun accès pour ce contact' using errcode = 'P0002'; end if;
  update public.portal_sessions set revoked_at = now() where access_id = v_id and revoked_at is null;
end;
$$;

-- Vue d'administration : un projet avec ses compteurs (les phases suivantes enrichissent cette vue)
create or replace view public.project_overview with (security_invoker = true) as
  select p.*, c.name as company_name,
         (select count(*) from public.project_members m where m.project_id = p.id)::int as member_count
    from public.projects p
    join public.companies c on c.id = p.company_id;
revoke all on public.project_overview from anon;
grant select on public.project_overview to authenticated;

-- ---------------------------------------------------------------------------
-- Portail (serveur + session du client)
-- ---------------------------------------------------------------------------

-- Connexion par code. Limitation : 8 échecs par adresse IP en 15 minutes, 200 échecs au total par minute.
create or replace function public.portal_login(p_server_key text, p_code_hash text, p_ip_hash text, p_session_hash text, p_user_agent text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a public.portal_accesses;
  v_name text;
begin
  perform portal_private.assert_server(p_server_key);
  if (select count(*) from public.portal_login_attempts where ip_hash = p_ip_hash and not success and created_at > now() - interval '15 minutes') >= 8
     or (select count(*) from public.portal_login_attempts where not success and created_at > now() - interval '1 minute') >= 200 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  select * into a from public.portal_accesses where code_hash = p_code_hash;
  if not found or a.revoked_at is not null or (a.expires_at is not null and a.expires_at <= now())
     or not exists (select 1 from portal_private.visible_projects(a.person_id)) then
    insert into public.portal_login_attempts (ip_hash, success) values (p_ip_hash, false);
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.portal_login_attempts (ip_hash, success) values (p_ip_hash, true);
  insert into public.portal_sessions (access_id, token_hash, user_agent, expires_at)
  values (a.id, p_session_hash, left(p_user_agent, 300),
          least(now() + interval '30 days', coalesce(a.expires_at, now() + interval '30 days')));
  update public.portal_accesses set last_used_at = now() where id = a.id;
  -- ménage : tentatives anciennes et sessions périmées
  delete from public.portal_login_attempts where created_at < now() - interval '1 day';
  delete from public.portal_sessions where expires_at < now() - interval '30 days';
  select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) into v_name from public.people where id = a.person_id;
  return jsonb_build_object('status', 'ok', 'name', v_name);
end;
$$;

create or replace function public.portal_logout(p_server_key text, p_session_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_server(p_server_key);
  update public.portal_sessions set revoked_at = now() where token_hash = p_session_hash and revoked_at is null;
end;
$$;

-- Identité et projets de la session
create or replace function public.portal_me(p_server_key text, p_session_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  return jsonb_build_object(
    'person', (select jsonb_build_object('id', p.id, 'first_name', p.first_name, 'last_name', p.last_name, 'company', c.name)
                 from public.people p join public.companies c on c.id = p.company_id where p.id = v_person),
    'projects', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'status', p.status, 'read_only', v.read_only) order by p.status = 'archive', p.created_at desc)
        from portal_private.visible_projects(v_person) v join public.projects p on p.id = v.project_id), '[]'));
end;
$$;

-- Contenu publié d'un projet (base commune au portail et à la prévisualisation administrateur).
-- Seuls des champs explicitement destinés au client sont renvoyés.
create or replace function portal_private.project_view(p_project uuid, p_person uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'status', p.status,
    'start_date', p.start_date, 'end_date', p.end_date, 'client_update', p.client_update,
    'read_only', p.status = 'archive', 'company', c.name, 'updated_at', p.updated_at)
    from public.projects p join public.companies c on c.id = p.company_id
   where p.id = p_project;
$$;

create or replace function public.portal_project(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return portal_private.project_view(p_project, v_person);
end;
$$;

-- Prévisualisation administrateur : mêmes règles que le portail, pour un contact donné.
create or replace function public.portal_preview_project(p_project uuid, p_person uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.project_members where project_id = p_project and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  return portal_private.project_view(p_project, p_person);
end;
$$;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'project_create(jsonb, uuid[])', 'project_add_member(uuid, uuid)', 'project_remove_member(uuid, uuid)',
    'portal_access_issue(uuid, text, text, timestamptz)', 'portal_access_set_expiry(uuid, timestamptz)',
    'portal_access_revoke(uuid)', 'portal_preview_project(uuid, uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'portal_login(text, text, text, text, text)', 'portal_logout(text, text)', 'portal_me(text, text)', 'portal_project(text, text, uuid)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;


-- ===== 20261107000200_projets_planning_points.sql =====
-- Projets et portail client — phase 2 : phases, jalons, points de suivi (rendez-vous), récapitulatifs,
-- et suivi des modifications faites directement dans Google Agenda. Migration additive.

-- ---------------------------------------------------------------------------
-- Phases et jalons (une seule source pour la timeline et la liste chronologique)
-- status = avancement réel, indépendant des dates : une date passée ne termine rien.
-- ---------------------------------------------------------------------------

create table public.project_phases (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  position int not null default 0,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (description is null or char_length(description) <= 1000),
  deliverables text check (deliverables is null or char_length(deliverables) <= 1000),
  start_date date,
  end_date date,
  color text not null default 'violet' check (color in ('violet','blue','teal','green','amber','pink','slate')),
  status text not null default 'a_venir' check (status in ('a_venir','en_cours','termine','en_pause')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);
create index project_phases_idx on public.project_phases (project_id, position);

create table public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  phase_id uuid references public.project_phases (id) on delete set null,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  due_date date not null,
  done_at timestamptz,
  visible_to_client boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_milestones_idx on public.project_milestones (project_id, due_date);

-- ---------------------------------------------------------------------------
-- Points de suivi : un point EST un rendez-vous du module Rendez-vous (aucune copie de la date, du
-- statut ni du lien) ; ce lien explicite décide de sa publication sur le portail.
-- ---------------------------------------------------------------------------

create table public.project_meetings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  booking_id uuid not null unique references public.appt_bookings (id) on delete restrict,
  title text check (title is null or char_length(btrim(title)) between 1 and 160),
  agenda text check (agenda is null or char_length(agenda) <= 4000),
  participants text check (participants is null or char_length(participants) <= 500),
  visible_to_client boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_meetings_project_idx on public.project_meetings (project_id);

-- Récapitulatif : brouillon privé → publication explicite. internal_note n'est jamais publiée.
create table public.meeting_recaps (
  meeting_id uuid primary key references public.project_meetings (id) on delete cascade,
  summary text check (summary is null or char_length(summary) <= 8000),
  decisions text check (decisions is null or char_length(decisions) <= 4000),
  actions jsonb not null default '[]' check (jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) <= 30),
  next_step text check (next_step is null or char_length(next_step) <= 2000),
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 20),
  internal_note text check (internal_note is null or char_length(internal_note) <= 8000),
  status text not null default 'draft' check (status in ('draft','published')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Écarts constatés dans Google Agenda pour les événements créés par l'outil (déplacés, supprimés).
-- Signalés à l'administrateur ; rien n'est modifié automatiquement côté Cely.
alter table public.appt_bookings
  add column google_drift jsonb,
  add column google_drift_at timestamptz;

alter table public.appt_google_connection
  add column events_sync_token text,
  add column events_synced_at timestamptz,
  add column events_sync_error text;
grant select (events_synced_at, events_sync_error) on public.appt_google_connection to authenticated;

do $$
declare t text;
begin
  foreach t in array array['project_phases','project_milestones','project_meetings','meeting_recaps']
  loop
    execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- un rendez-vous ne se rattache qu'à un projet de la même fiche CRM (jamais par ressemblance)
create or replace function portal_private.tg_meeting_company()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.appt_bookings b join public.projects p on p.company_id = b.company_id
                  where b.id = new.booking_id and p.id = new.project_id) then
    raise exception 'Ce rendez-vous n''est pas rattaché à la fiche CRM du projet' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger project_meetings_company before insert or update of booking_id, project_id on public.project_meetings
  for each row execute function portal_private.tg_meeting_company();

create or replace function portal_private.tg_phase_completed()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.completed_at := case when new.status <> 'termine' then null
                           when tg_op = 'UPDATE' and old.status = 'termine' then old.completed_at else now() end;
  return new;
end; $$;
create trigger project_phases_completed before insert or update of status on public.project_phases
  for each row execute function portal_private.tg_phase_completed();

-- ---------------------------------------------------------------------------
-- Rendez-vous créé par le propriétaire (point de suivi) : même table, même contrainte anti-chevauchement,
-- même orchestration Google (événement, lien Meet) que la réservation publique. Pas de contrôle de
-- disponibilité : le propriétaire choisit l'horaire.
-- ---------------------------------------------------------------------------

create or replace function public.appt_owner_book(
  p_booking_id uuid, p_type uuid, p_starts_at timestamptz, p_duration_min int, p_person uuid,
  p_calendar_target boolean, p_token_hash text, p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t public.appt_event_types;
  pe public.people;
  v_tz text;
  v_existing public.appt_bookings;
  v_dur int := coalesce(p_duration_min, 0);
  v_end timestamptz;
  v_pending boolean := coalesce(p_calendar_target, false);
begin
  perform appt_private.assert_owner_user();
  perform appt_private.lock();
  select * into v_existing from public.appt_bookings where idempotency_key = p_idempotency_key;
  if found then return jsonb_build_object('status', 'existing', 'id', v_existing.id, 'booking_status', v_existing.status); end if;
  perform appt_private.sweep();
  select * into t from public.appt_event_types where id = p_type;
  if not found then raise exception 'Type de rendez-vous introuvable' using errcode = 'P0002'; end if;
  select * into pe from public.people where id = p_person;
  if not found then raise exception 'Contact introuvable' using errcode = 'P0002'; end if;
  if pe.email is null then raise exception 'Ce contact n''a pas d''email : complétez sa fiche' using errcode = '22023'; end if;
  if v_dur = 0 then v_dur := t.duration_min; end if;
  if v_dur not between 5 and 480 then raise exception 'Durée invalide' using errcode = '22023'; end if;
  if p_starts_at <= now() then raise exception 'Choisissez un horaire à venir' using errcode = '22023'; end if;
  select timezone into v_tz from public.appt_schedules where id = t.schedule_id;
  v_end := p_starts_at + make_interval(mins => v_dur);

  insert into public.appt_bookings (
    id, event_type_id, status, starts_at, ends_at, buffer_before_min, buffer_after_min, schedule_timezone, invitee_timezone,
    first_name, last_name, email, email_norm, phone, company_name, answers, event_snapshot, meeting_url,
    company_id, person_id, crm_status, idempotency_key, manage_token_hash, calendar_target, hold_expires_at)
  values (
    p_booking_id, t.id, case when v_pending then 'pending' else 'confirmed' end, p_starts_at, v_end, 0, 0, v_tz, v_tz,
    coalesce(pe.first_name, pe.email), coalesce(pe.last_name, '-'), pe.email, public.norm_email(pe.email), pe.phone,
    (select name from public.companies where id = pe.company_id), '[]',
    jsonb_build_object('name', t.name, 'slug', t.slug, 'description', t.description, 'duration_min', v_dur,
                       'location_kind', t.location_kind, 'location_detail', t.location_detail, 'google_meet', t.google_meet),
    t.meeting_url, pe.company_id, pe.id, 'linked', p_idempotency_key, p_token_hash, v_pending,
    case when v_pending then now() + interval '10 minutes' end);
  insert into public.appt_reservations (booking_id, kind, occupied, expires_at)
  values (p_booking_id, 'main', tstzrange(p_starts_at, v_end), case when v_pending then now() + interval '10 minutes' end);
  perform appt_private.log(p_booking_id, 'created', 'owner', jsonb_build_object('starts_at', p_starts_at));
  if not v_pending then perform appt_private.confirm(p_booking_id, 'owner'); end if;
  return jsonb_build_object('status', case when v_pending then 'pending' else 'confirmed' end, 'id', p_booking_id);
exception
  when exclusion_violation then
    return jsonb_build_object('status', 'unavailable');
end;
$$;

-- Report par le propriétaire : il choisit l'horaire (pas de contrôle des disponibilités publiques) ;
-- la contrainte anti-chevauchement et la retenue avant libération de l'ancien créneau restent identiques.
create or replace function public.appt_reschedule_begin(
  p_id uuid, p_starts_at timestamptz, p_busy jsonb default '[]', p_server_key text default null, p_token_hash text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor text := appt_private.authorize(p_id, p_server_key, p_token_hash);
  b public.appt_bookings;
  v_hold uuid;
  v_dur interval;
begin
  perform appt_private.lock();
  perform appt_private.sweep();
  select * into b from public.appt_bookings where id = p_id for update;
  if b.status <> 'confirmed' then raise exception 'Ce rendez-vous ne peut plus être reporté' using errcode = '22023'; end if;
  if v_actor = 'invitee' and b.starts_at <= now() then raise exception 'Ce rendez-vous est déjà passé' using errcode = '22023'; end if;
  if p_starts_at = b.starts_at then raise exception 'Choisissez un autre créneau' using errcode = '22023'; end if;
  if v_actor = 'owner' then
    if p_starts_at <= now() then raise exception 'Choisissez un horaire à venir' using errcode = '22023'; end if;
  elsif not exists (select 1 from appt_private.compute_slots(b.event_type_id, p_starts_at, p_starts_at + interval '1 minute', p_busy, p_id) s
                     where s.slot = p_starts_at) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  v_dur := b.ends_at - b.starts_at;
  insert into public.appt_reservations (booking_id, kind, occupied, expires_at)
  values (p_id, 'hold', tstzrange(p_starts_at - make_interval(mins => b.buffer_before_min), p_starts_at + v_dur + make_interval(mins => b.buffer_after_min)),
          now() + interval '10 minutes')
  returning id into v_hold;
  return jsonb_build_object('status', 'held', 'hold_id', v_hold, 'version', b.version,
                            'old_starts_at', b.starts_at, 'old_ends_at', b.ends_at,
                            'starts_at', p_starts_at, 'ends_at', p_starts_at + v_dur);
exception
  when exclusion_violation then
    return jsonb_build_object('status', 'unavailable');
end;
$$;

-- Écart détecté dans Google (synchronisation incrémentale des événements créés par l'outil)
create or replace function public.appt_google_drift(p_booking uuid, p_drift jsonb, p_server_key text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  update public.appt_bookings set google_drift = p_drift, google_drift_at = case when p_drift is null then null else now() end
   where id = p_booking and google_drift is distinct from p_drift;
end; $$;

create or replace function public.appt_google_events_sync_state(p_token text, p_error text, p_server_key text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  update public.appt_google_connection
     set events_sync_token = case when p_error is null then p_token else events_sync_token end,
         events_synced_at = case when p_error is null then now() else events_synced_at end,
         events_sync_error = left(p_error, 500)
   where id;
end; $$;

create or replace function public.appt_google_events_sync_token(p_server_key text)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform appt_private.assert_server(p_server_key);
  return (select events_sync_token from public.appt_google_connection where id);
end; $$;

-- ---------------------------------------------------------------------------
-- Administration des points
-- ---------------------------------------------------------------------------

create or replace function public.project_link_meeting(p_project uuid, p_booking uuid, p_visible boolean default true, p_title text default null, p_agenda text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform portal_private.assert_owner_user();
  insert into public.project_meetings (project_id, booking_id, visible_to_client, title, agenda)
  values (p_project, p_booking, coalesce(p_visible, true), nullif(btrim(coalesce(p_title, '')), ''), nullif(btrim(coalesce(p_agenda, '')), ''))
  returning id into v_id;
  perform portal_private.log(p_project, 'owner', null, 'meeting_linked', jsonb_build_object('booking_id', p_booking));
  return v_id;
exception when unique_violation then
  raise exception 'Ce rendez-vous est déjà rattaché à un projet' using errcode = '22023';
end; $$;

create or replace function public.project_publish_recap(p_meeting uuid, p_publish boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  perform portal_private.assert_owner_user();
  select project_id into v_project from public.project_meetings where id = p_meeting;
  if v_project is null then raise exception 'Point introuvable' using errcode = 'P0002'; end if;
  if p_publish and not exists (select 1 from public.meeting_recaps where meeting_id = p_meeting
                                and coalesce(btrim(summary), '') || coalesce(btrim(decisions), '') || coalesce(btrim(next_step), '') <> '') then
    raise exception 'Le récapitulatif est vide : rédigez au moins un résumé, des décisions ou la prochaine étape' using errcode = '22023';
  end if;
  update public.meeting_recaps set status = case when p_publish then 'published' else 'draft' end,
         published_at = case when p_publish then coalesce(published_at, now()) else null end
   where meeting_id = p_meeting;
  perform portal_private.log(v_project, 'owner', null, case when p_publish then 'recap_published' else 'recap_unpublished' end, jsonb_build_object('meeting_id', p_meeting));
end; $$;

-- ---------------------------------------------------------------------------
-- Vue client d'un projet (portail ET aperçu administrateur) : uniquement le contenu publié.
-- ---------------------------------------------------------------------------

create or replace function portal_private.meeting_json(m public.project_meetings, b public.appt_bookings, p_full boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', m.id, 'title', coalesce(m.title, b.event_snapshot ->> 'name'),
    'starts_at', b.starts_at, 'ends_at', b.ends_at, 'timezone', b.schedule_timezone,
    'status', case when b.status = 'cancelled' then 'cancelled'
                   when b.outcome = 'done' or b.ends_at <= now() then 'past' else 'upcoming' end,
    'meeting_url', case when b.status = 'confirmed' and b.ends_at > now() then b.meeting_url end,
    'location_kind', b.event_snapshot ->> 'location_kind',
    'participants', m.participants,
    'agenda', case when p_full then m.agenda end,
    'has_recap', exists (select 1 from public.meeting_recaps r where r.meeting_id = m.id and r.status = 'published'));
$$;

create or replace function portal_private.project_view(p_project uuid, p_person uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'description', p.description, 'status', p.status,
    'start_date', p.start_date, 'end_date', p.end_date, 'client_update', p.client_update,
    'read_only', p.status = 'archive', 'company', c.name, 'updated_at', p.updated_at,
    'today', (now() at time zone 'Europe/Paris')::date,
    'phases', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ph.id, 'name', ph.name, 'description', ph.description, 'deliverables', ph.deliverables,
        'start_date', ph.start_date, 'end_date', ph.end_date, 'color', ph.color, 'status', ph.status,
        'completed_at', ph.completed_at) order by ph.position, ph.start_date nulls last)
      from public.project_phases ph where ph.project_id = p.id), '[]'),
    'milestones', coalesce((select jsonb_agg(jsonb_build_object(
        'id', ms.id, 'title', ms.title, 'due_date', ms.due_date, 'done', ms.done_at is not null, 'phase_id', ms.phase_id) order by ms.due_date)
      from public.project_milestones ms where ms.project_id = p.id and ms.visible_to_client), '[]'),
    'meetings', coalesce((select jsonb_agg(portal_private.meeting_json(m, b, false) order by b.starts_at)
      from public.project_meetings m join public.appt_bookings b on b.id = m.booking_id
     where m.project_id = p.id and m.visible_to_client and b.status in ('confirmed','cancelled')), '[]'))
    from public.projects p join public.companies c on c.id = p.company_id
   where p.id = p_project;
$$;

-- Détail d'un point et de son récapitulatif publié (jamais la note interne ni un brouillon)
create or replace function portal_private.meeting_view(p_project uuid, p_meeting uuid)
returns jsonb language sql stable set search_path = '' as $$
  select portal_private.meeting_json(m, b, true) || jsonb_build_object(
    'recap', (select jsonb_build_object('summary', r.summary, 'decisions', r.decisions, 'actions', r.actions,
                                        'next_step', r.next_step, 'links', r.links, 'published_at', r.published_at)
                from public.meeting_recaps r where r.meeting_id = m.id and r.status = 'published'))
    from public.project_meetings m join public.appt_bookings b on b.id = m.booking_id
   where m.id = p_meeting and m.project_id = p_project and m.visible_to_client and b.status in ('confirmed','cancelled');
$$;

create or replace function public.portal_meeting(p_server_key text, p_session_hash text, p_project uuid, p_meeting uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  v jsonb;
begin
  perform portal_private.assert_project(v_person, p_project);
  v := portal_private.meeting_view(p_project, p_meeting);
  if v is null then raise exception 'Point introuvable' using errcode = 'P0002'; end if;
  return v;
end; $$;

create or replace function public.portal_preview_meeting(p_project uuid, p_meeting uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform portal_private.assert_owner_user();
  return portal_private.meeting_view(p_project, p_meeting);
end; $$;

-- Rendez-vous : l'écart constaté dans Google est exposé au back-office (colonne ajoutée en fin de vue)
create or replace view public.appt_booking_overview with (security_invoker = true) as
  select b.id, b.event_type_id, b.status, b.outcome, b.starts_at, b.ends_at, b.schedule_timezone, b.invitee_timezone,
         b.first_name, b.last_name, b.email, b.phone, b.company_name, b.website, b.answers, b.event_snapshot,
         b.meeting_url, b.company_id, b.person_id, b.crm_status, b.crm_candidates, b.internal_note, b.cancel_reason,
         b.cancelled_by, b.cancelled_at, b.version, b.calendar_target, b.google_event_id,
         (b.calendar_target and b.calendar_synced_version < b.version and b.status <> 'pending') as calendar_out_of_sync,
         b.calendar_sync_error, b.created_at, b.updated_at,
         c.name as crm_company_name,
         case
           when b.status = 'confirmed' and b.outcome is null and b.ends_at <= now() then 'a_renseigner'
           when b.status = 'confirmed' and b.outcome is not null then b.outcome
           when b.status = 'confirmed' then 'a_venir'
           else b.status
         end as display_status,
         b.google_drift
    from public.appt_bookings b
    left join public.companies c on c.id = b.company_id
   where b.status in ('confirmed','cancelled') or (b.status = 'pending' and b.hold_expires_at > now());
revoke all on public.appt_booking_overview from anon;
grant select on public.appt_booking_overview to authenticated;

-- Vue d'administration enrichie : phase en cours et prochain point
create or replace view public.project_overview with (security_invoker = true) as
  select p.*, c.name as company_name,
         (select count(*) from public.project_members m where m.project_id = p.id)::int as member_count,
         (select ph.name from public.project_phases ph where ph.project_id = p.id and ph.status = 'en_cours' order by ph.position limit 1) as current_phase_name,
         (select min(b.starts_at) from public.project_meetings pm join public.appt_bookings b on b.id = pm.booking_id
           where pm.project_id = p.id and b.status = 'confirmed' and b.starts_at > now()) as next_meeting_at
    from public.projects p
    join public.companies c on c.id = p.company_id;
revoke all on public.project_overview from anon;
grant select on public.project_overview to authenticated;

-- ---------------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------------

revoke all on all functions in schema portal_private from public, anon, authenticated;
revoke all on all functions in schema appt_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'appt_owner_book(uuid, uuid, timestamptz, int, uuid, boolean, text, text)',
    'project_link_meeting(uuid, uuid, boolean, text, text)', 'project_publish_recap(uuid, boolean)',
    'portal_preview_meeting(uuid, uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'portal_meeting(text, text, uuid, uuid)', 'appt_google_drift(uuid, jsonb, text)',
    'appt_reschedule_begin(uuid, timestamptz, jsonb, text, text)',
    'appt_google_events_sync_state(text, text, text)', 'appt_google_events_sync_token(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;


-- ===== 20261107000300_projets_taches.sql =====
-- Projets et portail client — phase 3 : tâches de projet et commentaires. Migration additive.
-- Une action = une seule ligne, quelle que soit la vue (tableau du projet, « Mes tâches », point associé).
-- Règles client (vérifiées en base) : il ne voit que les tâches explicitement visibles ; il ne modifie que le
-- statut et l'explication d'un blocage des tâches qui lui sont attribuées (à lui, ou à l'équipe client) ;
-- il commente les tâches visibles. Il ne crée ni ne supprime de tâche et ne touche jamais au planning.

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  description text check (description is null or char_length(description) <= 5000),
  status text not null default 'a_faire' check (status in ('a_faire','en_cours','bloque','termine')),
  -- responsable : moi (owner) ou le client (une personne précise, ou l'équipe client si person_id est vide)
  assignee_kind text not null default 'owner' check (assignee_kind in ('owner','client')),
  assignee_person_id uuid references public.people (id) on delete set null,
  visible_to_client boolean not null default false,
  due_date date,
  blocked_reason text check (blocked_reason is null or char_length(blocked_reason) <= 1000),
  meeting_id uuid references public.project_meetings (id) on delete set null,
  links jsonb not null default '[]' check (jsonb_typeof(links) = 'array' and jsonb_array_length(links) <= 10),
  position int not null default 0,
  created_by_kind text not null default 'owner' check (created_by_kind in ('owner','client')),
  created_by_person uuid references public.people (id) on delete set null,
  updated_by_kind text not null default 'owner' check (updated_by_kind in ('owner','client')),
  updated_by_person uuid references public.people (id) on delete set null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- une tâche attribuée au client lui est forcément visible
  check (assignee_kind = 'owner' or visible_to_client),
  check (assignee_kind = 'client' or assignee_person_id is null)
);
create index project_tasks_project_idx on public.project_tasks (project_id, status);
create index project_tasks_meeting_idx on public.project_tasks (meeting_id) where meeting_id is not null;

create table public.project_task_comments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.project_tasks (id) on delete cascade,
  author_kind text not null check (author_kind in ('owner','client')),
  person_id uuid references public.people (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index project_task_comments_idx on public.project_task_comments (task_id, created_at);

create or replace function portal_private.tg_task()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.completed_at := case when new.status <> 'termine' then null
                           when tg_op = 'UPDATE' and old.status = 'termine' then old.completed_at else now() end;
  if new.status <> 'bloque' then new.blocked_reason := null; end if;
  if new.assignee_person_id is not null and not exists (
       select 1 from public.project_members m where m.project_id = new.project_id and m.person_id = new.assignee_person_id) then
    raise exception 'Le responsable doit être un contact du projet' using errcode = '22023';
  end if;
  if new.meeting_id is not null and not exists (select 1 from public.project_meetings pm where pm.id = new.meeting_id and pm.project_id = new.project_id) then
    raise exception 'Ce point n''appartient pas au projet' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger project_tasks_rules before insert or update on public.project_tasks for each row execute function portal_private.tg_task();

do $$
declare t text;
begin
  foreach t in array array['project_tasks','project_task_comments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Portail
-- ---------------------------------------------------------------------------

-- La personne peut-elle modifier cette tâche ? (attribuée à elle, ou à l'équipe client ; projet ouvert)
create or replace function portal_private.task_editable(t public.project_tasks, p_person uuid)
returns boolean language sql stable set search_path = '' as $$
  select t.assignee_kind = 'client' and (t.assignee_person_id is null or t.assignee_person_id = p_person)
     and exists (select 1 from portal_private.visible_projects(p_person) v where v.project_id = t.project_id and not v.read_only);
$$;

create or replace function portal_private.task_json(t public.project_tasks, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', t.id, 'project_id', t.project_id, 'project_name', (select name from public.projects where id = t.project_id),
    'title', t.title, 'status', t.status, 'due_date', t.due_date, 'blocked_reason', t.blocked_reason,
    'assignee', case when t.assignee_kind = 'owner' then jsonb_build_object('kind', 'owner', 'name', 'Cely Growth')
                     when t.assignee_person_id is null then jsonb_build_object('kind', 'team', 'name', 'Équipe client')
                     else jsonb_build_object('kind', case when t.assignee_person_id = p_person then 'me' else 'person' end,
                                             'name', (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = t.assignee_person_id)) end,
    'meeting', (select jsonb_build_object('id', pm.id, 'title', coalesce(pm.title, b.event_snapshot ->> 'name'), 'starts_at', b.starts_at)
                  from public.project_meetings pm join public.appt_bookings b on b.id = pm.booking_id
                 where pm.id = t.meeting_id and pm.visible_to_client and b.status in ('confirmed','cancelled')),
    'updated_at', t.updated_at, 'can_edit', portal_private.task_editable(t, p_person),
    'comment_count', (select count(*) from public.project_task_comments c where c.task_id = t.id));
$$;

-- Tâches visibles : un projet précis, ou tous les projets autorisés (« Mes tâches »)
create or replace function public.portal_tasks(p_server_key text, p_session_hash text, p_project uuid default null, p_limit int default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  if p_project is not null then perform portal_private.assert_project(v_person, p_project); end if;
  return coalesce((
    select jsonb_agg(portal_private.task_json(t, v_person) order by t.status = 'termine', t.due_date nulls last, t.position, t.created_at)
      from (select t.* from public.project_tasks t
             where t.visible_to_client
               and t.project_id in (select project_id from portal_private.visible_projects(v_person))
               and (p_project is null or t.project_id = p_project)
             order by t.status = 'termine', t.due_date nulls last, t.position, t.created_at
             limit greatest(1, least(p_limit, 500))) t), '[]');
end; $$;

create or replace function public.portal_task(p_server_key text, p_session_hash text, p_task uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client;
  if not found or not exists (select 1 from portal_private.visible_projects(v_person) where project_id = t.project_id) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  return portal_private.task_json(t, v_person) || jsonb_build_object(
    'description', t.description, 'links', t.links,
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'created_at', c.created_at, 'mine', c.person_id = v_person,
        'author', case when c.author_kind = 'owner' then 'Cely Growth'
                       else (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = c.person_id) end) order by c.created_at)
      from public.project_task_comments c where c.task_id = t.id), '[]'));
end; $$;

-- Modification par le client : statut et explication d'un blocage uniquement.
create or replace function public.portal_task_update(p_server_key text, p_session_hash text, p_task uuid, p_status text, p_blocked_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client for update;
  if not found or not exists (select 1 from portal_private.visible_projects(v_person) where project_id = t.project_id) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  if not portal_private.task_editable(t, v_person) then
    raise exception 'Cette tâche n''est pas attribuée à vous : vous pouvez la consulter et la commenter.' using errcode = '42501';
  end if;
  if p_status not in ('a_faire','en_cours','bloque','termine') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  if p_status = 'bloque' and coalesce(btrim(p_blocked_reason), '') = '' then
    raise exception 'Expliquez en quelques mots ce qui bloque' using errcode = '22023';
  end if;
  update public.project_tasks set status = p_status, blocked_reason = nullif(btrim(coalesce(p_blocked_reason, '')), ''),
         updated_by_kind = 'client', updated_by_person = v_person
   where id = p_task returning * into t;
  perform portal_private.log(t.project_id, 'client', v_person, 'task_status', jsonb_build_object('task_id', t.id, 'status', p_status));
  return portal_private.task_json(t, v_person);
end; $$;

create or replace function public.portal_task_comment(p_server_key text, p_session_hash text, p_task uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  t public.project_tasks;
  v_id uuid;
begin
  select * into t from public.project_tasks where id = p_task and visible_to_client;
  if not found then raise exception 'Tâche introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, t.project_id, true);
  if coalesce(btrim(p_body), '') = '' or char_length(p_body) > 1000 then raise exception 'Commentaire vide ou trop long (1 000 caractères)' using errcode = '22023'; end if;
  insert into public.project_task_comments (task_id, author_kind, person_id, body) values (p_task, 'client', v_person, btrim(p_body)) returning id into v_id;
  perform portal_private.log(t.project_id, 'client', v_person, 'task_comment', jsonb_build_object('task_id', t.id));
  return jsonb_build_object('id', v_id);
end; $$;

-- Ce qui attend le client sur un projet (vue d'ensemble) : ses tâches ouvertes
create or replace function portal_private.my_open_tasks(p_project uuid, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(portal_private.task_json(t, p_person) order by t.due_date nulls last, t.position), '[]')
    from (select * from public.project_tasks t
           where t.project_id = p_project and t.visible_to_client and t.assignee_kind = 'client'
             and (t.assignee_person_id is null or t.assignee_person_id = p_person) and t.status <> 'termine'
           order by t.due_date nulls last, t.position limit 5) t;
$$;

create or replace function public.portal_project(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return portal_private.project_view(p_project, v_person) || jsonb_build_object('my_tasks', portal_private.my_open_tasks(p_project, v_person));
end; $$;

create or replace function public.portal_preview_project(p_project uuid, p_person uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform portal_private.assert_owner_user();
  if not exists (select 1 from public.project_members where project_id = p_project and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  return portal_private.project_view(p_project, p_person) || jsonb_build_object('my_tasks', portal_private.my_open_tasks(p_project, p_person));
end; $$;

-- Vue d'administration : compteur des tâches client ouvertes
create or replace view public.project_overview with (security_invoker = true) as
  select p.*, c.name as company_name,
         (select count(*) from public.project_members m where m.project_id = p.id)::int as member_count,
         (select ph.name from public.project_phases ph where ph.project_id = p.id and ph.status = 'en_cours' order by ph.position limit 1) as current_phase_name,
         (select min(b.starts_at) from public.project_meetings pm join public.appt_bookings b on b.id = pm.booking_id
           where pm.project_id = p.id and b.status = 'confirmed' and b.starts_at > now()) as next_meeting_at,
         (select count(*) from public.project_tasks t where t.project_id = p.id and t.assignee_kind = 'client' and t.status <> 'termine')::int as open_client_tasks,
         (select count(*) from public.project_tasks t where t.project_id = p.id and t.status = 'bloque')::int as blocked_tasks
    from public.projects p
    join public.companies c on c.id = p.company_id;
revoke all on public.project_overview from anon;
grant select on public.project_overview to authenticated;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'portal_tasks(text, text, uuid, int)', 'portal_task(text, text, uuid)', 'portal_task_update(text, text, uuid, text, text)',
    'portal_task_comment(text, text, uuid, text)', 'portal_project(text, text, uuid)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  execute 'revoke all on function public.portal_preview_project(uuid, uuid) from public, anon';
  execute 'grant execute on function public.portal_preview_project(uuid, uuid) to authenticated';
end $$;


-- ===== 20261107000400_projets_fichiers.sql =====
-- Projets et portail client — phase 4 : fichiers partagés. Migration additive.
-- Réutilise le module Fichiers existant (table company_files, bucket privé company-files) :
-- * un document du projet est un document de la fiche CRM ; « partager avec le projet » crée une RÉFÉRENCE
--   (project_files), jamais une copie ; retirer du projet ≠ supprimer le fichier ;
-- * un dépôt client crée un document de la fiche, marqué comme déposé par ce contact, puis sa référence ;
-- * le client n'a pas de compte : le serveur agit avec le rôle anon, et les politiques Storage ne
--   l'autorisent que sur des objets précis, pour une durée courte, après contrôle de la session en base.

alter table public.company_files
  add column uploaded_by_kind text not null default 'owner' check (uploaded_by_kind in ('owner','client')),
  add column uploaded_by_person uuid references public.people (id) on delete set null;

create table public.project_folders (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  parent_id uuid references public.project_folders (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now()
);
create index project_folders_idx on public.project_folders (project_id, parent_id);

create table public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  file_id uuid not null references public.company_files (id) on delete cascade,
  folder_id uuid references public.project_folders (id) on delete set null,
  task_id uuid references public.project_tasks (id) on delete set null,
  shared_by_kind text not null default 'owner' check (shared_by_kind in ('owner','client')),
  shared_by_person uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (project_id, file_id)
);
create index project_files_project_idx on public.project_files (project_id, folder_id);

-- Autorisations Storage temporaires (téléchargement / prévisualisation) : 60 secondes
create table public.portal_storage_grants (
  id bigint generated always as identity primary key,
  object_name text not null,
  action text not null check (action in ('read','delete')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index portal_storage_grants_idx on public.portal_storage_grants (object_name, action, expires_at);

-- Cohérence : dossier et fichier du même projet ; deux niveaux de dossiers au plus ; fichier de la fiche du projet
create or replace function portal_private.tg_folder()
returns trigger language plpgsql set search_path = '' as $$
declare v_parent public.project_folders;
begin
  if new.parent_id is not null then
    select * into v_parent from public.project_folders where id = new.parent_id;
    if v_parent.project_id <> new.project_id then raise exception 'Dossier parent d''un autre projet' using errcode = '22023'; end if;
    if v_parent.parent_id is not null then raise exception 'Deux niveaux de dossiers au maximum' using errcode = '22023'; end if;
    if new.id = new.parent_id then raise exception 'Dossier invalide' using errcode = '22023'; end if;
  end if;
  return new;
end; $$;
create trigger project_folders_rules before insert or update on public.project_folders for each row execute function portal_private.tg_folder();

create or replace function portal_private.tg_project_file()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public.company_files f join public.projects p on p.company_id = f.company_id where f.id = new.file_id and p.id = new.project_id) then
    raise exception 'Ce document n''appartient pas à la fiche CRM du projet' using errcode = '22023';
  end if;
  if new.folder_id is not null and not exists (select 1 from public.project_folders where id = new.folder_id and project_id = new.project_id) then
    raise exception 'Dossier d''un autre projet' using errcode = '22023';
  end if;
  if new.task_id is not null and not exists (select 1 from public.project_tasks where id = new.task_id and project_id = new.project_id) then
    raise exception 'Tâche d''un autre projet' using errcode = '22023';
  end if;
  return new;
end; $$;
create trigger project_files_rules before insert or update on public.project_files for each row execute function portal_private.tg_project_file();

do $$
declare t text;
begin
  foreach t in array array['project_folders','project_files','portal_storage_grants']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['project_folders','project_files']
  loop
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Politiques Storage pour le rôle anon (serveur agissant pour un client authentifié par session)
-- Les fonctions sont « security definer » et ne répondent que pour un objet précis.
-- ---------------------------------------------------------------------------

-- Envoi : objet d'un dépôt client en attente, créé il y a moins de 15 minutes
create or replace function public.portal_storage_can_upload(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.company_files f
                  where f.storage_path = p_name and f.status = 'pending' and f.uploaded_by_kind = 'client'
                    and f.created_at > now() - interval '15 minutes');
$$;

create or replace function public.portal_storage_can(p_name text, p_action text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.portal_storage_grants g where g.object_name = p_name and g.action = p_action and g.expires_at > now());
$$;

create policy portal_files_insert on storage.objects for insert to anon
  with check (bucket_id = 'company-files' and public.portal_storage_can_upload(name));
create policy portal_files_select on storage.objects for select to anon
  using (bucket_id = 'company-files' and public.portal_storage_can(name, 'read'));
create policy portal_files_delete on storage.objects for delete to anon
  using (bucket_id = 'company-files' and public.portal_storage_can(name, 'delete'));

-- ---------------------------------------------------------------------------
-- Portail
-- ---------------------------------------------------------------------------

create or replace function portal_private.file_json(pf public.project_files, f public.company_files, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', pf.id, 'name', f.display_name, 'mime_type', f.mime_type, 'size', f.size_bytes, 'folder_id', pf.folder_id, 'task_id', pf.task_id,
    'created_at', pf.created_at,
    'author', case when f.uploaded_by_kind = 'client' and f.uploaded_by_person is not null
                   then (select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = f.uploaded_by_person)
                   else 'Cely Growth' end,
    'mine', f.uploaded_by_kind = 'client' and f.uploaded_by_person = p_person);
$$;

-- Liste d'un projet (paginée). Seuls les documents partagés avec le projet et prêts.
create or replace function public.portal_files(p_server_key text, p_session_hash text, p_project uuid, p_limit int default 200, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return jsonb_build_object(
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id) order by name)
                           from public.project_folders where project_id = p_project), '[]'),
    'total', (select count(*) from public.project_files pf join public.company_files f on f.id = pf.file_id where pf.project_id = p_project and f.status = 'ready'),
    'files', coalesce((select jsonb_agg(portal_private.file_json(pf, f, v_person) order by pf.created_at desc)
                         from (select pf.id from public.project_files pf join public.company_files f on f.id = pf.file_id
                                where pf.project_id = p_project and f.status = 'ready'
                                order by pf.created_at desc limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)) x
                         join public.project_files pf on pf.id = x.id
                         join public.company_files f on f.id = pf.file_id), '[]'),
    'read_only', (select read_only from portal_private.visible_projects(v_person) where project_id = p_project));
end; $$;

-- Dépôt client, étape 1 : document « en attente » dans la fiche du projet, chemin de stockage aléatoire.
create or replace function public.portal_file_start(
  p_server_key text, p_session_hash text, p_project uuid, p_folder uuid, p_task uuid, p_name text, p_type text, p_size bigint, p_ext text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  v_company uuid;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  if p_size is null or p_size <= 0 or p_size > 26214400 then raise exception 'Fichier vide ou trop volumineux (25 Mo maximum)' using errcode = '22023'; end if;
  if p_type is null or p_type not in (
       'application/pdf','image/png','image/jpeg','image/webp','image/gif','application/msword',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint',
       'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','text/csv','application/zip') then
    raise exception 'Format non autorisé' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Nom de fichier manquant' using errcode = '22023'; end if;
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  if p_task is not null and not exists (select 1 from public.project_tasks where id = p_task and project_id = p_project and visible_to_client) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  -- limite de débit : 50 dépôts par heure et par personne
  if (select count(*) from public.company_files where uploaded_by_person = v_person and created_at > now() - interval '1 hour') >= 50 then
    raise exception 'Trop de dépôts en peu de temps : réessayez dans une heure' using errcode = '22023';
  end if;
  select company_id into v_company from public.projects where id = p_project;
  v_path := v_company::text || '/' || v_id::text || '.' || coalesce(nullif(lower(regexp_replace(coalesce(p_ext, ''), '[^a-zA-Z0-9]', '', 'g')), ''), 'bin');
  insert into public.company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status, uploaded_by_kind, uploaded_by_person)
  values (v_id, v_company, v_path, left(btrim(p_name), 200), p_type, p_size, 'pending', 'client', v_person);
  -- la référence projet est préparée maintenant (dossier, tâche) mais le fichier n'apparaît qu'une fois « prêt »
  insert into public.project_files (project_id, file_id, folder_id, task_id, shared_by_kind, shared_by_person)
  values (p_project, v_id, p_folder, p_task, 'client', v_person);
  return jsonb_build_object('file_id', v_id, 'path', v_path);
end; $$;

-- Dépôt client, étape 2 : l'objet doit réellement exister dans Storage
create or replace function public.portal_file_confirm(p_server_key text, p_session_hash text, p_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  f public.company_files;
  pf public.project_files;
begin
  select * into f from public.company_files where id = p_file and uploaded_by_person = v_person and status = 'pending' for update;
  if not found then raise exception 'Dépôt introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'company-files' and o.name = f.storage_path) then
    raise exception 'Le fichier n''a pas été reçu par le stockage' using errcode = '22023';
  end if;
  update public.company_files set status = 'ready' where id = p_file returning * into f;
  select * into pf from public.project_files where file_id = p_file;
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_uploaded', jsonb_build_object('file_id', p_file, 'name', f.display_name));
  return portal_private.file_json(pf, f, v_person);
end; $$;

-- Transfert échoué : aucune pièce fantôme (l'objet éventuel est retiré par le nettoyage habituel)
create or replace function public.portal_file_abort(p_server_key text, p_session_hash text, p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  delete from public.company_files where id = p_file and uploaded_by_person = v_person and status = 'pending';
end; $$;

-- Lien temporaire : vérifie le partage, puis autorise la lecture de CET objet pendant 60 secondes
create or replace function public.portal_file_grant(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  r record;
begin
  select pf.project_id, f.storage_path, f.display_name, f.mime_type into r
    from public.project_files pf join public.company_files f on f.id = pf.file_id
   where pf.id = p_project_file and f.status = 'ready';
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, r.project_id);
  delete from public.portal_storage_grants where expires_at < now() - interval '1 hour';
  insert into public.portal_storage_grants (object_name, action, expires_at) values (r.storage_path, 'read', now() + interval '60 seconds');
  return jsonb_build_object('path', r.storage_path, 'name', r.display_name, 'mime_type', r.mime_type);
end; $$;

-- Dépôts du client : renommer, déplacer, supprimer les siens uniquement
create or replace function public.portal_file_update(p_server_key text, p_session_hash text, p_project_file uuid, p_name text, p_folder uuid, p_move boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez modifier que vos propres dépôts' using errcode = '42501';
  end if;
  if p_name is not null then
    if coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 then raise exception 'Nom invalide' using errcode = '22023'; end if;
    update public.company_files set display_name = btrim(p_name) where id = f.id returning * into f;
  end if;
  if p_move then
    update public.project_files set folder_id = p_folder where id = pf.id returning * into pf;
  end if;
  return portal_private.file_json(pf, f, v_person);
end; $$;

-- Suppression d'un dépôt par son auteur : invisible aussitôt, objet retiré par le serveur (autorisation de 60 s)
create or replace function public.portal_file_delete(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id for update;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez supprimer que vos propres dépôts' using errcode = '42501';
  end if;
  update public.company_files set status = 'deleting' where id = f.id;
  -- une suppression filtrée exige aussi la visibilité de la ligne (lecture), pour ce seul objet
  insert into public.portal_storage_grants (object_name, action, expires_at)
  values (f.storage_path, 'delete', now() + interval '60 seconds'), (f.storage_path, 'read', now() + interval '60 seconds');
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_deleted', jsonb_build_object('name', f.display_name));
  return jsonb_build_object('path', f.storage_path, 'file_id', f.id);
end; $$;

-- Après retrait de l'objet : la ligne disparaît (sinon le nettoyage administrateur la reprendra)
create or replace function public.portal_file_purge(p_server_key text, p_session_hash text, p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  delete from public.company_files f where f.id = p_file and f.status = 'deleting' and f.uploaded_by_person = v_person
     and not exists (select 1 from storage.objects o where o.bucket_id = 'company-files' and o.name = f.storage_path);
end; $$;

-- Vue d'administration des fichiers d'un projet
create or replace view public.project_file_overview with (security_invoker = true) as
  select pf.id, pf.project_id, pf.file_id, pf.folder_id, pf.task_id, pf.shared_by_kind, pf.created_at as shared_at,
         f.display_name, f.mime_type, f.size_bytes, f.status, f.uploaded_by_kind, f.created_at,
         case when f.uploaded_by_kind = 'client' then btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) else 'Vous' end as author
    from public.project_files pf
    join public.company_files f on f.id = pf.file_id
    left join public.people pe on pe.id = f.uploaded_by_person
   where f.status = 'ready';
revoke all on public.project_file_overview from anon;
grant select on public.project_file_overview to authenticated;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'portal_files(text, text, uuid, int, int)', 'portal_file_start(text, text, uuid, uuid, uuid, text, text, bigint, text)',
    'portal_file_confirm(text, text, uuid)', 'portal_file_abort(text, text, uuid)', 'portal_file_grant(text, text, uuid)',
    'portal_file_update(text, text, uuid, text, uuid, boolean)', 'portal_file_delete(text, text, uuid)', 'portal_file_purge(text, text, uuid)',
    'portal_storage_can_upload(text)', 'portal_storage_can(text, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;


-- ===== 20261107000500_projets_idees.sql =====
-- Projets et portail client — phase 5 : boîte à idées. Migration additive.
-- Tout membre autorisé propose et commente ; l'auteur modifie son idée tant qu'elle est « à explorer » ;
-- seul l'administrateur décide du statut (avec une explication) et transforme une idée en tâche.

create table public.project_ideas (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  description text check (description is null or char_length(description) <= 4000),
  status text not null default 'a_explorer' check (status in ('a_explorer','retenue','plus_tard','ecartee')),
  decision_note text check (decision_note is null or char_length(decision_note) <= 1000),
  author_kind text not null check (author_kind in ('owner','client')),
  author_person uuid references public.people (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_ideas_idx on public.project_ideas (project_id, created_at desc);

create table public.project_idea_comments (
  id uuid primary key default gen_random_uuid(),
  idea_id uuid not null references public.project_ideas (id) on delete cascade,
  author_kind text not null check (author_kind in ('owner','client')),
  person_id uuid references public.people (id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index project_idea_comments_idx on public.project_idea_comments (idea_id, created_at);

-- idée transformée en tâche : lien d'origine, une seule tâche par idée
alter table public.project_tasks add column idea_id uuid references public.project_ideas (id) on delete set null;
create unique index project_tasks_idea_uniq on public.project_tasks (idea_id) where idea_id is not null;

create trigger set_updated_at before update on public.project_ideas for each row execute function public.tg_set_updated_at();

do $$
declare t text;
begin
  foreach t in array array['project_ideas','project_idea_comments']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'') with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

create or replace function portal_private.person_name(p uuid)
returns text language sql stable set search_path = '' as $$
  select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) from public.people where id = p;
$$;

create or replace function portal_private.idea_json(i public.project_ideas, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'title', i.title, 'description', i.description, 'status', i.status, 'decision_note', i.decision_note,
    'created_at', i.created_at, 'updated_at', i.updated_at,
    'author', case when i.author_kind = 'owner' then 'Cely Growth' else portal_private.person_name(i.author_person) end,
    'mine', i.author_kind = 'client' and i.author_person = p_person,
    'can_edit', i.author_kind = 'client' and i.author_person = p_person and i.status = 'a_explorer',
    'has_task', exists (select 1 from public.project_tasks t where t.idea_id = i.id),
    'comments', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'body', c.body, 'created_at', c.created_at,
        'author', case when c.author_kind = 'owner' then 'Cely Growth' else portal_private.person_name(c.person_id) end) order by c.created_at)
      from public.project_idea_comments c where c.idea_id = i.id), '[]'));
$$;

create or replace function public.portal_ideas(p_server_key text, p_session_hash text, p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return coalesce((select jsonb_agg(portal_private.idea_json(i, v_person) order by i.created_at desc)
                     from (select * from public.project_ideas where project_id = p_project order by created_at desc limit 200) i), '[]');
end; $$;

create or replace function public.portal_idea_save(p_server_key text, p_session_hash text, p_project uuid, p_idea uuid, p_title text, p_description text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  i public.project_ideas;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  if coalesce(btrim(p_title), '') = '' or char_length(p_title) > 160 then raise exception 'Titre obligatoire (160 caractères maximum)' using errcode = '22023'; end if;
  if char_length(coalesce(p_description, '')) > 4000 then raise exception 'Description trop longue' using errcode = '22023'; end if;
  if p_idea is null then
    if (select count(*) from public.project_ideas where author_person = v_person and created_at > now() - interval '1 hour') >= 20 then
      raise exception 'Beaucoup d''idées en peu de temps : réessayez plus tard' using errcode = '22023';
    end if;
    insert into public.project_ideas (project_id, title, description, author_kind, author_person)
    values (p_project, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), 'client', v_person) returning * into i;
    perform portal_private.log(p_project, 'client', v_person, 'idea_created', jsonb_build_object('idea_id', i.id));
  else
    select * into i from public.project_ideas where id = p_idea and project_id = p_project for update;
    if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
    if i.author_kind <> 'client' or i.author_person is distinct from v_person then raise exception 'Seul l''auteur peut modifier cette idée' using errcode = '42501'; end if;
    if i.status <> 'a_explorer' then raise exception 'Une décision a été prise : l''idée n''est plus modifiable, ajoutez plutôt un commentaire' using errcode = '42501'; end if;
    update public.project_ideas set title = btrim(p_title), description = nullif(btrim(coalesce(p_description, '')), '') where id = i.id returning * into i;
  end if;
  return portal_private.idea_json(i, v_person);
end; $$;

create or replace function public.portal_idea_comment(p_server_key text, p_session_hash text, p_project uuid, p_idea uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  i public.project_ideas;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  select * into i from public.project_ideas where id = p_idea and project_id = p_project;
  if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
  if coalesce(btrim(p_body), '') = '' or char_length(p_body) > 1000 then raise exception 'Commentaire vide ou trop long (1 000 caractères)' using errcode = '22023'; end if;
  insert into public.project_idea_comments (idea_id, author_kind, person_id, body) values (i.id, 'client', v_person, btrim(p_body));
  return portal_private.idea_json(i, v_person);
end; $$;

-- Administration : idée → tâche, sans doublon, avec le lien d'origine
create or replace function public.project_idea_to_task(p_idea uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  i public.project_ideas;
  v_id uuid;
begin
  perform portal_private.assert_owner_user();
  select * into i from public.project_ideas where id = p_idea for update;
  if not found then raise exception 'Idée introuvable' using errcode = 'P0002'; end if;
  select id into v_id from public.project_tasks where idea_id = p_idea;
  if v_id is not null then return v_id; end if;
  insert into public.project_tasks (project_id, title, description, idea_id, assignee_kind, visible_to_client)
  values (i.project_id, left(i.title, 300), i.description, i.id, 'owner', true) returning id into v_id;
  if i.status = 'a_explorer' then update public.project_ideas set status = 'retenue' where id = i.id; end if;
  perform portal_private.log(i.project_id, 'owner', null, 'idea_to_task', jsonb_build_object('idea_id', i.id, 'task_id', v_id));
  return v_id;
end; $$;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['portal_ideas(text, text, uuid)', 'portal_idea_save(text, text, uuid, uuid, text, text)', 'portal_idea_comment(text, text, uuid, uuid, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  execute 'revoke all on function public.project_idea_to_task(uuid) from public, anon';
  execute 'grant execute on function public.project_idea_to_task(uuid) to authenticated';
end $$;


-- ===== 20261107000600_projets_dossiers_points.sql =====
-- Projets et portail client — ajustements : dossiers partagés ou internes, dépôt client par dossier,
-- déplacements contrôlés, et « Mes prochains points » sur plusieurs projets. Migration additive.
--
-- Règle de visibilité d'un document de projet pour le client :
--   * à la racine du projet : visible (comportement existant inchangé) ;
--   * dans un dossier : visible seulement si ce dossier ET son parent éventuel sont partagés.
-- Un document ne devient JAMAIS visible par effet de bord : un déplacement, une suppression de dossier ou
-- le partage d'un dossier qui exposerait un document jusqu'ici interne exige une confirmation explicite,
-- vérifiée en base (déclencheurs), pas seulement dans l'interface.

-- Les dossiers existants restent partagés et ouverts au dépôt (comportement actuel) ;
-- les nouveaux dossiers sont internes et fermés au dépôt tant que rien n'est choisi.
alter table public.project_folders
  add column visible_to_client boolean not null default true,
  add column client_can_upload boolean not null default true;
alter table public.project_folders
  alter column visible_to_client set default false,
  alter column client_can_upload set default false;

-- Dossier visible du client (null = racine du projet)
create or replace function portal_private.folder_visible(p_folder uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_folder is null or exists (
    select 1 from public.project_folders f left join public.project_folders pa on pa.id = f.parent_id
     where f.id = p_folder and f.visible_to_client and (f.parent_id is null or pa.visible_to_client));
$$;

-- Dépôt client autorisé dans ce dossier (racine : oui, comme aujourd'hui)
create or replace function portal_private.folder_uploadable(p_folder uuid)
returns boolean language sql stable set search_path = '' as $$
  select p_folder is null or (portal_private.folder_visible(p_folder)
    and exists (select 1 from public.project_folders where id = p_folder and client_can_upload));
$$;

-- Confirmation explicite, valable pour la transaction en cours seulement
create or replace function portal_private.exposure_confirmed()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('cely.confirm_expose', true), '') = 'on';
$$;

-- Garde-fou 1 : déplacer un document interne vers un emplacement visible exige une confirmation
create or replace function portal_private.tg_project_file_move()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.folder_id is distinct from old.folder_id
     and not portal_private.folder_visible(old.folder_id) and portal_private.folder_visible(new.folder_id)
     and not portal_private.exposure_confirmed() then
    raise exception 'Ce déplacement rendrait un document interne visible du client : confirmation requise' using errcode = '42501';
  end if;
  return new;
end; $$;
create trigger project_files_exposure before update of folder_id on public.project_files
  for each row execute function portal_private.tg_project_file_move();

-- Garde-fou 2 : partager un dossier (ou le rattacher à un dossier partagé) qui contient des documents
-- jusqu'ici internes exige une confirmation
create or replace function portal_private.tg_folder_exposure()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_before boolean; v_after boolean;
begin
  v_before := old.visible_to_client and (old.parent_id is null or exists (select 1 from public.project_folders where id = old.parent_id and visible_to_client));
  v_after := new.visible_to_client and (new.parent_id is null or exists (select 1 from public.project_folders where id = new.parent_id and visible_to_client));
  if not v_before and v_after and not portal_private.exposure_confirmed() and exists (
       select 1 from public.project_files pf left join public.project_folders s on s.id = pf.folder_id
        where pf.folder_id = new.id
           or (s.parent_id = new.id and s.visible_to_client)) then
    raise exception 'Partager ce dossier rendrait des documents internes visibles du client : confirmation requise' using errcode = '42501';
  end if;
  return new;
end; $$;
create trigger project_folders_exposure before update of visible_to_client, parent_id on public.project_folders
  for each row execute function portal_private.tg_folder_exposure();

-- Garde-fou 3 : un dossier non vide ne se supprime pas directement (ses documents remonteraient à la
-- racine, visible). La suppression d'un projet entier reste possible.
create or replace function portal_private.tg_folder_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.project_files where folder_id = old.id)
     and exists (select 1 from public.projects where id = old.project_id) then
    raise exception 'Dossier non vide : choisissez d''abord où déplacer ses fichiers' using errcode = '23503';
  end if;
  return old;
end; $$;
create trigger project_folders_no_orphans before delete on public.project_folders
  for each row execute function portal_private.tg_folder_delete();

-- ---------------------------------------------------------------------------
-- Administration
-- ---------------------------------------------------------------------------

-- Nombre de documents qu'un déplacement vers p_target rendrait visibles (jusqu'ici internes)
create or replace function portal_private.exposed_count(p_ids uuid[], p_target uuid)
returns int language sql stable set search_path = '' as $$
  select case when portal_private.folder_visible(p_target)
              then (select count(*)::int from public.project_files where id = any (p_ids) and not portal_private.folder_visible(folder_id))
              else 0 end;
$$;

-- Créer ou modifier un dossier. Renvoie {"id"} ou, si le partage exposerait des documents internes sans
-- confirmation, {"confirm": n} sans rien modifier.
create or replace function public.project_folder_save(
  p_project uuid, p_folder uuid, p_name text, p_parent uuid, p_visible boolean, p_upload boolean, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.project_folders;
  v_n int;
begin
  perform portal_private.assert_owner_user();
  if coalesce(btrim(p_name), '') = '' or char_length(btrim(p_name)) > 80 then raise exception 'Nom de dossier obligatoire (80 caractères maximum)' using errcode = '22023'; end if;
  if p_folder is null then
    if not exists (select 1 from public.projects where id = p_project) then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
    if exists (select 1 from public.project_folders where project_id = p_project and parent_id is not distinct from p_parent and lower(name) = lower(btrim(p_name))) then
      raise exception 'Un dossier porte déjà ce nom à cet endroit' using errcode = '22023';
    end if;
    insert into public.project_folders (project_id, parent_id, name, visible_to_client, client_can_upload)
    values (p_project, p_parent, btrim(p_name), coalesce(p_visible, false), coalesce(p_visible, false) and coalesce(p_upload, false))
    returning * into f;
    perform portal_private.log(p_project, 'owner', null, 'folder_created', jsonb_build_object('folder_id', f.id, 'name', f.name));
    return jsonb_build_object('id', f.id);
  end if;
  select * into f from public.project_folders where id = p_folder and project_id = p_project for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if exists (select 1 from public.project_folders where project_id = p_project and id <> f.id and parent_id is not distinct from f.parent_id and lower(name) = lower(btrim(p_name))) then
    raise exception 'Un dossier porte déjà ce nom à cet endroit' using errcode = '22023';
  end if;
  if coalesce(p_visible, f.visible_to_client) and not f.visible_to_client and not coalesce(p_confirm, false) then
    select count(*)::int into v_n from public.project_files pf left join public.project_folders s on s.id = pf.folder_id
     where pf.folder_id = f.id or (s.parent_id = f.id and s.visible_to_client);
    if v_n > 0 and (f.parent_id is null or portal_private.folder_visible(f.parent_id)) then
      return jsonb_build_object('confirm', v_n);
    end if;
  end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  update public.project_folders
     set name = btrim(p_name),
         visible_to_client = coalesce(p_visible, visible_to_client),
         client_can_upload = coalesce(p_visible, visible_to_client) and coalesce(p_upload, client_can_upload)
   where id = f.id returning * into f;
  perform set_config('cely.confirm_expose', '', true);
  return jsonb_build_object('id', f.id);
end; $$;

-- Déplacer des documents du projet. {"moved": n} ou {"confirm": n} (rien n'est déplacé).
create or replace function public.project_files_move(p_project uuid, p_ids uuid[], p_folder uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_n int; v_moved int;
begin
  perform portal_private.assert_owner_user();
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  v_n := portal_private.exposed_count(array(select id from public.project_files where id = any (p_ids) and project_id = p_project), p_folder);
  if v_n > 0 and not coalesce(p_confirm, false) then return jsonb_build_object('confirm', v_n); end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  update public.project_files set folder_id = p_folder where id = any (p_ids) and project_id = p_project and folder_id is distinct from p_folder;
  get diagnostics v_moved = row_count;
  perform set_config('cely.confirm_expose', '', true);
  if v_moved > 0 then
    perform portal_private.log(p_project, 'owner', null, 'files_moved', jsonb_build_object('count', v_moved, 'folder_id', p_folder));
  end if;
  return jsonb_build_object('moved', v_moved);
end; $$;

-- Supprimer un dossier (et son sous-dossier éventuel) après avoir déplacé ses documents vers p_target
-- (null = racine). {"deleted": true} ou {"confirm": n}.
create or replace function public.project_folder_delete(p_folder uuid, p_target uuid, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  f public.project_folders;
  v_ids uuid[];
  v_n int;
begin
  perform portal_private.assert_owner_user();
  select * into f from public.project_folders where id = p_folder for update;
  if not found then raise exception 'Dossier introuvable' using errcode = 'P0002'; end if;
  if p_target is not null and not exists (
       select 1 from public.project_folders where id = p_target and project_id = f.project_id and id <> f.id and parent_id is distinct from f.id) then
    raise exception 'Destination invalide' using errcode = '22023';
  end if;
  v_ids := array(select pf.id from public.project_files pf join public.project_folders d on d.id = pf.folder_id
                  where d.id = f.id or d.parent_id = f.id);
  v_n := portal_private.exposed_count(v_ids, p_target);
  if v_n > 0 and not coalesce(p_confirm, false) then return jsonb_build_object('confirm', v_n); end if;
  if coalesce(p_confirm, false) then perform set_config('cely.confirm_expose', 'on', true); end if;
  update public.project_files set folder_id = p_target where id = any (v_ids);
  perform set_config('cely.confirm_expose', '', true);
  delete from public.project_folders where id = f.id;
  perform portal_private.log(f.project_id, 'owner', null, 'folder_deleted', jsonb_build_object('name', f.name, 'moved', coalesce(array_length(v_ids, 1), 0)));
  return jsonb_build_object('deleted', true, 'moved', coalesce(array_length(v_ids, 1), 0));
end; $$;

-- ---------------------------------------------------------------------------
-- Portail : seuls les dossiers partagés et leurs documents existent pour le client
-- ---------------------------------------------------------------------------

create or replace function public.portal_files(p_server_key text, p_session_hash text, p_project uuid, p_limit int default 200, p_offset int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  perform portal_private.assert_project(v_person, p_project);
  return jsonb_build_object(
    'folders', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'parent_id', parent_id,
                                                             'upload', portal_private.folder_uploadable(id)) order by name)
                           from public.project_folders where project_id = p_project and portal_private.folder_visible(id)), '[]'),
    'total', (select count(*) from public.project_files pf join public.company_files f on f.id = pf.file_id
               where pf.project_id = p_project and f.status = 'ready' and portal_private.folder_visible(pf.folder_id)),
    'files', coalesce((select jsonb_agg(portal_private.file_json(pf, f, v_person) order by pf.created_at desc)
                         from (select pf.id from public.project_files pf join public.company_files f on f.id = pf.file_id
                                where pf.project_id = p_project and f.status = 'ready' and portal_private.folder_visible(pf.folder_id)
                                order by pf.created_at desc limit greatest(1, least(p_limit, 500)) offset greatest(p_offset, 0)) x
                         join public.project_files pf on pf.id = x.id
                         join public.company_files f on f.id = pf.file_id), '[]'),
    'read_only', (select read_only from portal_private.visible_projects(v_person) where project_id = p_project));
end; $$;

create or replace function public.portal_file_start(
  p_server_key text, p_session_hash text, p_project uuid, p_folder uuid, p_task uuid, p_name text, p_type text, p_size bigint, p_ext text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  v_company uuid;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform portal_private.assert_project(v_person, p_project, true);
  if p_size is null or p_size <= 0 or p_size > 26214400 then raise exception 'Fichier vide ou trop volumineux (25 Mo maximum)' using errcode = '22023'; end if;
  if p_type is null or p_type not in (
       'application/pdf','image/png','image/jpeg','image/webp','image/gif','application/msword',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint',
       'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','text/csv','application/zip') then
    raise exception 'Format non autorisé' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then raise exception 'Nom de fichier manquant' using errcode = '22023'; end if;
  if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = p_project and portal_private.folder_visible(id)) then
    raise exception 'Dossier introuvable' using errcode = 'P0002';
  end if;
  if not portal_private.folder_uploadable(p_folder) then
    raise exception 'Le dépôt n''est pas ouvert dans ce dossier' using errcode = '42501';
  end if;
  if p_task is not null and not exists (select 1 from public.project_tasks where id = p_task and project_id = p_project and visible_to_client) then
    raise exception 'Tâche introuvable' using errcode = 'P0002';
  end if;
  if (select count(*) from public.company_files where uploaded_by_person = v_person and created_at > now() - interval '1 hour') >= 50 then
    raise exception 'Trop de dépôts en peu de temps : réessayez dans une heure' using errcode = '22023';
  end if;
  select company_id into v_company from public.projects where id = p_project;
  v_path := v_company::text || '/' || v_id::text || '.' || coalesce(nullif(lower(regexp_replace(coalesce(p_ext, ''), '[^a-zA-Z0-9]', '', 'g')), ''), 'bin');
  insert into public.company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status, uploaded_by_kind, uploaded_by_person)
  values (v_id, v_company, v_path, left(btrim(p_name), 200), p_type, p_size, 'pending', 'client', v_person);
  insert into public.project_files (project_id, file_id, folder_id, task_id, shared_by_kind, shared_by_person)
  values (p_project, v_id, p_folder, p_task, 'client', v_person);
  return jsonb_build_object('file_id', v_id, 'path', v_path);
end; $$;

create or replace function public.portal_file_grant(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  r record;
begin
  select pf.project_id, pf.folder_id, f.storage_path, f.display_name, f.mime_type into r
    from public.project_files pf join public.company_files f on f.id = pf.file_id
   where pf.id = p_project_file and f.status = 'ready';
  if not found or not portal_private.folder_visible(r.folder_id) then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, r.project_id);
  delete from public.portal_storage_grants where expires_at < now() - interval '1 hour';
  insert into public.portal_storage_grants (object_name, action, expires_at) values (r.storage_path, 'read', now() + interval '60 seconds');
  return jsonb_build_object('path', r.storage_path, 'name', r.display_name, 'mime_type', r.mime_type);
end; $$;

create or replace function public.portal_file_update(p_server_key text, p_session_hash text, p_project_file uuid, p_name text, p_folder uuid, p_move boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found or not portal_private.folder_visible(pf.folder_id) then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez modifier que vos propres dépôts' using errcode = '42501';
  end if;
  if p_name is not null then
    if coalesce(btrim(p_name), '') = '' or char_length(p_name) > 200 then raise exception 'Nom invalide' using errcode = '22023'; end if;
    update public.company_files set display_name = btrim(p_name) where id = f.id returning * into f;
  end if;
  if p_move then
    if p_folder is not null and not exists (select 1 from public.project_folders where id = p_folder and project_id = pf.project_id and portal_private.folder_visible(id)) then
      raise exception 'Dossier introuvable' using errcode = 'P0002';
    end if;
    if not portal_private.folder_uploadable(p_folder) then raise exception 'Le dépôt n''est pas ouvert dans ce dossier' using errcode = '42501'; end if;
    update public.project_files set folder_id = p_folder where id = pf.id returning * into pf;
  end if;
  return portal_private.file_json(pf, f, v_person);
end; $$;

create or replace function public.portal_file_delete(p_server_key text, p_session_hash text, p_project_file uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  pf public.project_files;
  f public.company_files;
begin
  select * into pf from public.project_files where id = p_project_file;
  if not found or not portal_private.folder_visible(pf.folder_id) then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  perform portal_private.assert_project(v_person, pf.project_id, true);
  select * into f from public.company_files where id = pf.file_id for update;
  if f.uploaded_by_kind <> 'client' or f.uploaded_by_person is distinct from v_person then
    raise exception 'Vous ne pouvez supprimer que vos propres dépôts' using errcode = '42501';
  end if;
  update public.company_files set status = 'deleting' where id = f.id;
  insert into public.portal_storage_grants (object_name, action, expires_at)
  values (f.storage_path, 'delete', now() + interval '60 seconds'), (f.storage_path, 'read', now() + interval '60 seconds');
  perform portal_private.log(pf.project_id, 'client', v_person, 'file_deleted', jsonb_build_object('name', f.display_name));
  return jsonb_build_object('path', f.storage_path, 'file_id', f.id);
end; $$;

-- Vue d'administration : emplacement visible ou non du client
create or replace view public.project_file_overview with (security_invoker = true) as
  select pf.id, pf.project_id, pf.file_id, pf.folder_id, pf.task_id, pf.shared_by_kind, pf.created_at as shared_at,
         f.display_name, f.mime_type, f.size_bytes, f.status, f.uploaded_by_kind, f.created_at,
         case when f.uploaded_by_kind = 'client' then btrim(coalesce(pe.first_name, '') || ' ' || coalesce(pe.last_name, '')) else 'Vous' end as author,
         (pf.folder_id is null or (d.visible_to_client and (d.parent_id is null or dp.visible_to_client))) as visible_to_client
    from public.project_files pf
    join public.company_files f on f.id = pf.file_id
    left join public.people pe on pe.id = f.uploaded_by_person
    left join public.project_folders d on d.id = pf.folder_id
    left join public.project_folders dp on dp.id = d.parent_id
   where f.status = 'ready';
revoke all on public.project_file_overview from anon;
grant select on public.project_file_overview to authenticated;

-- ---------------------------------------------------------------------------
-- « Mes prochains points » : points à venir, partagés, de tous les projets visibles (sans doublon :
-- un rendez-vous n'est rattaché qu'à un seul projet). Annulés exclus ; reportés lus en direct.
-- ---------------------------------------------------------------------------
create or replace function public.portal_upcoming_meetings(p_server_key text, p_session_hash text, p_limit int default 3)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
begin
  return coalesce((
    select jsonb_agg(x.j order by x.starts_at)
      from (select portal_private.meeting_json(m, b, false) || jsonb_build_object('project_id', p.id, 'project_name', p.name) as j, b.starts_at
              from portal_private.visible_projects(v_person) v
              join public.projects p on p.id = v.project_id
              join public.project_meetings m on m.project_id = p.id and m.visible_to_client
              join public.appt_bookings b on b.id = m.booking_id
             where b.status = 'confirmed' and b.ends_at > now() and b.outcome is distinct from 'done'
             order by b.starts_at
             limit greatest(1, least(coalesce(p_limit, 3), 10))) x), '[]');
end; $$;

revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'portal_files(text, text, uuid, int, int)', 'portal_file_start(text, text, uuid, uuid, uuid, text, text, bigint, text)',
    'portal_file_grant(text, text, uuid)', 'portal_file_update(text, text, uuid, text, uuid, boolean)',
    'portal_file_delete(text, text, uuid)', 'portal_upcoming_meetings(text, text, int)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  foreach f in array array['project_folder_save(uuid, uuid, text, uuid, boolean, boolean, boolean)',
                           'project_files_move(uuid, uuid[], uuid, boolean)', 'project_folder_delete(uuid, uuid, boolean)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
