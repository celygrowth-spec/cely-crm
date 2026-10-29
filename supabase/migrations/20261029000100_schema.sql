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
