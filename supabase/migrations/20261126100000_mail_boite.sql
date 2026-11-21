-- Mail, lot M01 — index de toute la boîte Gmail (dossiers, libellés, états des fils).
-- Migration additive : quatre tables, des fonctions à clé serveur, un déclencheur de purge à la déconnexion et le
-- passage planifié « boite ». Aucune table ni fonction existante n'est modifiée (sauf la liste des passages).
-- Seul l'INDEX est conservé (expéditeur, destinataires, objet, extrait, libellés) : le corps des messages et les
-- pièces jointes restent dans Gmail et sont lus à la demande.

-- ===========================================================================
-- Tables
-- ===========================================================================
create table if not exists public.mailbox_labels (
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  label_id text not null check (char_length(label_id) <= 200),
  name text not null check (char_length(name) <= 500),
  kind text not null check (kind in ('system', 'user')),
  messages_total int not null default 0,
  messages_unread int not null default 0,
  threads_total int not null default 0,
  threads_unread int not null default 0,
  hidden boolean not null default false,
  color_bg text,
  color_text text,
  updated_at timestamptz not null default now(),
  primary key (account_id, label_id)
);

create table if not exists public.mailbox_messages (
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  message_id text not null check (char_length(message_id) <= 200),
  thread_id text not null check (char_length(thread_id) <= 200),
  internal_at timestamptz not null,
  from_name text,
  from_email text,
  to_addrs text[] not null default '{}',
  cc_addrs text[] not null default '{}',
  subject text not null default '',
  snippet text not null default '',
  label_ids text[] not null default '{}',
  has_attachments boolean not null default false,
  size_estimate int,
  rfc_message_id text,
  -- génération de synchronisation complète : ce qui n'a pas été revu à la fin d'une reprise complète est retiré
  sync_gen int not null default 0,
  updated_at timestamptz not null default now(),
  primary key (account_id, message_id)
);
create index if not exists mailbox_messages_thread on public.mailbox_messages (account_id, thread_id);
create index if not exists mailbox_messages_gen on public.mailbox_messages (account_id, sync_gen);

-- Un fil = l'union de ses messages, comme dans Gmail : il apparaît dans un dossier dès qu'un message y est.
create table if not exists public.mailbox_threads (
  account_id uuid not null references public.mail_accounts (id) on delete cascade,
  thread_id text not null,
  last_at timestamptz not null,
  subject text not null default '',
  snippet text not null default '',
  participants text[] not null default '{}',
  message_count int not null default 1,
  label_ids text[] not null default '{}',
  unread boolean generated always as ('UNREAD' = any (label_ids)) stored,
  starred boolean generated always as ('STARRED' = any (label_ids)) stored,
  important boolean generated always as ('IMPORTANT' = any (label_ids)) stored,
  has_attachments boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (account_id, thread_id)
);
create index if not exists mailbox_threads_recent on public.mailbox_threads (account_id, last_at desc, thread_id);
create index if not exists mailbox_threads_labels on public.mailbox_threads using gin (label_ids);

