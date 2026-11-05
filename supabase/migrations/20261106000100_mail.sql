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

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
