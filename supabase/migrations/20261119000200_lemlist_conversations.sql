-- Messages lemlist, lot M2 : liste des conversations des comptes lemlist des clients.
-- Additive : une table, ses fonctions, une colonne ajoutée à lemlist_accounts (lot M1, même chantier).
--  * Le CRM ne garde que de quoi afficher la liste et les non-lus : contact (nom, email), canaux, dates, état lu.
--    Le contenu des messages n'est jamais stocké : il est lu chez lemlist à l'ouverture du fil.
--  * Chaque conversation appartient à UN compte (donc à une fiche). Même contact chez deux clients : deux lignes.
--  * Ces contacts sont les prospects des clients : aucune fiche, aucun contact, aucune pipeline n'est créé.
--  * Non-lu : lemlist l'indique non lue ET elle n'a pas été ouverte dans le CRM depuis sa dernière activité.
--    Ouvrir le fil dans le CRM ne change rien chez lemlist (pas de « marquer comme lu » côté client).
--  * Propriétaire uniquement, ni portail ni Claude ; cachée avec la fiche mise à la corbeille.

alter table public.lemlist_accounts add column if not exists last_synced_at timestamptz;

create table public.lemlist_conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.lemlist_accounts (id) on delete cascade,
  -- recopiée du compte (et suivie à la fusion) : sert au filtre Client et à la Corbeille
  company_id uuid not null references public.companies (id) on delete cascade,
  lemlist_id text not null check (char_length(lemlist_id) between 1 and 100),
  contact_id text not null check (char_length(contact_id) between 1 and 100),
  contact_name text check (contact_name is null or char_length(contact_name) <= 300),
  contact_email text check (contact_email is null or char_length(contact_email) <= 320),
  channels text[] not null default '{}',
  last_channel text check (last_channel is null or last_channel in ('email', 'linkedin')),
  -- membre de l'équipe lemlist qui suit la conversation (expéditeur des réponses, lot M3)
  sender_user_id text check (sender_user_id is null or char_length(sender_user_id) <= 100),
  last_activity_at timestamptz not null,
  last_reply_at timestamptz,
  has_replies boolean not null default false,
  lemlist_unread boolean not null default false,
  seen_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (account_id, lemlist_id)
);
create index lemlist_conversations_recent_idx on public.lemlist_conversations (last_activity_at desc);
create index lemlist_conversations_company_idx on public.lemlist_conversations (company_id);

alter table public.lemlist_conversations enable row level security;
create policy owner_all on public.lemlist_conversations for all to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.lemlist_conversations from anon;
select trash_private.hide('lemlist_conversations', array['company_id:companies']);

-- Compte déconnecté : ses conversations sont retirées du CRM (relues à la reconnexion). Compte rattaché à une autre
-- fiche (fusion de fiches, nouveau rattachement) : ses conversations suivent.
create or replace function public.tg_lemlist_accounts_conversations()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'disconnected' and old.status <> 'disconnected' then
    delete from public.lemlist_conversations where account_id = new.id;
  elsif new.company_id <> old.company_id then
    update public.lemlist_conversations set company_id = new.company_id where account_id = new.id;
  end if;
  return null;
end;
$$;
create trigger lemlist_accounts_conversations after update of status, company_id on public.lemlist_accounts
  for each row execute function public.tg_lemlist_accounts_conversations();

