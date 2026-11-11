-- Audit, lot 5 — Rendez-vous et emails fiables (C07, C09, Q02, Q03 ; C08 est côté serveur applicatif).
-- Migration additive : deux tables de suivi (passages planifiés, limites de réservation), une table d'état de la
-- synchronisation Gmail, des colonnes sur mail_messages pour les emails REÇUS, des fonctions à clé serveur.

-- ===========================================================================
-- C07 — passages planifiés : dernière réussite et dernière erreur visibles (Connecteurs)
-- ===========================================================================
create table if not exists public.scheduled_jobs (
  job text primary key check (job in ('agenda', 'rappels', 'gmail', 'fireflies')),
  last_started_at timestamptz,
  last_success_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 2000),
  last_error_at timestamptz,
  last_result jsonb,
  updated_at timestamptz not null default now()
);
alter table public.scheduled_jobs enable row level security;
drop policy if exists scheduled_jobs_owner_read on public.scheduled_jobs;
create policy scheduled_jobs_owner_read on public.scheduled_jobs for select to authenticated using (public.is_app_owner());

create or replace function public.job_report(p_server_key text, p_job text, p_ok boolean, p_error text default null, p_result jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  insert into public.scheduled_jobs (job, last_started_at, last_success_at, last_error, last_error_at, last_result, updated_at)
  values (p_job, now(), case when p_ok then now() end, case when not p_ok then left(p_error, 2000) end,
          case when not p_ok then now() end, p_result, now())
  on conflict (job) do update set
    last_started_at = now(),
    last_success_at = case when p_ok then now() else scheduled_jobs.last_success_at end,
    last_error = case when p_ok then null else left(p_error, 2000) end,
    last_error_at = case when p_ok then scheduled_jobs.last_error_at else now() end,
    last_result = coalesce(p_result, scheduled_jobs.last_result),
    updated_at = now();
end;
$$;

-- ===========================================================================
-- C09 — réservation publique : limites par email et par adresse IP (empreinte, jamais l'adresse en clair)
-- ===========================================================================
create table if not exists public.appt_rate_hits (
  bucket text not null check (char_length(bucket) between 3 and 200),
  at timestamptz not null default now()
);
create index if not exists appt_rate_hits_bucket on public.appt_rate_hits (bucket, at desc);
alter table public.appt_rate_hits enable row level security; -- aucune politique : accès par fonction uniquement

-- null = autorisé ; sinon le message à afficher. Compte la tentative.
create or replace function public.appt_rate_check(p_server_key text, p_email text, p_ip_hash text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_email text := lower(btrim(coalesce(p_email, ''))); v_ip int; v_mail int;
begin
  perform appt_private.assert_server(p_server_key);
  delete from public.appt_rate_hits where at < now() - interval '2 days';
  if p_ip_hash is not null then
    select count(*) into v_ip from public.appt_rate_hits where bucket = 'ip:' || p_ip_hash and at > now() - interval '1 hour';
    insert into public.appt_rate_hits (bucket) values ('ip:' || left(p_ip_hash, 120));
    if v_ip >= 10 then return 'Trop de tentatives depuis cette connexion. Réessayez dans une heure.'; end if;
  end if;
  select count(*) into v_mail from public.appt_bookings
   where email_norm = v_email and created_at > now() - interval '1 day' and status in ('pending', 'confirmed');
  if v_mail >= 3 then return 'Plusieurs rendez-vous sont déjà réservés avec cette adresse aujourd''hui. Utilisez le lien reçu pour les gérer.'; end if;
  return null;
end;
$$;

-- Les informations saisies par un visiteur n'écrasent jamais une fiche : elles ne servent qu'à rattacher ou créer.
-- La trace sur la fiche le dit explicitement (identité déclarée, non vérifiée).
create or replace function appt_private.crm_note(p_booking uuid, p_company uuid, p_person uuid, p_text text)
returns void
language sql
set search_path = ''
as $$
  insert into public.interactions (company_id, person_id, kind, content, content_origin, source, meta)
  values (p_company, p_person, 'system',
          p_text || ' — réservation en ligne : nom, email et entreprise déclarés par le visiteur, à confirmer',
          'system', 'system', jsonb_build_object('appointment_id', p_booking, 'declared_by_visitor', true));
$$;

-- ===========================================================================
-- Q02 — rappels envoyés par Gmail depuis le serveur (passage planifié) : compte, jeton, trace dans l'historique.
-- Les échéances, versions, révisions, suspension globale et validité existent déjà (appt_mail_*).
-- ===========================================================================
create or replace function public.mail_server_account(p_server_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  return (select jsonb_build_object('id', a.id, 'email', a.email, 'display_name', a.display_name, 'scopes', a.scopes, 'signature', a.signature,
                                    'refresh_token_enc', s.refresh_token_enc, 'access_token_enc', s.access_token_enc,
                                    'access_token_expires_at', s.access_token_expires_at)
            from public.mail_accounts a join public.mail_account_secrets s on s.account_id = a.id
           where a.status = 'connected' order by a.is_default desc, a.connected_at desc limit 1);
end;
$$;

create or replace function public.mail_server_store_access(p_server_key text, p_id uuid, p_access_enc text, p_expires timestamptz, p_refresh_enc text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.mail_account_secrets
     set access_token_enc = p_access_enc, access_token_expires_at = p_expires, refresh_token_enc = coalesce(p_refresh_enc, refresh_token_enc)
   where account_id = p_id;
end;
$$;

create or replace function public.mail_server_mark_reconnect(p_server_key text, p_id uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.mail_accounts set status = 'needs_reconnect', last_error = left(p_error, 1000) where id = p_id;
end;
$$;

-- Trace d'un email envoyé par le serveur (rappel) : une ligne dans l'historique des emails, avec la personne (K14).
-- p : {account_id, status (accepted|failed|uncertain), company_id, person_id, to, subject, body, dedupe_key,
--      business_type, business_id, provider_message_id, provider_thread_id, rfc_message_id, error}
create or replace function public.mail_server_record(p_server_key text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid; v_inter uuid; v_status text := p ->> 'status'; v_company uuid := nullif(p ->> 'company_id', '')::uuid;
begin
  perform appt_private.assert_server(p_server_key);
  if v_status not in ('accepted', 'failed', 'uncertain') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  select id into v_id from public.mail_messages where dedupe_key = p ->> 'dedupe_key';
  if v_id is not null then return jsonb_build_object('id', v_id, 'duplicate', true); end if;
  if v_company is not null and not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then v_company := null; end if;
  if v_status = 'accepted' and v_company is not null then
    insert into public.interactions (company_id, person_id, kind, channel, content, content_origin, source, meta)
    values (v_company, nullif(p ->> 'person_id', '')::uuid, 'message_out', 'email',
            'Email automatique : ' || coalesce(p ->> 'subject', ''), 'system', 'system',
            jsonb_build_object('business_type', p ->> 'business_type', 'business_id', p ->> 'business_id'))
    returning id into v_inter;
  end if;
  -- même cycle de vie qu'un envoi depuis le CRM : en attente, en cours, puis issue réelle
  insert into public.mail_messages (account_id, status, origin, company_id, person_id, to_addrs, subject, body_text, dedupe_key,
                                    business_type, business_id, rfc_message_id, attempts, interaction_id)
  values (nullif(p ->> 'account_id', '')::uuid, 'pending', 'appointment', v_company, nullif(p ->> 'person_id', '')::uuid,
          array(select jsonb_array_elements_text(coalesce(p -> 'to', '[]'))), left(coalesce(p ->> 'subject', ''), 500),
          left(coalesce(p ->> 'body', ''), 200000), p ->> 'dedupe_key', p ->> 'business_type', p ->> 'business_id',
          p ->> 'rfc_message_id', 1, v_inter)
  returning id into v_id;
  if v_status = 'failed' then
    update public.mail_messages set status = 'failed', error_code = 'failed', last_error = p ->> 'error' where id = v_id;
  else
    update public.mail_messages set status = 'sending', claimed_at = now() where id = v_id;
    update public.mail_messages set status = v_status, provider_message_id = p ->> 'provider_message_id', provider_thread_id = p ->> 'provider_thread_id',
           sent_at = case when v_status = 'accepted' then now() end,
           error_code = case when v_status = 'uncertain' then 'uncertain' end, last_error = p ->> 'error'
     where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'duplicate', false);
end;
$$;

-- ===========================================================================
-- Q03 — réception Gmail : emails reçus rattachés par contact, conversation conservée, campagnes en pause
-- ===========================================================================
alter table public.mail_messages
  add column if not exists direction text not null default 'out' check (direction in ('out', 'in')),
  add column if not exists from_addr text check (from_addr is null or char_length(from_addr) <= 320),
  add column if not exists received_at timestamptz,
  -- linked : rattaché ; to_link : plusieurs fiches possibles, à résoudre ; ignored : automatique ou hors contacts
  add column if not exists link_state text check (link_state is null or link_state in ('linked', 'to_link', 'ignored')),
  add column if not exists link_candidates jsonb,
  add column if not exists attachments_meta jsonb,
  add column if not exists linked_manually boolean not null default false;
alter table public.mail_messages drop constraint if exists mail_messages_status_check;
alter table public.mail_messages add constraint mail_messages_status_check
  check (status in ('draft', 'pending', 'sending', 'accepted', 'failed', 'uncertain', 'cancelled', 'received'));
-- Un email reçu entre directement à l'état « received » (jamais envoyé, jamais modifiable comme un brouillon).
create or replace function public.tg_mail_messages_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.direction = 'in' then
      if new.status <> 'received' then raise exception 'Un email reçu est à l''état « reçu ».' using errcode = 'P0001'; end if;
      return new;
    end if;
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
create index if not exists mail_messages_to_link on public.mail_messages (received_at desc) where link_state = 'to_link';
create index if not exists mail_messages_rfc on public.mail_messages (rfc_message_id) where rfc_message_id is not null;

create table if not exists public.mail_sync_state (
  account_id uuid primary key references public.mail_accounts (id) on delete cascade,
  history_id text,
  initial_done_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  imported int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.mail_sync_state enable row level security;
drop policy if exists mail_sync_state_owner_read on public.mail_sync_state;
create policy mail_sync_state_owner_read on public.mail_sync_state for select to authenticated using (public.is_app_owner());

create or replace function public.mail_sync_cursor(p_server_key text, p_account uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  return (select jsonb_build_object('history_id', history_id, 'initial_done_at', initial_done_at) from public.mail_sync_state where account_id = p_account);
end;
$$;

-- Un message reçu entre (format préparé par le serveur, voir src/lib/mail/inbound.ts) :
-- {provider_message_id, provider_thread_id, rfc_message_id, in_reply_to, references, from, to[], subject, text,
--  received_at, automatic (bool), attachments: [{name, mime_type, size}]}
-- Règles : déjà vu (même identifiant Gmail ou même Message-ID qu'un email envoyé par le CRM) : ignoré ;
-- automatique (réponse automatique, liste, noreply) : conservé « ignoré », sans effet ; expéditeur inconnu : rien
-- n'est conservé ; une seule fiche : rattaché, historique, relances en pause et « Réponses à traiter » ;
-- plusieurs fiches : « à rattacher » (résolution manuelle). Un rattachement manuel n'est jamais modifié.
create or replace function public.mail_inbound_ingest(p_server_key text, p_account uuid, p_messages jsonb, p_history_id text default null, p_initial boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  m jsonb; v_from text; v_people int; v_person uuid; v_company uuid; v_id uuid; v_inter uuid; v_cands jsonb;
  v_linked int := 0; v_to_link int := 0; v_ignored int := 0; v_skipped int := 0; v_paused int; v_account_email text;
begin
  perform appt_private.assert_server(p_server_key);
  select lower(email) into v_account_email from public.mail_accounts where id = p_account;
  if v_account_email is null then raise exception 'Compte Gmail introuvable' using errcode = 'P0002'; end if;
  for m in select * from jsonb_array_elements(coalesce(p_messages, '[]')) loop
    v_from := lower(btrim(m ->> 'from'));
    if v_from is null or v_from = v_account_email
       or exists (select 1 from public.mail_messages where account_id = p_account and provider_message_id = m ->> 'provider_message_id')
       or (m ->> 'rfc_message_id' is not null and exists (select 1 from public.mail_messages where rfc_message_id = m ->> 'rfc_message_id' and direction = 'out')) then
      v_skipped := v_skipped + 1; continue;
    end if;
    select count(distinct p.company_id), min(p.id::text)::uuid into v_people, v_person
      from public.people p join public.companies c on c.id = p.company_id
     where p.email_norm = v_from and c.merged_into_id is null;
    if v_people = 0 then v_skipped := v_skipped + 1; continue; end if; -- hors contacts : rien n'est conservé
    v_company := null; v_cands := null; v_inter := null;
    if v_people = 1 then
      select company_id into v_company from public.people where id = v_person;
    else
      v_person := null;
      select jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.name, 'person_id', p.id) order by c.name) into v_cands
        from public.people p join public.companies c on c.id = p.company_id where p.email_norm = v_from and c.merged_into_id is null;
    end if;
    if coalesce((m ->> 'automatic')::boolean, false) then
      insert into public.mail_messages (account_id, direction, status, origin, company_id, person_id, from_addr, to_addrs, subject, body_text,
             provider_message_id, provider_thread_id, rfc_message_id, in_reply_to, references_hdr, received_at, link_state, attachments_meta)
      values (p_account, 'in', 'received', 'system', v_company, v_person, v_from,
              array(select jsonb_array_elements_text(coalesce(m -> 'to', '[]'))), left(coalesce(m ->> 'subject', ''), 500),
              left(coalesce(m ->> 'text', ''), 200000), m ->> 'provider_message_id', m ->> 'provider_thread_id', m ->> 'rfc_message_id',
              m ->> 'in_reply_to', m ->> 'references', coalesce((m ->> 'received_at')::timestamptz, now()), 'ignored', m -> 'attachments');
      v_ignored := v_ignored + 1; continue;
    end if;
    if v_company is not null then
      insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source, meta)
      values (v_company, v_person, 'message_in', 'email', least(coalesce((m ->> 'received_at')::timestamptz, now()), now()),
              left(coalesce(nullif(btrim(m ->> 'subject'), ''), '(sans objet)') || E'\n\n' || coalesce(m ->> 'text', ''), 20000),
              'system', 'system', jsonb_build_object('gmail_message_id', m ->> 'provider_message_id', 'thread_id', m ->> 'provider_thread_id'))
      returning id into v_inter;
      -- même règle qu'une réponse saisie à la main : relances de l'entreprise en pause, « Réponses à traiter »
      -- (seulement pour les messages nouveaux, pas pour l'import initial de l'historique)
      if not p_initial then
        update public.campaign_participants cp set status = 'a_repondu', next_due_date = null
          from public.campaigns ca
         where ca.id = cp.campaign_id and ca.status = 'active' and cp.company_id = v_company and cp.status in ('a_contacter', 'en_cours');
        get diagnostics v_paused = row_count;
        if v_paused > 0 then
          update public.interactions set campaign_participant_id = (
            select cp.id from public.campaign_participants cp where cp.company_id = v_company and cp.status = 'a_repondu'
             order by (cp.person_id = v_person) desc nulls last, cp.updated_at desc limit 1)
           where id = v_inter;
        end if;
        update public.companies set prospect_status = 'en_discussion' where id = v_company and prospect_status in ('nouveau', 'contacte');
      end if;
      v_linked := v_linked + 1;
    else
      v_to_link := v_to_link + 1;
    end if;
    insert into public.mail_messages (account_id, direction, status, origin, company_id, person_id, from_addr, to_addrs, subject, body_text,
           provider_message_id, provider_thread_id, rfc_message_id, in_reply_to, references_hdr, received_at, link_state, link_candidates,
           attachments_meta, interaction_id)
    values (p_account, 'in', 'received', 'manual', v_company, v_person, v_from,
            array(select jsonb_array_elements_text(coalesce(m -> 'to', '[]'))), left(coalesce(m ->> 'subject', ''), 500),
            left(coalesce(m ->> 'text', ''), 200000), m ->> 'provider_message_id', m ->> 'provider_thread_id', m ->> 'rfc_message_id',
            m ->> 'in_reply_to', m ->> 'references', coalesce((m ->> 'received_at')::timestamptz, now()),
            case when v_company is null then 'to_link' else 'linked' end, v_cands, m -> 'attachments', v_inter)
    returning id into v_id;
  end loop;
  insert into public.mail_sync_state (account_id, history_id, initial_done_at, last_sync_at, last_error, imported, updated_at)
  values (p_account, p_history_id, case when p_initial then now() end, now(), null, v_linked + v_to_link, now())
  on conflict (account_id) do update set
    history_id = coalesce(p_history_id, mail_sync_state.history_id),
    initial_done_at = coalesce(mail_sync_state.initial_done_at, case when p_initial then now() end),
    last_sync_at = now(), last_error = null, imported = mail_sync_state.imported + v_linked + v_to_link, updated_at = now();
  return jsonb_build_object('linked', v_linked, 'to_link', v_to_link, 'ignored', v_ignored, 'skipped', v_skipped);
end;
$$;

create or replace function public.mail_sync_error(p_server_key text, p_account uuid, p_error text, p_reset_history boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  insert into public.mail_sync_state (account_id, last_error, updated_at) values (p_account, left(p_error, 1000), now())
  on conflict (account_id) do update set last_error = left(p_error, 1000), updated_at = now(),
    history_id = case when p_reset_history then null else mail_sync_state.history_id end;
end;
$$;

-- Résolution manuelle d'un email « à rattacher » (ou correction d'un rattachement) : jamais modifié ensuite.
create or replace function public.mail_inbound_link(p_message uuid, p_company uuid, p_person uuid default null)
returns jsonb
language plpgsql
as $$
declare mm public.mail_messages; v_inter uuid;
begin
  perform public.assert_owner();
  select * into mm from public.mail_messages where id = p_message and direction = 'in' for update;
  if mm.id is null then raise exception 'Email introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;
  if mm.interaction_id is not null then
    update public.interactions set company_id = p_company, person_id = p_person where id = mm.interaction_id;
    v_inter := mm.interaction_id;
  else
    insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source, meta)
    values (p_company, p_person, 'message_in', 'email', least(coalesce(mm.received_at, now()), now()),
            left(coalesce(nullif(btrim(mm.subject), ''), '(sans objet)') || E'\n\n' || mm.body_text, 20000), 'system', 'user',
            jsonb_build_object('gmail_message_id', mm.provider_message_id))
    returning id into v_inter;
  end if;
  update public.mail_messages set company_id = p_company, person_id = p_person, link_state = 'linked', linked_manually = true,
         interaction_id = v_inter, link_candidates = null where id = mm.id;
  return jsonb_build_object('id', mm.id, 'interaction_id', v_inter);
end;
$$;

-- ===========================================================================
-- Droits : fonctions à clé serveur ouvertes au client sans session (elles vérifient la clé), le reste au propriétaire.
-- ===========================================================================
do $$
declare f text;
begin
  foreach f in array array[
    'public.job_report(text, text, boolean, text, jsonb)', 'public.appt_rate_check(text, text, text)',
    'public.mail_server_account(text)', 'public.mail_server_store_access(text, uuid, text, timestamptz, text)',
    'public.mail_server_mark_reconnect(text, uuid, text)', 'public.mail_server_record(text, jsonb)',
    'public.mail_sync_cursor(text, uuid)', 'public.mail_inbound_ingest(text, uuid, jsonb, text, boolean)',
    'public.mail_sync_error(text, uuid, text, boolean)']
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;
revoke execute on function public.mail_inbound_link(uuid, uuid, uuid) from public, anon;
grant execute on function public.mail_inbound_link(uuid, uuid, uuid) to authenticated;
grant select on public.scheduled_jobs, public.mail_sync_state to authenticated;

-- Compteur du menu : + emails reçus à rattacher (même source que « Aujourd'hui »).
create or replace function public.nav_counters(p_today date)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'todo', (select count(*) from public.todo_items where due_date <= p_today),
    'due', (select count(*) from public.todo_items where item_type = 'followup' and due_date <= p_today),
    'replies', (select count(*) from public.campaign_participants where status = 'a_repondu' and outcome in ('none', 'replied')),
    'calls', (select count(*) from public.fireflies_calls where link_state = 'to_link'),
    'emails', (select count(*) from public.mail_messages where direction = 'in' and link_state = 'to_link'));
$$;
