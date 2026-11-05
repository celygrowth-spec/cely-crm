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
