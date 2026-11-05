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

create or replace function public.appt_owner_slots(p_type uuid, p_from timestamptz, p_to timestamptz, p_busy jsonb default '[]', p_exclude_booking uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  if p_to - p_from > interval '62 days' then raise exception 'Période trop longue' using errcode = '22023'; end if;
  return coalesce((select jsonb_agg(s.slot order by s.slot) from appt_private.compute_slots(p_type, p_from, p_to, p_busy, p_exclude_booking) s), '[]');
end;
$$;

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
    'appt_owner_slots(uuid, timestamptz, timestamptz, jsonb, uuid)', 'appt_set_outcome(uuid, text)',
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
