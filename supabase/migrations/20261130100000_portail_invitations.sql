-- Portail client : invitation par mail et mot de passe choisi par le contact.
-- Migration additive. Les accès et codes existants restent valables tels quels : un code n'est désactivé que
-- lorsque son contact active un compte par invitation. Aucun mail n'est envoyé par la base.
--
-- - Un contact = un accès (portal_accesses, inchangé) = un compte : le mot de passe s'ajoute à cet accès.
-- - L'identifiant est l'email de la fiche personne (comparaison normalisée : casse et espaces).
-- - Invitation : jeton aléatoire dont seule l'empreinte (HMAC serveur) est stockée, usage unique, 7 jours.
--   Lien de réinitialisation : même mécanisme (kind = 'reset'), 24 heures, envoyé par le propriétaire après une
--   demande « Mot de passe oublié » (le CRM n'envoie pas de mail sans la session du propriétaire).
-- - Renvoyer invalide la précédente ; révoquer l'accès ou changer l'email de la fiche invalide l'invitation en attente.
-- - Le mot de passe n'est jamais vu par la base en clair : le serveur Next n'y écrit qu'une empreinte scrypt.

-- ---------------------------------------------------------------------------
-- 1. Accès : le code devient facultatif, le compte s'y ajoute
-- ---------------------------------------------------------------------------
alter table public.portal_accesses alter column code_hash drop not null;
alter table public.portal_accesses alter column code_hint drop not null;
alter table public.portal_accesses add column if not exists password_hash text
  check (password_hash is null or password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$');
alter table public.portal_accesses add column if not exists activated_at timestamptz;
alter table public.portal_accesses add column if not exists password_changed_at timestamptz;
alter table public.portal_accesses add column if not exists reset_requested_at timestamptz;
-- l'empreinte du mot de passe reste illisible par l'API, comme celle du code
grant select (activated_at, password_changed_at, reset_requested_at) on public.portal_accesses to authenticated;

-- Tentatives : même table, distinguées par leur nature (le compteur par adresse IP reste commun)
alter table public.portal_login_attempts add column if not exists kind text not null default 'code';

create or replace function portal_private.norm_email(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(lower(btrim(p)), '');
$$;

create or replace function portal_private.valid_email(p text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(char_length(p) <= 320 and p ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$', false);
$$;

-- ---------------------------------------------------------------------------
-- 2. Invitations
-- ---------------------------------------------------------------------------
create table if not exists public.portal_invitations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references public.people (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  kind text not null default 'invitation' check (kind in ('invitation', 'reset')),
  -- email autorisé au moment de l'envoi : c'est lui, et lui seul, que la page « Créer mon accès » affiche
  email text not null check (email = lower(btrim(email)) and portal_private.valid_email(email)),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  -- clé d'idempotence fournie par l'écran : un double clic ne crée qu'une invitation
  request_id uuid not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  mail_id uuid,
  used_at timestamptz,
  invalidated_at timestamptz,
  invalidated_reason text check (invalidated_reason in ('resent', 'revoked', 'email_changed', 'send_failed', 'activated'))
);
create index if not exists portal_invitations_person_idx on public.portal_invitations (person_id, created_at desc);
-- au plus une invitation en attente par contact
create unique index if not exists portal_invitations_live on public.portal_invitations (person_id)
  where used_at is null and invalidated_at is null;

alter table public.portal_invitations enable row level security;
drop policy if exists owner_select on public.portal_invitations;
create policy owner_select on public.portal_invitations for select to authenticated using ((select public.is_app_owner()));
revoke all on public.portal_invitations from anon, authenticated;
grant select (id, person_id, project_id, kind, email, created_at, expires_at, sent_at, mail_id, used_at, invalidated_at, invalidated_reason)
  on public.portal_invitations to authenticated;

-- une invitation suit la fiche personne à la corbeille (masquée tant que la personne y est)
do $$
begin
  if to_regprocedure('trash_private.hide(text, text[])') is not null then
    perform trash_private.hide('portal_invitations', array['id:portal_invitations', 'person_id:people']);
  end if;
end $$;

-- Invitation encore utilisable : non utilisée, non invalidée, dans les temps ; accès ouvert ; email inchangé.
create or replace function portal_private.invitation_usable(i public.portal_invitations)
returns boolean
language sql
stable
set search_path = ''
as $$
  select i.used_at is null and i.invalidated_at is null and i.expires_at > now()
     and exists (
       select 1 from public.portal_accesses a join public.people p on p.id = a.person_id
        where a.person_id = i.person_id and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
          and portal_private.norm_email(p.email) = i.email
          and (case when i.kind = 'reset' then a.password_hash is not null else a.password_hash is null end)
          and not public.in_trash('portal_accesses', a.id) and not public.in_trash('people', p.id));
$$;

-- Limitation commune aux pages publiques : 8 échecs par adresse IP en 15 minutes.
create or replace function portal_private.ip_blocked(p_ip_hash text)
returns boolean language sql stable set search_path = '' as $$
  select (select count(*) from public.portal_login_attempts where ip_hash = p_ip_hash and not success and created_at > now() - interval '15 minutes') >= 8;
$$;

-- ---------------------------------------------------------------------------
-- 3. Propriétaire : créer, renvoyer, marquer l'envoi (application uniquement, jamais Claude)
-- ---------------------------------------------------------------------------
create or replace function public.portal_invite_create(p_person uuid, p_project uuid, p_kind text, p_token_hash text, p_request_id uuid,
                                                       p_expires_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_first text;
  v_company uuid;
  a public.portal_accesses;
  i public.portal_invitations;
begin
  perform portal_private.assert_owner_user();
  -- même demande (double clic, nouvel essai réseau) : rien de nouveau n'est créé
  select * into i from public.portal_invitations where request_id = p_request_id;
  if found then
    if i.person_id <> p_person or i.kind <> p_kind then raise exception 'Demande invalide' using errcode = '22023'; end if;
    return jsonb_build_object('id', i.id, 'email', i.email, 'kind', i.kind, 'duplicate', true, 'sent', i.sent_at is not null,
                              'invalidated', i.invalidated_at is not null);
  end if;
  if p_kind is null or p_kind not in ('invitation', 'reset') then raise exception 'Type d''envoi inconnu' using errcode = '22023'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'Jeton invalide' using errcode = '22023'; end if;
  -- une seule création à la fois par contact
  select portal_private.norm_email(email), first_name, company_id into v_email, v_first, v_company
    from public.people where id = p_person for update;
  if not found then raise exception 'Contact introuvable' using errcode = 'P0002'; end if;
  if v_email is null then raise exception 'Ce contact n''a pas d''email : ajoutez-le sur sa fiche.' using errcode = '22023'; end if;
  if not portal_private.valid_email(v_email) then raise exception 'L''email de ce contact n''est pas valide : corrigez-le sur sa fiche.' using errcode = '22023'; end if;
  if p_project is not null and not exists (select 1 from public.project_members where project_id = p_project and person_id = p_person) then
    raise exception 'Ce contact n''est pas membre du projet' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then raise exception 'La date d''expiration est déjà passée' using errcode = '22023'; end if;
  -- l'email est l'identifiant : il ne peut appartenir qu'à un seul compte
  if exists (select 1 from public.portal_accesses x join public.people p on p.id = x.person_id
              where x.person_id <> p_person and x.password_hash is not null and x.revoked_at is null
                and portal_private.norm_email(p.email) = v_email) then
    raise exception 'Cet email est déjà l''identifiant du compte d''un autre contact.' using errcode = '23505';
  end if;

  select * into a from public.portal_accesses where person_id = p_person for update;
  if p_kind = 'invitation' then
    if found and a.revoked_at is null and a.password_hash is not null then
      raise exception 'Ce contact a déjà un compte : ses projets s''ajoutent à son accès, sans nouvelle invitation.' using errcode = '22023';
    end if;
    if not found then
      insert into public.portal_accesses (person_id, expires_at) values (p_person, p_expires_at) returning * into a;
    elsif a.revoked_at is not null then
      -- nouvel accès après révocation : ni l'ancien code ni l'ancien mot de passe ne reviennent
      update public.portal_accesses set revoked_at = null, code_hash = null, code_hint = null, password_hash = null, activated_at = null,
             password_changed_at = null, reset_requested_at = null, expires_at = p_expires_at, code_generated_at = now()
       where id = a.id returning * into a;
    end if;
  else
    if not found or a.revoked_at is not null or a.password_hash is null then
      raise exception 'Ce contact n''a pas de compte actif : envoyez-lui une invitation.' using errcode = '22023';
    end if;
  end if;
  if a.expires_at is not null and a.expires_at <= now() then
    raise exception 'L''accès de ce contact a expiré : changez d''abord sa date d''expiration.' using errcode = '22023';
  end if;

  update public.portal_invitations set invalidated_at = now(), invalidated_reason = 'resent'
   where person_id = p_person and used_at is null and invalidated_at is null;
  insert into public.portal_invitations (person_id, project_id, kind, email, token_hash, request_id, expires_at)
  values (p_person, p_project, p_kind, v_email, p_token_hash, p_request_id,
          now() + case when p_kind = 'reset' then interval '24 hours' else interval '7 days' end)
  returning * into i;
  if p_project is not null then
    perform portal_private.log(p_project, 'owner', p_person, case when p_kind = 'reset' then 'portal_reset_created' else 'portal_invitation_created' end);
  end if;
  return jsonb_build_object('id', i.id, 'email', i.email, 'kind', i.kind, 'duplicate', false, 'sent', false, 'invalidated', false,
                            'first_name', v_first, 'company_id', v_company, 'expires_at', i.expires_at);
end;
$$;

-- Résultat de l'envoi : envoyé (le lien devient « Invitation envoyée ») ou échec (l'invitation est invalidée).
create or replace function public.portal_invite_mark(p_id uuid, p_sent boolean, p_mail_id uuid default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_owner_user();
  if p_sent then
    update public.portal_invitations set sent_at = coalesce(sent_at, now()), mail_id = coalesce(p_mail_id, mail_id)
     where id = p_id and used_at is null and invalidated_at is null;
  else
    update public.portal_invitations set invalidated_at = now(), invalidated_reason = 'send_failed'
     where id = p_id and used_at is null and invalidated_at is null and sent_at is null;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Invalidations automatiques
-- ---------------------------------------------------------------------------
create or replace function portal_private.tg_access_revoked()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.portal_invitations set invalidated_at = now(), invalidated_reason = 'revoked'
   where person_id = new.person_id and used_at is null and invalidated_at is null;
  return new;
end; $$;
drop trigger if exists portal_invitations_revoked on public.portal_accesses;
create trigger portal_invitations_revoked after update of revoked_at on public.portal_accesses
  for each row when (old.revoked_at is null and new.revoked_at is not null) execute function portal_private.tg_access_revoked();

create or replace function portal_private.tg_person_email()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if portal_private.norm_email(new.email) is distinct from portal_private.norm_email(old.email) then
    update public.portal_invitations set invalidated_at = now(), invalidated_reason = 'email_changed'
     where person_id = new.id and used_at is null and invalidated_at is null;
  end if;
  return new;
end; $$;
drop trigger if exists portal_invitations_email on public.people;
create trigger portal_invitations_email after update of email on public.people
  for each row execute function portal_private.tg_person_email();

-- ---------------------------------------------------------------------------
-- 5. Portail (serveur Next + clé serveur) : lien, activation, connexion, mot de passe oublié
-- ---------------------------------------------------------------------------

-- Ouverture du lien : renvoie l'email porté par l'invitation (jamais lu dans l'URL).
create or replace function public.portal_invite_check(p_server_key text, p_token_hash text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare i public.portal_invitations;
begin
  perform portal_private.assert_server(p_server_key);
  if portal_private.ip_blocked(p_ip_hash) then return jsonb_build_object('status', 'rate_limited'); end if;
  select * into i from public.portal_invitations where token_hash = p_token_hash;
  if not found or not portal_private.invitation_usable(i) then
    insert into public.portal_login_attempts (ip_hash, success, kind) values (p_ip_hash, false, 'invitation');
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'ok', 'email', i.email, 'kind', i.kind,
                            'first_name', (select first_name from public.people where id = i.person_id));
end;
$$;

-- Création du mot de passe : une seule opération (compte activé, ancien code désactivé, lien consommé, session ouverte).
create or replace function public.portal_invite_activate(p_server_key text, p_token_hash text, p_password_hash text, p_ip_hash text,
                                                         p_session_hash text, p_user_agent text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  i public.portal_invitations;
  a public.portal_accesses;
  v_name text;
begin
  perform portal_private.assert_server(p_server_key);
  if portal_private.ip_blocked(p_ip_hash) then return jsonb_build_object('status', 'rate_limited'); end if;
  if p_password_hash is null or p_password_hash !~ '^scrypt\$' or p_session_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Requête invalide' using errcode = '22023';
  end if;
  -- verrou : une double soumission attend la première, puis trouve le lien consommé
  select * into i from public.portal_invitations where token_hash = p_token_hash for update;
  if not found or not portal_private.invitation_usable(i) then
    insert into public.portal_login_attempts (ip_hash, success, kind) values (p_ip_hash, false, 'invitation');
    return jsonb_build_object('status', 'invalid');
  end if;
  update public.portal_accesses
     set password_hash = p_password_hash, activated_at = coalesce(activated_at, now()), password_changed_at = now(),
         code_hash = null, code_hint = null, reset_requested_at = null, last_used_at = now()
   where person_id = i.person_id
  returning * into a;
  -- toutes les sessions précédentes (ancien code, autres appareils) sont fermées
  update public.portal_sessions set revoked_at = now() where access_id = a.id and revoked_at is null;
  update public.portal_invitations set used_at = now() where id = i.id;
  update public.portal_invitations set invalidated_at = now(), invalidated_reason = 'activated'
   where person_id = i.person_id and id <> i.id and used_at is null and invalidated_at is null;
  insert into public.portal_login_attempts (ip_hash, success, kind) values (p_ip_hash, true, 'invitation');
  insert into public.portal_sessions (access_id, token_hash, user_agent, expires_at)
  values (a.id, p_session_hash, left(p_user_agent, 300), least(now() + interval '30 days', coalesce(a.expires_at, now() + interval '30 days')));
  if i.project_id is not null then
    perform portal_private.log(i.project_id, 'client', i.person_id, case when i.kind = 'reset' then 'portal_password_reset' else 'portal_account_activated' end);
  end if;
  select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) into v_name from public.people where id = i.person_id;
  return jsonb_build_object('status', 'ok', 'name', v_name);
end;
$$;

-- Connexion par email, étape 1 : empreinte du mot de passe du compte (vérifiée par le serveur Next, scrypt).
-- p_email_hash : empreinte de l'email normalisé, pour limiter les essais par compte (8 en 15 minutes).
create or replace function public.portal_password_challenge(p_server_key text, p_email text, p_email_hash text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids uuid[];
  a public.portal_accesses;
begin
  perform portal_private.assert_server(p_server_key);
  if portal_private.ip_blocked(p_ip_hash)
     or (select count(*) from public.portal_login_attempts where code_hash = p_email_hash and kind = 'password' and not success
          and created_at > now() - interval '15 minutes') >= 8 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  select array_agg(x.id) into v_ids
    from public.portal_accesses x join public.people p on p.id = x.person_id
   where portal_private.norm_email(p.email) = portal_private.norm_email(p_email)
     and x.password_hash is not null and x.revoked_at is null and (x.expires_at is null or x.expires_at > now())
     and not public.in_trash('portal_accesses', x.id) and not public.in_trash('people', p.id);
  if coalesce(array_length(v_ids, 1), 0) <> 1 then return jsonb_build_object('status', 'unknown'); end if;
  select * into a from public.portal_accesses where id = v_ids[1];
  return jsonb_build_object('status', 'ok', 'access_id', a.id, 'hash', a.password_hash);
end;
$$;

-- Connexion par email, étape 2 : résultat de la vérification. Succès : session ouverte si l'accès est inchangé.
create or replace function public.portal_password_login(p_server_key text, p_access uuid, p_password_hash text, p_ok boolean,
                                                        p_email_hash text, p_ip_hash text, p_session_hash text, p_user_agent text default null)
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
  select * into a from public.portal_accesses
   where id = p_access and password_hash = p_password_hash and revoked_at is null and (expires_at is null or expires_at > now());
  if not coalesce(p_ok, false) or a.id is null or p_session_hash is null then
    insert into public.portal_login_attempts (ip_hash, success, code_hash, kind) values (p_ip_hash, false, p_email_hash, 'password');
    return jsonb_build_object('status', 'invalid');
  end if;
  insert into public.portal_login_attempts (ip_hash, success, code_hash, kind) values (p_ip_hash, true, p_email_hash, 'password');
  insert into public.portal_sessions (access_id, token_hash, user_agent, expires_at)
  values (a.id, p_session_hash, left(p_user_agent, 300), least(now() + interval '30 days', coalesce(a.expires_at, now() + interval '30 days')));
  update public.portal_accesses set last_used_at = now() where id = a.id;
  delete from public.portal_login_attempts where created_at < now() - interval '1 day';
  delete from public.portal_sessions where expires_at < now() - interval '30 days';
  select btrim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')) into v_name from public.people where id = a.person_id;
  return jsonb_build_object('status', 'ok', 'name', v_name);
end;
$$;

-- Mot de passe oublié : la demande est notée sur l'accès d'un email autorisé ; le propriétaire envoie le lien
-- depuis le CRM. Réponse identique que l'email existe ou non. 5 demandes par adresse IP et par heure.
create or replace function public.portal_reset_request(p_server_key text, p_email text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform portal_private.assert_server(p_server_key);
  if (select count(*) from public.portal_login_attempts where ip_hash = p_ip_hash and kind = 'reset' and created_at > now() - interval '1 hour') >= 5 then
    return jsonb_build_object('status', 'rate_limited');
  end if;
  insert into public.portal_login_attempts (ip_hash, success, kind) values (p_ip_hash, true, 'reset');
  update public.portal_accesses x set reset_requested_at = now()
    from public.people p
   where p.id = x.person_id and x.revoked_at is null and (x.expires_at is null or x.expires_at > now())
     and portal_private.norm_email(p.email) = portal_private.norm_email(p_email)
     and portal_private.valid_email(portal_private.norm_email(p_email))
     and not public.in_trash('people', p.id);
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Droits
-- ---------------------------------------------------------------------------
revoke all on all functions in schema portal_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['portal_invite_create(uuid, uuid, text, text, uuid, timestamptz)', 'portal_invite_mark(uuid, boolean, uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array[
    'portal_invite_check(text, text, text)', 'portal_invite_activate(text, text, text, text, text, text)',
    'portal_password_challenge(text, text, text, text)', 'portal_password_login(text, uuid, text, boolean, text, text, text, text)',
    'portal_reset_request(text, text, text)']
  loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
