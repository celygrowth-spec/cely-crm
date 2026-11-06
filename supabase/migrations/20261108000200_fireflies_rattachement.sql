-- Fireflies, phase 2 : rattachement des appels aux fiches (voir docs/integrations/fireflies.md).
--
-- Ordre : (1) rendez-vous CRM reconnu et déjà rattaché à une fiche ; (2) email exact d'un participant externe,
-- si les contacts désignent une seule entreprise ; (3) sinon « Appels à rattacher », avec des fiches candidates.
-- Un appel ne crée jamais d'entreprise, de contact ni d'opportunité.
-- Un choix manuel (rattacher, déplacer, ignorer) n'est plus jamais recalculé : seul « Annuler mon choix » le lève.

create schema if not exists fireflies_private;
revoke all on schema fireflies_private from public, anon, authenticated;

alter table public.fireflies_connection
  add column own_emails text[] not null default '{}',
  add column own_domains text[] not null default '{}';

alter table public.fireflies_calls
  add column link_state text not null default 'to_link' check (link_state in ('to_link', 'linked', 'ignored')),
  add column link_source text check (link_source in ('appointment', 'email', 'manual')),
  add column link_reason text check (link_reason is null or char_length(link_reason) <= 500),
  add column link_candidates jsonb not null default '[]' check (jsonb_typeof(link_candidates) = 'array'),
  add column company_id uuid references public.companies (id) on delete set null,
  add column person_id uuid references public.people (id) on delete set null,
  add column booking_id uuid references public.appt_bookings (id) on delete set null,
  add column interaction_id uuid references public.interactions (id) on delete set null,
  add column linked_at timestamptz,
  add constraint fireflies_calls_link_coherent check (
    (link_state = 'linked' and company_id is not null) or (link_state <> 'linked' and company_id is null));

create index fireflies_calls_company on public.fireflies_calls (company_id, occurred_at desc nulls last) where company_id is not null;
create index fireflies_calls_booking on public.fireflies_calls (booking_id) where booking_id is not null;
create index fireflies_calls_to_link on public.fireflies_calls (occurred_at desc nulls last) where link_state = 'to_link';

-- Colonnes ajoutées en fin de vue : les précédentes ne bougent pas.
create or replace view public.fireflies_import_overview with (security_invoker = true) as
select j.id as job_id, j.meeting_id, j.source, j.status as job_status, j.attempts, j.next_attempt_at,
       j.last_error_code, j.last_error, j.received_at, j.finished_at, j.updated_at,
       c.id as call_id, c.title, c.occurred_at, c.line_count, c.summary_state,
       case
         when j.status = 'failed' then 'failed'
         when c.id is null then 'importing'
         when c.summary_state = 'pending' then 'summary_pending'
         else 'imported'
       end as display_state,
       c.link_state, c.company_id
  from public.fireflies_import_jobs j
  left join public.fireflies_calls c on c.id = j.call_id;

-- ---------------------------------------------------------------------------
-- Adresses à ignorer
-- ---------------------------------------------------------------------------

