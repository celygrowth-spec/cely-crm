-- Fireflies, phase 1 : import automatique des appels (voir docs/integrations/fireflies.md).
--
-- Flux : le webhook enregistre une tâche (fireflies_enqueue) AVANT d'accuser réception ; le serveur
-- la prend (fireflies_claim_jobs), interroge Fireflies, puis enregistre l'appel, sa transcription et
-- la fin de la tâche dans une seule transaction (fireflies_store_call).
--
-- Accès :
-- - le webhook et le traitement n'ont pas de session : ils passent par le rôle anon avec la clé serveur
--   du module Rendez-vous (appt_private.assert_server). Ces fonctions écrivent et ne rendent jamais de
--   résumé ni de transcription : une fuite de cette clé ne donne pas accès au contenu des appels ;
-- - lecture directe réservée au propriétaire dans l'application : ni le connecteur Claude, ni le portail
--   client (rôle anon), ni un autre compte n'y accèdent.

create table public.fireflies_connection (
  id boolean primary key default true check (id),
  account_id text,
  account_email text,
  last_webhook_at timestamptz,
  last_success_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  -- Fireflies a répondu 429 : plus aucun appel avant cette date (un appel pendant le blocage le prolonge)
  api_paused_until timestamptz,
  updated_at timestamptz not null default now()
);
insert into public.fireflies_connection (id) values (true);

-- Un appel par identifiant Fireflies dans le compte connecté. Les doublons sont impossibles en base.
create table public.fireflies_calls (
  id uuid primary key default gen_random_uuid(),
  account_id text not null check (char_length(account_id) between 1 and 200),
  fireflies_id text not null check (char_length(fireflies_id) between 1 and 200),
  title text not null check (char_length(title) <= 500),
  occurred_at timestamptz,
  duration_minutes numeric check (duration_minutes is null or duration_minutes >= 0),
  organizer_email text,
  participants text[] not null default '{}',
  attendees jsonb not null default '[]' check (jsonb_typeof(attendees) = 'array'),
  speakers jsonb not null default '[]' check (jsonb_typeof(speakers) = 'array'),
  -- lien vérifié côté serveur (https, domaine fireflies.ai) ; contrôle repris ici en dernière barrière
  transcript_url text check (transcript_url is null or transcript_url ~ '^https://([a-z0-9-]+\.)*fireflies\.ai(/|$)'),
  meeting_link text,
  calendar_event_id text,
  calendar_type text,
  silent boolean not null default false,
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object'),
  summary_state text not null default 'pending' check (summary_state in ('pending', 'available', 'unavailable')),
  summary_status text,
  summary_updated_at timestamptz,
  line_count integer not null default 0 check (line_count >= 0),
  last_imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (account_id, fireflies_id)
);
create index fireflies_calls_recent on public.fireflies_calls (occurred_at desc nulls last);

-- À part : la liste des appels ne charge jamais les transcriptions. Remplacée d'un bloc, jamais partielle.
create table public.fireflies_call_transcripts (
  call_id uuid primary key references public.fireflies_calls (id) on delete cascade,
  lines jsonb not null check (jsonb_typeof(lines) = 'array'),
  updated_at timestamptz not null default now()
);