-- ---------------------------------------------------------------------------
-- Fonctions (droits de l'appelant)
-- ---------------------------------------------------------------------------

-- Enregistre la liste lue chez lemlist pour UN compte connecté. p_rows : [{lemlist_id, contact_id, contact_name,
-- contact_email, channels, last_channel, sender_user_id, last_activity_at, last_reply_at, has_replies, unread}].
-- Les conversations absentes de la lecture sont gardées (la lecture ne remonte que les plus récentes).
create or replace function public.lemlist_conversations_sync(p_account uuid, p_rows jsonb)
returns integer
language plpgsql
as $$
declare v_company uuid; v_n integer;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('lemlist');
  select company_id into v_company from public.lemlist_accounts where id = p_account and status = 'connected';
  if v_company is null then raise exception 'Compte lemlist introuvable ou pas connecté.' using errcode = 'P0001'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Liste attendue.' using errcode = '22023'; end if;
  insert into public.lemlist_conversations as c (account_id, company_id, lemlist_id, contact_id, contact_name, contact_email, channels,
    last_channel, sender_user_id, last_activity_at, last_reply_at, has_replies, lemlist_unread, synced_at)
  select p_account, v_company, r ->> 'lemlist_id', r ->> 'contact_id', left(nullif(r ->> 'contact_name', ''), 300), left(nullif(r ->> 'contact_email', ''), 320),
         coalesce(array(select ch.x from jsonb_array_elements_text(case when jsonb_typeof(r -> 'channels') = 'array' then r -> 'channels' else '[]'::jsonb end) as ch(x) where ch.x in ('email', 'linkedin')), '{}'),
         case when r ->> 'last_channel' in ('email', 'linkedin') then r ->> 'last_channel' end,
         left(nullif(r ->> 'sender_user_id', ''), 100), (r ->> 'last_activity_at')::timestamptz, nullif(r ->> 'last_reply_at', '')::timestamptz,
         coalesce((r ->> 'has_replies')::boolean, false), coalesce((r ->> 'unread')::boolean, false), now()
    from jsonb_array_elements(p_rows) r
   where coalesce(r ->> 'lemlist_id', '') <> '' and coalesce(r ->> 'contact_id', '') <> '' and r ->> 'last_activity_at' is not null
  on conflict (account_id, lemlist_id) do update set
    contact_id = excluded.contact_id, contact_name = excluded.contact_name, contact_email = excluded.contact_email,
    channels = excluded.channels, last_channel = excluded.last_channel, sender_user_id = excluded.sender_user_id,
    last_activity_at = excluded.last_activity_at, last_reply_at = excluded.last_reply_at, has_replies = excluded.has_replies,
    lemlist_unread = excluded.lemlist_unread, synced_at = now();
  get diagnostics v_n = row_count;
  update public.lemlist_accounts set last_synced_at = now() where id = p_account;
  return v_n;
end;
$$;

-- Liste affichée dans Messages (toutes les conversations des comptes visibles et non déconnectés).
create or replace function public.lemlist_inbox(p_limit integer default 500)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'conversations', coalesce((select jsonb_agg(row_to_json(x) order by x.last_activity_at desc) from (
      select c.id, c.account_id, c.company_id, co.name as company_name, c.contact_name, c.contact_email, c.channels, c.last_channel,
             c.last_activity_at, c.last_reply_at, c.has_replies,
             (c.lemlist_unread and (c.seen_at is null or c.seen_at < c.last_activity_at)) as unread
        from public.lemlist_conversations c
        join public.lemlist_accounts a on a.id = c.account_id and a.status <> 'disconnected'
        join public.companies co on co.id = c.company_id
       order by c.last_activity_at desc
       limit least(greatest(coalesce(p_limit, 500), 1), 2000)) x), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'company_id', a.company_id, 'company_name', co.name,
        'team_name', a.team_name, 'status', a.status, 'last_synced_at', a.last_synced_at, 'last_error', a.last_error) order by co.name)
      from public.lemlist_accounts a join public.companies co on co.id = a.company_id where a.status <> 'disconnected'), '[]'::jsonb)
  );
$$;

-- Ouverture du fil dans le CRM : la conversation n'est plus « non lue » ici (rien n'est changé chez lemlist).
create or replace function public.lemlist_conversation_seen(p_id uuid)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('lemlist');
  update public.lemlist_conversations set seen_at = now() where id = p_id;
  if not found then raise exception 'Conversation introuvable.' using errcode = 'P0001'; end if;
end;
$$;

-- Conversation et son compte, retrouvés par le serveur à partir de l'identifiant CRM de la conversation.
create or replace function public.lemlist_conversation_get(p_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object('id', c.id, 'account_id', c.account_id, 'company_id', c.company_id, 'company_name', co.name,
    'team_name', a.team_name, 'account_status', a.status, 'contact_id', c.contact_id, 'contact_name', c.contact_name,
    'contact_email', c.contact_email, 'channels', c.channels, 'last_channel', c.last_channel, 'sender_user_id', c.sender_user_id,
    'last_activity_at', c.last_activity_at)
    from public.lemlist_conversations c
    join public.lemlist_accounts a on a.id = c.account_id and a.status <> 'disconnected'
    join public.companies co on co.id = c.company_id
   where c.id = p_id;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.lemlist_conversations_sync(uuid, jsonb)',
    'public.lemlist_inbox(integer)', 'public.lemlist_conversation_seen(uuid)', 'public.lemlist_conversation_get(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
