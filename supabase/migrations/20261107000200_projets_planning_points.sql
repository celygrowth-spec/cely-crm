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