-- Une tâche par réunion : webhooks répétés et résumé tardif réactivent la même ligne.
create table public.fireflies_import_jobs (
  id uuid primary key default gen_random_uuid(),
  meeting_id text not null unique check (char_length(meeting_id) between 1 and 200),
  source text not null default 'webhook' check (source in ('webhook', 'sync')),
  status text not null default 'pending' check (status in ('pending', 'running', 'waiting_summary', 'done', 'failed')),
  -- dernier événement vu : { "meeting.transcribed": <reprocessed_at, 0 pour une première livraison>, … }
  seen_events jsonb not null default '{}' check (jsonb_typeof(seen_events) = 'object'),
  -- un événement est arrivé pendant le traitement : à refaire ensuite, pour ne rien perdre
  rerun boolean not null default false,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lock_token uuid,
  locked_until timestamptz,
  summary_deadline timestamptz,
  last_error_code text,
  last_error text check (last_error is null or char_length(last_error) <= 300),
  call_id uuid references public.fireflies_calls (id) on delete set null,
  received_at timestamptz not null default now(),
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index fireflies_jobs_due on public.fireflies_import_jobs (next_attempt_at) where status in ('pending', 'waiting_summary', 'running');
create index fireflies_jobs_call on public.fireflies_import_jobs (call_id);

-- États affichés : En cours d'import / Résumé en attente / Importé / Échec. Un appel déjà importé garde
-- son contenu et reste consultable pendant qu'une mise à jour se prépare.
create view public.fireflies_import_overview with (security_invoker = true) as
select j.id as job_id, j.meeting_id, j.source, j.status as job_status, j.attempts, j.next_attempt_at,
       j.last_error_code, j.last_error, j.received_at, j.finished_at, j.updated_at,
       c.id as call_id, c.title, c.occurred_at, c.line_count, c.summary_state,
       case
         when j.status = 'failed' then 'failed'
         when c.id is null then 'importing'
         when c.summary_state = 'pending' then 'summary_pending'
         else 'imported'
       end as display_state
  from public.fireflies_import_jobs j
  left join public.fireflies_calls c on c.id = j.call_id;

-- Lecture réservée au propriétaire dans l'application. Aucune écriture directe, y compris pour lui :
-- tout passe par les fonctions ci-dessous.
do $$
declare t text;
begin
  foreach t in array array['fireflies_connection', 'fireflies_calls', 'fireflies_call_transcripts', 'fireflies_import_jobs']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_app_select on public.%I for select to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;
revoke all on public.fireflies_import_overview from public, anon, authenticated;
grant select on public.fireflies_import_overview to authenticated;

-- ---------------------------------------------------------------------------
-- Enregistrement d'un événement. Rend : queued, rerun, duplicate.
-- ---------------------------------------------------------------------------

create or replace function public.fireflies_enqueue(
  p_server_key text, p_meeting_id text, p_event text, p_reprocessed_at bigint default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.fireflies_import_jobs;
  v_new boolean;
  v_stamp bigint := coalesce(p_reprocessed_at, 0);
begin
  perform appt_private.assert_server(p_server_key);
  if p_meeting_id is null or p_meeting_id !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'Identifiant Fireflies invalide' using errcode = '22023';
  end if;
  if p_event not in ('meeting.transcribed', 'meeting.summarized', 'sync') then
    raise exception 'Événement Fireflies inconnu' using errcode = '22023';
  end if;

  insert into public.fireflies_import_jobs (meeting_id, source, seen_events)
  values (p_meeting_id, case when p_event = 'sync' then 'sync' else 'webhook' end,
          case when p_event = 'sync' then '{}'::jsonb else jsonb_build_object(p_event, v_stamp) end)
  on conflict (meeting_id) do nothing
  returning * into v_job;
  v_new := found;

  if p_event <> 'sync' then
    update public.fireflies_connection set last_webhook_at = now(), updated_at = now() where id;
  end if;
  if v_new then return 'queued'; end if;
  if p_event = 'sync' then return 'duplicate'; end if; -- la synchro ne fait que rattraper les réunions inconnues

  select * into v_job from public.fireflies_import_jobs where meeting_id = p_meeting_id for update;

  if (v_job.seen_events ->> p_event) is not null and v_stamp <= (v_job.seen_events ->> p_event)::bigint then
    -- Doublon ou version plus ancienne : rien à refaire, sauf si le dernier import a échoué.
    if v_job.status <> 'failed' then return 'duplicate'; end if;
  end if;

  update public.fireflies_import_jobs
     set seen_events = seen_events || jsonb_build_object(p_event, greatest(v_stamp, coalesce((seen_events ->> p_event)::bigint, 0))),
         rerun = status = 'running',
         status = case when status = 'running' then status else 'pending' end,
         attempts = case when status = 'running' then attempts else 0 end,
         next_attempt_at = case when status = 'running' then next_attempt_at else now() end,
         finished_at = null,
         updated_at = now()
   where id = v_job.id;
  return case when v_job.status = 'running' then 'rerun' else 'queued' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Prise de tâches. Une tentative est comptée à la prise : une fonction coupée en plein travail
-- consomme donc une tentative, et le nombre total reste borné.
-- ---------------------------------------------------------------------------

create or replace function public.fireflies_claim_jobs(p_server_key text, p_limit integer default 5)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max constant integer := 8;
  v_rows jsonb;
begin
  perform appt_private.assert_server(p_server_key);

  update public.fireflies_import_jobs
     set status = 'failed', lock_token = null, locked_until = null, finished_at = now(), updated_at = now(),
         last_error_code = 'interrupted', last_error = 'Import interrompu à plusieurs reprises.'
   where status = 'running' and locked_until < now() and attempts >= v_max;

  if exists (select 1 from public.fireflies_connection where id and api_paused_until > now()) then
    return '[]'::jsonb;
  end if;

  with due as (
    select id from public.fireflies_import_jobs
     where (status in ('pending', 'waiting_summary') and next_attempt_at <= now())
        or (status = 'running' and locked_until < now())
     order by next_attempt_at
     limit greatest(1, least(p_limit, 20))
     for update skip locked
  ), taken as (
    update public.fireflies_import_jobs j
       set status = 'running', attempts = j.attempts + 1, lock_token = gen_random_uuid(),
           locked_until = now() + interval '5 minutes', rerun = false, updated_at = now()
      from due where j.id = due.id
    returning j.id, j.meeting_id, j.lock_token, j.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'meeting_id', meeting_id, 'lock_token', lock_token, 'attempts', attempts)), '[]'::jsonb)
    into v_rows from taken;
  return v_rows;