-- Comptes de service : enregistreurs de réunion, salles et agendas, adresses sans personne derrière.
create or replace function fireflies_private.is_technical_email(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select public.email_domain(p) = any (array[
           'fireflies.ai', 'fireflies.com', 'otter.ai', 'fathom.video', 'read.ai', 'tldv.io', 'meetgeek.ai',
           'notetaker.ai', 'krisp.ai', 'avoma.com', 'gong.io', 'chorus.ai', 'calendar.google.com'])
      or coalesce(public.email_domain(p), '') ~ '\.calendar\.google\.com$'
      or split_part(public.norm_email(p), '@', 1) ~ '^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|calendar-notification)(\+.*)?$';
$$;

-- Vos adresses : compte propriétaire, boîtes Mail, agenda Google, compte Fireflies et celles ajoutées à la main.
-- Le domaine d'une adresse professionnelle est aussi interne : un collègue n'est pas un client.
create or replace function fireflies_private.own_addresses(out emails text[], out domains text[])
language plpgsql
stable
set search_path = ''
as $$
begin
  select array_agg(distinct e) into emails from (
    select public.norm_email(u.email) as e from auth.users u join public.app_owner o on o.user_id = u.id
    union all select public.norm_email(email) from public.mail_accounts
    union all select public.norm_email(google_email) from public.appt_google_connection
    union all select public.norm_email(account_email) from public.fireflies_connection
    union all select public.norm_email(x) from public.fireflies_connection, unnest(own_emails) x
  ) s where e is not null;
  select array_agg(distinct d) into domains from (
    select public.email_domain(x) as d from unnest(coalesce(emails, '{}')) x
    union all select public.norm_domain(x) from public.fireflies_connection, unnest(own_domains) x
  ) s where d is not null and not public.is_free_email_domain(d);
  emails := coalesce(emails, '{}');
  domains := coalesce(domains, '{}');
end;
$$;

-- Une fiche fusionnée renvoie vers la fiche conservée.
create or replace function fireflies_private.live_company(p uuid)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare v uuid := p; n uuid; i int := 0;
begin
  while v is not null and i < 20 loop
    select merged_into_id into n from public.companies where id = v;
    if not found then return null; end if;
    if n is null then return v; end if;
    v := n; i := i + 1;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recherche du rendez-vous
-- ---------------------------------------------------------------------------

-- Fiable : l'identifiant d'événement Google (stable, même après un report). À défaut, l'horaire ET un participant
-- externe : un lien Meet réutilisé ne suffit jamais à lui seul, il ne sert qu'à départager.
create or replace function fireflies_private.find_booking(p public.fireflies_calls, p_external text[])
returns public.appt_bookings
language plpgsql
stable
set search_path = ''
as $$
declare
  b public.appt_bookings;
  v_ids uuid[];
begin
  if p.calendar_event_id is not null and coalesce(p.calendar_type, 'google') = 'google' then
    select * into b from public.appt_bookings
     where google_event_id = p.calendar_event_id and status = 'confirmed' limit 1;
    if found then return b; end if;
  end if;
  if p.occurred_at is null or cardinality(p_external) = 0 then return null; end if;

  select array_agg(id) into v_ids from public.appt_bookings
   where status = 'confirmed' and email_norm = any (p_external)
     and p.occurred_at between starts_at - interval '30 minutes' and ends_at + interval '30 minutes';
  if cardinality(v_ids) > 1 and p.meeting_link is not null then
    select array_agg(id) into v_ids from public.appt_bookings where id = any (v_ids) and meeting_url = p.meeting_link;
  end if;
  if cardinality(v_ids) = 1 then
    select * into b from public.appt_bookings where id = v_ids[1];
    return b;
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Décision, sans rien écrire.
-- ---------------------------------------------------------------------------

create or replace function fireflies_private.resolve(p public.fireflies_calls)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_own record;
  v_external text[];
  v_domains text[];
  b public.appt_bookings;
  v_company uuid;
  v_person uuid;
  v_companies uuid[];
  v_title text := public.norm_company_name(p.title);
  v_names text[];
  v_candidates jsonb;
begin
  select * into v_own from fireflies_private.own_addresses();

  select coalesce(array_agg(distinct e), '{}') into v_external from (
    select public.norm_email(x) as e from unnest(p.participants || p.organizer_email) x
  ) s
   where e is not null and not (e = any (v_own.emails))
     and not (coalesce(public.email_domain(e), '') = any (v_own.domains))
     and not fireflies_private.is_technical_email(e);

  -- (1) Rendez-vous
  b := fireflies_private.find_booking(p, v_external);
  if b.id is not null then
    v_company := fireflies_private.live_company(b.company_id);
    if v_company is not null then
      return jsonb_build_object('company_id', v_company, 'source', 'appointment', 'booking_id', b.id,
        'person_id', (select id from public.people where id = b.person_id and company_id = v_company),
        'reason', 'Rendez-vous du CRM');
    end if;
  end if;

  -- (2) Email exact d'un contact
  select coalesce(array_agg(distinct pe.company_id), '{}') into v_companies
    from public.people pe join public.companies c on c.id = pe.company_id
   where pe.email_norm = any (v_external) and c.merged_into_id is null;
  if cardinality(v_companies) = 1 then
    select pe.id into v_person from public.people pe
     where pe.company_id = v_companies[1] and pe.email_norm = any (v_external)
     order by pe.is_primary desc, pe.created_at limit 1;
    return jsonb_build_object('company_id', v_companies[1], 'source', 'email', 'person_id', v_person, 'booking_id', b.id,
      'reason', 'Email d''un contact : ' || (select email_norm from public.people where id = v_person));
  end if;

  -- (3) À rattacher : fiches candidates. Les indices aident à trouver, ils ne décident jamais.
  v_domains := coalesce(array(
    select distinct public.email_domain(e) from unnest(v_external) e
     where public.email_domain(e) is not null and not public.is_free_email_domain(public.email_domain(e))), '{}');
  v_names := coalesce(array(
    select distinct public.norm_person_name(n, null)
      from (select a ->> 'name' as n from jsonb_array_elements(p.attendees) a
            union all select s ->> 'name' from jsonb_array_elements(p.speakers) s) x
     where position(' ' in coalesce(public.norm_person_name(n, null), '')) > 0), '{}');

  with hits as (
    select pe.company_id as id, 4 as w, 'Contact : ' || pe.email_norm as r
      from public.people pe where pe.email_norm = any (v_external)
    union all
    select (x ->> 'company_id')::uuid, 3, 'Candidate du rendez-vous'
      from jsonb_array_elements(coalesce(b.crm_candidates, '[]')) x where x ->> 'company_id' is not null
    union all
    select c.id, 2, 'Domaine du site : ' || c.domain_norm
      from public.companies c where c.domain_norm = any (v_domains)
    union all
    select pe.company_id, 2, 'Domaine d''un contact : ' || public.email_domain(pe.email_norm)
      from public.people pe where public.email_domain(pe.email_norm) = any (v_domains)
    union all
    select pe.company_id, 1, 'Personne au même nom : ' || pe.full_name_norm
      from public.people pe where pe.full_name_norm = any (v_names)
    union all
    select c.id, 1, 'Nom dans le titre de l''appel'
      from public.companies c
     where v_title is not null and char_length(c.name_norm) >= 3
       and position(' ' || c.name_norm || ' ' in ' ' || v_title || ' ') > 0
  ), ranked as (
    select c.id, c.name, c.website, c.archived_at is not null as archived, max(h.w) as w, array_agg(distinct h.r) as reasons
      from hits h join public.companies c on c.id = h.id
     where c.merged_into_id is null
     group by c.id, c.name, c.website, c.archived_at
     order by max(h.w) desc, c.name
     limit 10
  )
  select coalesce(jsonb_agg(jsonb_build_object('company_id', id, 'name', name, 'website', website, 'archived', archived, 'reasons', to_jsonb(reasons))
                            order by w desc, name), '[]')
    into v_candidates from ranked;

  return jsonb_build_object('company_id', null, 'booking_id', b.id, 'candidates', v_candidates,
    'reason', case
      when cardinality(v_companies) > 1 then 'Plusieurs entreprises parmi les participants'
      when cardinality(v_external) = 0 then 'Aucun participant externe'
      else 'Aucun contact reconnu' end);
end;
$$;

-- ---------------------------------------------------------------------------
-- Une seule activité par appel sur la fiche. Le compte rendu du rendez-vous réutilise l'activité « Rendez-vous
-- réalisé » ; et si l'appel arrive d'abord, appt_set_outcome voit la nôtre et n'en ajoute pas une seconde.
-- Le texte ne reprend rien de Fireflies : ni titre, ni résumé, ni lien.
-- ---------------------------------------------------------------------------

create or replace function fireflies_private.sync_activity(p_call uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  c public.fireflies_calls;
  i public.interactions;
  v_owned boolean;
  v_booking uuid;
  v_kind text;
  v_meta jsonb;
  v_id uuid;
begin
  select * into c from public.fireflies_calls where id = p_call;
  if c.interaction_id is not null then
    select * into i from public.interactions where id = c.interaction_id;
  end if;
  v_owned := coalesce((i.meta ->> 'fireflies_created')::boolean, false);

  if i.id is not null and (c.company_id is null or i.company_id <> c.company_id) then
    if v_owned and c.company_id is not null then
      update public.interactions set company_id = c.company_id where id = i.id returning * into i;
    elsif v_owned then
      delete from public.interactions where id = i.id;
      i := null;
    else
      -- activité « Rendez-vous réalisé » : elle appartient au rendez-vous, on la laisse sur sa fiche
      update public.interactions set meta = meta - 'fireflies_call_id' where id = i.id;
      i := null;
    end if;
    update public.fireflies_calls set interaction_id = i.id where id = c.id;
  end if;
  if c.company_id is null then return; end if;

  v_booking := c.booking_id;
  if i.id is null and v_booking is not null then
    select * into i from public.interactions x
     where x.company_id = c.company_id and x.kind = 'meeting' and x.meta ->> 'appointment_id' = v_booking::text
     limit 1;
    if i.id is not null then
      if i.meta ->> 'fireflies_call_id' is null then
        update public.interactions set meta = meta || jsonb_build_object('fireflies_call_id', c.id) where id = i.id;
        update public.fireflies_calls set interaction_id = i.id where id = c.id;
        return;
      end if;
      -- Déjà liée à un autre enregistrement du même rendez-vous : celui-ci reste un simple appel.
      i := null;
      v_booking := null;
    end if;
  end if;

  v_kind := case when v_booking is not null then 'meeting' else 'call' end;
  v_meta := jsonb_build_object('fireflies_call_id', c.id, 'fireflies_created', true)
            || case when v_booking is not null then jsonb_build_object('appointment_id', v_booking) else '{}'::jsonb end;

  if i.id is null then
    insert into public.interactions (company_id, person_id, kind, occurred_at, content, content_origin, source, meta)
    values (c.company_id, c.person_id, v_kind, coalesce(c.occurred_at, now()), 'Appel enregistré par Fireflies', 'system', 'system', v_meta)
    returning id into v_id;
    update public.fireflies_calls set interaction_id = v_id where id = c.id;
  elsif coalesce((i.meta ->> 'fireflies_created')::boolean, false) then
    update public.interactions
       set person_id = c.person_id, kind = v_kind, occurred_at = coalesce(c.occurred_at, occurred_at), meta = v_meta
     where id = i.id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Application de la décision. Un choix manuel n'est jamais remplacé.
-- ---------------------------------------------------------------------------

create or replace function fireflies_private.apply_link(p_call uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  c public.fireflies_calls;
  r jsonb;
  v_company uuid;
begin
  select * into c from public.fireflies_calls where id = p_call for update;
  if not found or c.link_state = 'ignored' then return; end if;
  r := fireflies_private.resolve(c);

  if c.link_source = 'manual' then
    -- La fiche ne change pas. Seul un rendez-vous de cette même fiche peut encore y être associé.
    if c.booking_id is null and r ->> 'booking_id' is not null
       and fireflies_private.live_company((select company_id from public.appt_bookings where id = (r ->> 'booking_id')::uuid)) = c.company_id then
      update public.fireflies_calls set booking_id = (r ->> 'booking_id')::uuid where id = c.id;
    end if;
  else
    v_company := (r ->> 'company_id')::uuid;
    update public.fireflies_calls
       set link_state = case when v_company is null then 'to_link' else 'linked' end,
           link_source = r ->> 'source',
           link_reason = r ->> 'reason',
           link_candidates = coalesce(r -> 'candidates', '[]'),
           company_id = v_company,
           person_id = (r ->> 'person_id')::uuid,
           booking_id = (r ->> 'booking_id')::uuid,
           linked_at = case when v_company is null then null when v_company is distinct from c.company_id then now() else c.linked_at end
     where id = c.id;
  end if;
  perform fireflies_private.sync_activity(c.id);
end;
$$;

-- À chaque import, dans la même transaction que l'appel (fireflies_store_call écrit toujours last_imported_at).
-- Un rattachement en erreur n'empêche jamais d'enregistrer l'appel : il reste à rattacher, le passage quotidien le reprend.
create or replace function fireflies_private.tg_call_imported()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform fireflies_private.apply_link(new.id);
  exception when others then
    raise warning 'Fireflies : rattachement reporté (%)', sqlstate;
  end;
  return null;
end;
$$;
create trigger fireflies_calls_imported after insert or update of last_imported_at on public.fireflies_calls
  for each row execute function fireflies_private.tg_call_imported();

-- Fiche supprimée : l'appel revient dans la file au lieu de disparaître.
create or replace function fireflies_private.tg_call_company_gone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.company_id is null and old.company_id is not null and new.link_state = 'linked' then
    new.link_state := 'to_link';
    new.link_source := null;
    new.link_reason := 'La fiche rattachée a été supprimée';
    new.person_id := null;
    new.linked_at := null;
  end if;
  return new;
end;
$$;
create trigger fireflies_calls_company_gone before update of company_id on public.fireflies_calls
  for each row execute function fireflies_private.tg_call_company_gone();

-- Une fusion de fiches conserve les appels, et les choix manuels suivent la fiche conservée.
create or replace function fireflies_private.tg_companies_merge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r record;
begin
  if new.merged_into_id is not null and old.merged_into_id is null then
    update public.fireflies_calls set company_id = new.merged_into_id where company_id = new.id;
    for r in
      select id from public.fireflies_calls
       where link_state = 'to_link' and link_candidates @> jsonb_build_array(jsonb_build_object('company_id', new.id))
    loop
      perform fireflies_private.apply_link(r.id);
    end loop;
  end if;
  return null;
end;
$$;
create trigger companies_merge_fireflies after update of merged_into_id on public.companies
  for each row execute function fireflies_private.tg_companies_merge();

-- ---------------------------------------------------------------------------
-- Choix du propriétaire
-- ---------------------------------------------------------------------------

create or replace function public.fireflies_link_call(p_call uuid, p_company uuid, p_person uuid default null, p_booking uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.fireflies_calls;
  v_booking uuid;
  v_booking_company uuid;
begin
  perform appt_private.assert_owner_user();
  select * into c from public.fireflies_calls where id = p_call for update;
  if not found then raise exception 'Appel introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;

  v_booking := coalesce(p_booking, c.booking_id);
  if v_booking is not null then
    select company_id into v_booking_company from public.appt_bookings where id = v_booking;
    if not found then raise exception 'Rendez-vous introuvable' using errcode = 'P0002'; end if;
    if v_booking_company is not null and fireflies_private.live_company(v_booking_company) is distinct from p_company then
      if p_booking is not null then
        raise exception 'Ce rendez-vous est rattaché à une autre fiche' using errcode = '22023';
      end if;
      v_booking := null; -- l'appel change de fiche : l'ancien rendez-vous ne le suit pas
    end if;
  end if;

  update public.fireflies_calls
     set link_state = 'linked', link_source = 'manual', link_reason = 'Choix manuel', link_candidates = '[]',
         company_id = p_company, person_id = p_person, booking_id = v_booking, linked_at = now()
   where id = c.id;
  perform fireflies_private.sync_activity(c.id);
end;
$$;

create or replace function public.fireflies_ignore_call(p_call uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.fireflies_calls
     set link_state = 'ignored', link_source = 'manual', link_reason = 'Ignoré manuellement', link_candidates = '[]',
         company_id = null, person_id = null, booking_id = null, linked_at = null
   where id = p_call;
  if not found then raise exception 'Appel introuvable' using errcode = 'P0002'; end if;
  perform fireflies_private.sync_activity(p_call);
end;
$$;

-- « Annuler mon choix » : l'appel repasse par les règles automatiques.
create or replace function public.fireflies_reset_call_link(p_call uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.fireflies_calls
     set link_state = 'to_link', link_source = null, link_reason = null, company_id = null, person_id = null, booking_id = null, linked_at = null
   where id = p_call;
  if not found then raise exception 'Appel introuvable' using errcode = 'P0002'; end if;
  perform fireflies_private.apply_link(p_call);
end;
$$;

create or replace function public.fireflies_set_own_addresses(p_emails text[], p_domains text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_owner_user();
  update public.fireflies_connection
     set own_emails = coalesce(array(select distinct public.norm_email(e) from unnest(p_emails) e where public.norm_email(e) is not null), '{}'),
         own_domains = coalesce(array(select distinct public.norm_domain(d) from unnest(p_domains) d where public.norm_domain(d) is not null), '{}'),
         updated_at = now()
   where id;
end;
$$;

-- Reprend les appels encore à rattacher : un contact ajouté ou un rendez-vous rattaché depuis peut désormais les désigner.
create or replace function public.fireflies_rematch(p_server_key text default null, p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n integer := 0;
begin
  if p_server_key is null then perform appt_private.assert_owner_user(); else perform appt_private.assert_server(p_server_key); end if;
  for r in
    select id from public.fireflies_calls
     where link_state = 'to_link' and link_source is null
     order by occurred_at desc nulls last
     limit greatest(1, least(p_limit, 500))
  loop
    perform fireflies_private.apply_link(r.id);
    if (select link_state from public.fireflies_calls where id = r.id) = 'linked' then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

-- Uniquement les fonctions de ce fichier.
revoke all on all functions in schema fireflies_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'fireflies_link_call(uuid, uuid, uuid, uuid)', 'fireflies_ignore_call(uuid)', 'fireflies_reset_call_link(uuid)',
    'fireflies_set_own_addresses(text[], text[])']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke all on function public.fireflies_rematch(text, integer) from public';
  execute 'grant execute on function public.fireflies_rematch(text, integer) to anon, authenticated';
end $$;