create table if not exists public.mailbox_sync (
  account_id uuid primary key references public.mail_accounts (id) on delete cascade,
  history_id text,
  generation int not null default 0,
  backfill_token text,
  backfill_started_at timestamptz,
  backfill_done_at timestamptz,
  last_sync_at timestamptz,
  error_code text,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

-- ===========================================================================
-- Droits : lecture réservée au propriétaire dans l'application (jamais le connecteur Claude, jamais un autre
-- compte) ; aucune écriture directe : tout passe par les fonctions à clé serveur ci-dessous.
-- ===========================================================================
do $$
declare t text;
begin
  foreach t in array array['mailbox_labels', 'mailbox_messages', 'mailbox_threads', 'mailbox_sync'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists owner_read on public.%I', t);
    execute format('create policy owner_read on public.%I for select to authenticated
      using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ===========================================================================
-- Fils : recalcul à partir des messages (appelé après chaque écriture)
-- ===========================================================================
create schema if not exists mailbox_private;
revoke all on schema mailbox_private from public, anon, authenticated;

create or replace function mailbox_private.refresh_threads(p_account uuid, p_threads text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_threads is null or cardinality(p_threads) = 0 then return; end if;
  delete from public.mailbox_threads t
   where t.account_id = p_account and t.thread_id = any (p_threads)
     and not exists (select 1 from public.mailbox_messages m where m.account_id = p_account and m.thread_id = t.thread_id);
  insert into public.mailbox_threads (account_id, thread_id, last_at, subject, snippet, participants, message_count, label_ids, has_attachments, updated_at)
  select m.account_id, m.thread_id, max(m.internal_at),
         (array_agg(m.subject order by m.internal_at, m.message_id))[1],
         (array_agg(m.snippet order by m.internal_at desc, m.message_id desc))[1],
         coalesce(array_agg(distinct coalesce(nullif(m.from_name, ''), m.from_email)) filter (where coalesce(nullif(m.from_name, ''), m.from_email) is not null), '{}'),
         count(*)::int,
         coalesce((select array_agg(distinct l order by l) from public.mailbox_messages x cross join lateral unnest(x.label_ids) l
                    where x.account_id = m.account_id and x.thread_id = m.thread_id), '{}'),
         bool_or(m.has_attachments), now()
    from public.mailbox_messages m
   where m.account_id = p_account and m.thread_id = any (p_threads)
   group by m.account_id, m.thread_id
  on conflict (account_id, thread_id) do update
    set last_at = excluded.last_at, subject = excluded.subject, snippet = excluded.snippet, participants = excluded.participants,
        message_count = excluded.message_count, label_ids = excluded.label_ids, has_attachments = excluded.has_attachments,
        updated_at = now();
end;
$$;
revoke all on function mailbox_private.refresh_threads(uuid, text[]) from public, anon, authenticated;

-- ===========================================================================
-- Fonctions à clé serveur (passage planifié et synchronisation lancée par le propriétaire)
-- ===========================================================================

-- Prend la main pour `p_ttl` secondes et renvoie l'état ; null si un autre passage est en cours.
create or replace function public.mailbox_sync_claim(p_server_key text, p_account uuid, p_ttl int default 90)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare s public.mailbox_sync;
begin
  perform appt_private.assert_server(p_server_key);
  if not exists (select 1 from public.mail_accounts where id = p_account and status = 'connected') then
    raise exception 'Compte Gmail non connecté.' using errcode = 'P0001';
  end if;
  insert into public.mailbox_sync (account_id) values (p_account) on conflict (account_id) do nothing;
  update public.mailbox_sync set locked_until = now() + make_interval(secs => least(greatest(p_ttl, 10), 600)), updated_at = now()
   where account_id = p_account and (locked_until is null or locked_until < now())
  returning * into s;
  if not found then return null; end if;
  return jsonb_build_object('history_id', s.history_id, 'generation', s.generation, 'backfill_token', s.backfill_token,
                            'backfill_done', s.backfill_done_at is not null);
end;
$$;

create or replace function public.mailbox_sync_release(p_server_key text, p_account uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.mailbox_sync set locked_until = null where account_id = p_account;
end;
$$;

-- Nouvelle synchronisation complète : le repère d'historique est pris AVANT de relire la boîte, pour que tout
-- changement fait pendant la relecture soit rejoué ensuite.
create or replace function public.mailbox_sync_begin(p_server_key text, p_account uuid, p_history_id text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v int;
begin
  perform appt_private.assert_server(p_server_key);
  update public.mailbox_sync
     set generation = generation + 1, history_id = p_history_id, backfill_token = null, backfill_started_at = now(),
         backfill_done_at = null, error_code = null, last_error = null, updated_at = now()
   where account_id = p_account
  returning generation into v;
  if v is null then raise exception 'Synchronisation non initialisée.' using errcode = 'P0001'; end if;
  return v;
end;
$$;

-- Une écriture atomique : messages, suppressions, libellés et repères avancent ensemble (ou pas du tout), ce qui
-- permet de reprendre exactement où le passage précédent s'est arrêté.
-- p = { upserts: [{id, thread_id, internal_at, from_name, from_email, to[], cc[], subject, snippet, label_ids[],
--                  has_attachments, size_estimate, rfc_message_id}],
--       deleted: [id], labels: [{id, name, kind, messages_total, messages_unread, threads_total, threads_unread,
--       hidden, color_bg, color_text}] (absent = inchangés), history_id, backfill: {token, done} }
create or replace function public.mailbox_apply(p_server_key text, p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.mailbox_sync;
  v_threads text[] := '{}';
  v_tmp text[];
  v_up int := 0;
  v_del int := 0;
  v_purged int := 0;
begin
  perform appt_private.assert_server(p_server_key);
  select * into s from public.mailbox_sync where account_id = p_account for update;
  if not found then raise exception 'Synchronisation non initialisée.' using errcode = 'P0001'; end if;

  if jsonb_typeof(p -> 'upserts') = 'array' and jsonb_array_length(p -> 'upserts') > 0 then
    if jsonb_array_length(p -> 'upserts') > 500 then raise exception 'Lot trop grand.' using errcode = 'P0001'; end if;
    -- un message qui change de fil (rare) : l'ancien fil est recalculé aussi
    select coalesce(array_agg(distinct m.thread_id), '{}') into v_tmp
      from public.mailbox_messages m join jsonb_array_elements(p -> 'upserts') u on u ->> 'id' = m.message_id
     where m.account_id = p_account;
    v_threads := v_threads || v_tmp;
    with rows as (
      insert into public.mailbox_messages (account_id, message_id, thread_id, internal_at, from_name, from_email, to_addrs, cc_addrs,
                                           subject, snippet, label_ids, has_attachments, size_estimate, rfc_message_id, sync_gen, updated_at)
      select distinct on (u ->> 'id') p_account, left(u ->> 'id', 200), left(u ->> 'thread_id', 200), (u ->> 'internal_at')::timestamptz,
             left(u ->> 'from_name', 300), left(lower(u ->> 'from_email'), 320),
             coalesce((select array_agg(left(x, 320)) from jsonb_array_elements_text(case when jsonb_typeof(u -> 'to') = 'array' then u -> 'to' else '[]'::jsonb end) x), '{}'),
             coalesce((select array_agg(left(x, 320)) from jsonb_array_elements_text(case when jsonb_typeof(u -> 'cc') = 'array' then u -> 'cc' else '[]'::jsonb end) x), '{}'),
             left(coalesce(u ->> 'subject', ''), 500), left(coalesce(u ->> 'snippet', ''), 500),
             coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(u -> 'label_ids') = 'array' then u -> 'label_ids' else '[]'::jsonb end) x), '{}'),
             coalesce((u ->> 'has_attachments')::boolean, false), (u ->> 'size_estimate')::int, left(u ->> 'rfc_message_id', 1000),
             s.generation, now()
        from jsonb_array_elements(p -> 'upserts') u
       where coalesce(u ->> 'id', '') <> '' and coalesce(u ->> 'thread_id', '') <> ''
      on conflict (account_id, message_id) do update
        set thread_id = excluded.thread_id, internal_at = excluded.internal_at, from_name = excluded.from_name,
            from_email = excluded.from_email, to_addrs = excluded.to_addrs, cc_addrs = excluded.cc_addrs, subject = excluded.subject,
            snippet = excluded.snippet, label_ids = excluded.label_ids, has_attachments = excluded.has_attachments,
            size_estimate = excluded.size_estimate, rfc_message_id = excluded.rfc_message_id, sync_gen = excluded.sync_gen,
            updated_at = now()
      returning thread_id
    )
    select count(*)::int, coalesce(array_agg(distinct thread_id), '{}') into v_up, v_tmp from rows;
    v_threads := v_threads || v_tmp;
  end if;

  if jsonb_typeof(p -> 'deleted') = 'array' and jsonb_array_length(p -> 'deleted') > 0 then
    with gone as (
      delete from public.mailbox_messages m
       where m.account_id = p_account and m.message_id in (select jsonb_array_elements_text(p -> 'deleted'))
      returning thread_id
    )
    select count(*)::int, coalesce(array_agg(distinct thread_id), '{}') into v_del, v_tmp from gone;
    v_threads := v_threads || v_tmp;
  end if;

  if jsonb_typeof(p -> 'labels') = 'array' then
    delete from public.mailbox_labels l
     where l.account_id = p_account and l.label_id not in (select x ->> 'id' from jsonb_array_elements(p -> 'labels') x);
    insert into public.mailbox_labels (account_id, label_id, name, kind, messages_total, messages_unread, threads_total, threads_unread,
                                       hidden, color_bg, color_text, updated_at)
    select distinct on (x ->> 'id') p_account, left(x ->> 'id', 200), left(coalesce(x ->> 'name', x ->> 'id'), 500),
           case when x ->> 'kind' = 'system' then 'system' else 'user' end,
           coalesce((x ->> 'messages_total')::int, 0), coalesce((x ->> 'messages_unread')::int, 0),
           coalesce((x ->> 'threads_total')::int, 0), coalesce((x ->> 'threads_unread')::int, 0),
           coalesce((x ->> 'hidden')::boolean, false), left(x ->> 'color_bg', 20), left(x ->> 'color_text', 20), now()
      from jsonb_array_elements(p -> 'labels') x
     where coalesce(x ->> 'id', '') <> ''
    on conflict (account_id, label_id) do update
      set name = excluded.name, kind = excluded.kind, messages_total = excluded.messages_total,
          messages_unread = excluded.messages_unread, threads_total = excluded.threads_total,
          threads_unread = excluded.threads_unread, hidden = excluded.hidden, color_bg = excluded.color_bg,
          color_text = excluded.color_text, updated_at = now();
  end if;

  -- fin d'une relecture complète : ce qui n'a pas été revu n'existe plus dans Gmail
  if coalesce((p -> 'backfill' ->> 'done')::boolean, false) then
    with gone as (
      delete from public.mailbox_messages m where m.account_id = p_account and m.sync_gen < s.generation returning thread_id
    )
    select count(*)::int, coalesce(array_agg(distinct thread_id), '{}') into v_purged, v_tmp from gone;
    v_threads := v_threads || v_tmp;
  end if;

  perform mailbox_private.refresh_threads(p_account, v_threads);

  update public.mailbox_sync
     set history_id = coalesce(nullif(p ->> 'history_id', ''), history_id),
         backfill_token = case when p ? 'backfill' then p -> 'backfill' ->> 'token' else backfill_token end,
         backfill_done_at = case when coalesce((p -> 'backfill' ->> 'done')::boolean, false) then now() else backfill_done_at end,
         last_sync_at = now(), error_code = null, last_error = null, updated_at = now()
   where account_id = p_account;

  return jsonb_build_object('upserted', v_up, 'deleted', v_del + v_purged);
end;
$$;

-- Échec d'un passage : les repères restent en place (reprise au passage suivant). p_reset : l'historique Gmail a
-- expiré, la prochaine synchronisation relit toute la boîte.
create or replace function public.mailbox_sync_fail(p_server_key text, p_account uuid, p_code text, p_error text, p_reset boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform appt_private.assert_server(p_server_key);
  update public.mailbox_sync
     set error_code = left(p_code, 40), last_error = left(p_error, 1000), locked_until = null, updated_at = now(),
         history_id = case when p_reset then null else history_id end
   where account_id = p_account;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.mailbox_sync_claim(text, uuid, int)', 'public.mailbox_sync_release(text, uuid)',
    'public.mailbox_sync_begin(text, uuid, text)', 'public.mailbox_apply(text, uuid, jsonb)',
    'public.mailbox_sync_fail(text, uuid, text, text, boolean)']
  loop
    execute format('revoke execute on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- ===========================================================================
-- Déconnexion du compte : l'index de la boîte est effacé (il sera relu à la reconnexion)
-- ===========================================================================
create or replace function public.tg_mailbox_purge()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.mailbox_messages where account_id = new.id;
  delete from public.mailbox_threads where account_id = new.id;
  delete from public.mailbox_labels where account_id = new.id;
  delete from public.mailbox_sync where account_id = new.id;
  return new;
end;
$$;
revoke all on function public.tg_mailbox_purge() from public, anon, authenticated;
drop trigger if exists mailbox_purge on public.mail_accounts;
create trigger mailbox_purge after update of status on public.mail_accounts
  for each row when (new.status = 'disconnected' and old.status is distinct from 'disconnected')
  execute function public.tg_mailbox_purge();

-- ===========================================================================
-- Passage planifié « boite » (liste complétée sans rien retirer)
-- ===========================================================================
do $$
declare v text;
begin
  select pg_get_constraintdef(oid) into v from pg_constraint
   where conrelid = 'public.scheduled_jobs'::regclass and conname = 'scheduled_jobs_job_check';
  if v is not null and v not like '%''boite''%' and v like '%ARRAY[%' then
    alter table public.scheduled_jobs drop constraint scheduled_jobs_job_check;
    execute 'alter table public.scheduled_jobs add constraint scheduled_jobs_job_check ' || replace(v, 'ARRAY[', 'ARRAY[''boite''::text, ');
  end if;
end $$;