end;
$$;

-- ---------------------------------------------------------------------------
-- Enregistrement atomique : appel + transcription complète + fin de la tâche.
-- ---------------------------------------------------------------------------

create or replace function public.fireflies_store_call(
  p_server_key text, p_job_id uuid, p_lock_token uuid, p_account jsonb, p_call jsonb, p_lines jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.fireflies_import_jobs;
  v_call public.fireflies_calls;
  v_count integer;
  v_incoming_summary text := coalesce(p_call ->> 'summary_state', 'pending');
  v_deadline timestamptz;
  v_status text;
begin
  perform appt_private.assert_server(p_server_key);

  select * into v_job from public.fireflies_import_jobs where id = p_job_id for update;
  -- Tâche reprise entre-temps par un autre traitement : cet envoi, plus ancien, ne doit rien écraser.
  if not found or v_job.status <> 'running' or v_job.lock_token is distinct from p_lock_token then
    raise exception 'Fireflies : tâche reprise par un autre traitement' using errcode = '55000';
  end if;
  if p_call ->> 'fireflies_id' is distinct from v_job.meeting_id then
    raise exception 'Fireflies : identifiant différent de la tâche' using errcode = '22023';
  end if;
  if coalesce(p_account ->> 'id', '') = '' then
    raise exception 'Fireflies : compte inconnu' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Fireflies : transcription invalide' using errcode = '22023';
  end if;
  v_count := jsonb_array_length(p_lines);
  if v_count is distinct from (p_call ->> 'line_count')::integer then
    raise exception 'Fireflies : transcription incomplète' using errcode = '22023';
  end if;

  insert into public.fireflies_calls as c (
    account_id, fireflies_id, title, occurred_at, duration_minutes, organizer_email, participants, attendees, speakers,
    transcript_url, meeting_link, calendar_event_id, calendar_type, silent, summary, summary_state, summary_status,
    summary_updated_at, line_count)
  values (
    p_account ->> 'id', v_job.meeting_id, coalesce(p_call ->> 'title', 'Appel sans titre'),
    (p_call ->> 'occurred_at')::timestamptz, (p_call ->> 'duration_minutes')::numeric, p_call ->> 'organizer_email',
    array(select jsonb_array_elements_text(coalesce(p_call -> 'participants', '[]'))),
    coalesce(p_call -> 'attendees', '[]'), coalesce(p_call -> 'speakers', '[]'),
    p_call ->> 'transcript_url', p_call ->> 'meeting_link', p_call ->> 'calendar_event_id', p_call ->> 'calendar_type',
    coalesce((p_call ->> 'silent')::boolean, false), coalesce(p_call -> 'summary', '{}'), v_incoming_summary,
    p_call ->> 'summary_status', case when v_incoming_summary = 'available' then now() end, v_count)
  on conflict (account_id, fireflies_id) do update set
    title = excluded.title,
    occurred_at = coalesce(excluded.occurred_at, c.occurred_at),
    duration_minutes = coalesce(excluded.duration_minutes, c.duration_minutes),
    organizer_email = coalesce(excluded.organizer_email, c.organizer_email),
    participants = case when cardinality(excluded.participants) > 0 then excluded.participants else c.participants end,
    attendees = case when jsonb_array_length(excluded.attendees) > 0 then excluded.attendees else c.attendees end,
    speakers = case when jsonb_array_length(excluded.speakers) > 0 then excluded.speakers else c.speakers end,
    transcript_url = coalesce(excluded.transcript_url, c.transcript_url),
    meeting_link = coalesce(excluded.meeting_link, c.meeting_link),
    calendar_event_id = coalesce(excluded.calendar_event_id, c.calendar_event_id),
    calendar_type = coalesce(excluded.calendar_type, c.calendar_type),
    silent = excluded.silent,
    -- Un résumé reçu n'est jamais effacé par une réponse qui n'en contient plus.
    summary = case when excluded.summary_state = 'available' then excluded.summary else c.summary end,
    summary_state = case when excluded.summary_state = 'available' or c.summary_state <> 'available' then excluded.summary_state else c.summary_state end,
    summary_status = excluded.summary_status,
    summary_updated_at = case when excluded.summary_state = 'available' and excluded.summary is distinct from c.summary then now() else c.summary_updated_at end,
    -- Une réponse sans aucune ligne n'efface jamais une transcription déjà enregistrée.
    line_count = case when excluded.line_count > 0 then excluded.line_count else c.line_count end,
    last_imported_at = now()
  returning * into v_call;

  if v_count > 0 or not exists (select 1 from public.fireflies_call_transcripts where call_id = v_call.id) then
    insert into public.fireflies_call_transcripts (call_id, lines) values (v_call.id, p_lines)
    on conflict (call_id) do update set lines = excluded.lines, updated_at = now();
  end if;

  -- Résumé encore absent : on repasse le voir, jusqu'à 7 jours après le premier import.
  v_deadline := coalesce(v_job.summary_deadline, now() + interval '7 days');
  if v_call.summary_state = 'pending' and now() >= v_deadline then
    update public.fireflies_calls set summary_state = 'unavailable' where id = v_call.id returning * into v_call;
  end if;

  v_status := case
    when v_job.rerun then 'pending'
    when v_call.summary_state = 'pending' then 'waiting_summary'
    else 'done' end;

  update public.fireflies_import_jobs
     set status = v_status, attempts = 0, call_id = v_call.id, lock_token = null, locked_until = null, rerun = false,
         summary_deadline = v_deadline, last_error_code = null, last_error = null,
         next_attempt_at = case when v_status = 'waiting_summary' then now() + interval '1 hour' else now() end,
         finished_at = case when v_status = 'done' then now() end,
         updated_at = now()
   where id = v_job.id;

  update public.fireflies_connection
     set account_id = p_account ->> 'id', account_email = coalesce(p_account ->> 'email', account_email),
         last_success_at = now(), last_error_code = null, last_error_at = null, updated_at = now()
   where id;

  -- Ni résumé ni texte en retour : uniquement de quoi vérifier l'import.
  return jsonb_build_object('call_id', v_call.id, 'status', v_status, 'summary_state', v_call.summary_state, 'line_count', v_call.line_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Échec d'une tentative. p_kind : temporary, rate_limited, permanent.
-- ---------------------------------------------------------------------------

create or replace function public.fireflies_job_failed(
  p_server_key text, p_job_id uuid, p_lock_token uuid, p_kind text, p_code text, p_message text, p_retry_after integer default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max constant integer := 8;
  v_job public.fireflies_import_jobs;
  v_status text;
  v_delay interval;
begin
  perform appt_private.assert_server(p_server_key);
  if p_kind not in ('temporary', 'rate_limited', 'permanent') then
    raise exception 'Fireflies : type d''échec inconnu' using errcode = '22023';
  end if;
  select * into v_job from public.fireflies_import_jobs where id = p_job_id for update;
  if not found or v_job.status <> 'running' or v_job.lock_token is distinct from p_lock_token then
    return 'stale';
  end if;

  if p_kind = 'rate_limited' then
    v_delay := make_interval(secs => greatest(coalesce(p_retry_after, 60), 1));
    update public.fireflies_connection set api_paused_until = now() + v_delay, updated_at = now() where id;
  else
    v_delay := (array[interval '1 minute', interval '5 minutes', interval '30 minutes', interval '2 hours',
                      interval '6 hours', interval '12 hours', interval '24 hours'])[least(greatest(v_job.attempts, 1), 7)];
  end if;

  v_status := case
    when v_job.rerun then 'pending' -- un nouvel événement est arrivé : il mérite sa propre tentative
    when p_kind = 'permanent' then 'failed'
    when v_job.attempts >= v_max then 'failed'
    else 'pending' end;

  update public.fireflies_import_jobs
     set status = v_status, lock_token = null, locked_until = null, rerun = false,
         attempts = case when v_job.rerun then 0 else attempts end,
         next_attempt_at = now() + v_delay,
         last_error_code = left(p_code, 80), last_error = left(p_message, 300),
         finished_at = case when v_status = 'failed' then now() end,
         updated_at = now()
   where id = v_job.id;

  update public.fireflies_connection set last_error_code = left(p_code, 80), last_error_at = now(), updated_at = now() where id;
  return v_status;
end;
$$;

-- Bilan de la synchronisation périodique (sans rendre de contenu)
create or replace function public.fireflies_sync_done(p_server_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.fireflies_connection set last_sync_at = now(), updated_at = now() where id;
end;
$$;

-- Relance manuelle d'un import en échec (propriétaire dans l'application)
create or replace function public.fireflies_retry_job(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.fireflies_import_jobs
     set status = 'pending', attempts = 0, next_attempt_at = now(), finished_at = null, updated_at = now()
   where id = p_job_id and status = 'failed';
  if not found then
    raise exception 'Cet import n''est pas en échec.' using errcode = 'P0001';
  end if;
end;
$$;

-- Uniquement les fonctions de ce fichier : la réservation publique garde ses droits.
do $$
declare f text;
begin
  foreach f in array array[
    'fireflies_enqueue(text, text, text, bigint)',
    'fireflies_claim_jobs(text, integer)',
    'fireflies_store_call(text, uuid, uuid, jsonb, jsonb, jsonb)',
    'fireflies_job_failed(text, uuid, uuid, text, text, text, integer)',
    'fireflies_sync_done(text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  execute 'revoke all on function public.fireflies_retry_job(uuid) from public, anon';
  execute 'grant execute on function public.fireflies_retry_job(uuid) to authenticated';
end $$;
