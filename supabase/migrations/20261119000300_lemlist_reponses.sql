-- Messages lemlist, lot M3 : réponses envoyées depuis le CRM (email et LinkedIn).
-- Additive : une table et deux fonctions. Seul l'état de chaque envoi est gardé (anti-doublon, résultat) :
-- jamais le texte de la réponse, qui reste chez lemlist comme le reste du fil.
--  * Une clé d'idempotence par tentative (créée par le navigateur) : un double clic ou un renvoi de la même
--    requête ne part qu'une fois. La clé est liée à UNE conversation.
--  * États : sending → sent | failed (certain : rien n'est parti) | uncertain (lemlist n'a pas répondu : à vérifier
--    dans le fil avant de renvoyer). Un échec certain se retente avec une nouvelle clé.
--  * Le compte utilisé est celui de la conversation, retrouvé en base : jamais un identifiant venu du navigateur.

create table public.lemlist_replies (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.lemlist_conversations (id) on delete cascade,
  account_id uuid not null references public.lemlist_accounts (id) on delete cascade,
  company_id uuid not null references public.companies (id) on delete cascade,
  channel text not null check (channel in ('email', 'linkedin')),
  dedupe_key text not null unique check (char_length(dedupe_key) between 8 and 100),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed', 'uncertain')),
  error text check (error is null or char_length(error) <= 300),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index lemlist_replies_conversation_idx on public.lemlist_replies (conversation_id, created_at desc);

alter table public.lemlist_replies enable row level security;
create policy owner_all on public.lemlist_replies for all to authenticated
  using ((select public.is_app_owner()) and public.current_actor() = 'user')
  with check ((select public.is_app_owner()) and public.current_actor() = 'user');
revoke all on public.lemlist_replies from anon;
select trash_private.hide('lemlist_replies', array['company_id:companies']);

-- Réserve un envoi. Clé déjà utilisée pour cette conversation : renvoie l'envoi existant (duplicate = true),
-- rien ne repart. Clé utilisée pour une autre conversation : refus.
create or replace function public.lemlist_reply_claim(p_conversation uuid, p_channel text, p_key text)
returns jsonb
language plpgsql
as $$
declare c record; r public.lemlist_replies;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Réponse lemlist');
  if p_channel not in ('email', 'linkedin') then raise exception 'Canal inconnu.' using errcode = '22023'; end if;
  if coalesce(char_length(p_key), 0) not between 8 and 100 then raise exception 'Clé d''envoi invalide.' using errcode = '22023'; end if;
  select r2.* into r from public.lemlist_replies r2 where r2.dedupe_key = p_key;
  if found then
    if r.conversation_id <> p_conversation then raise exception 'Clé d''envoi déjà utilisée ailleurs.' using errcode = 'P0001'; end if;
    return jsonb_build_object('id', r.id, 'status', r.status, 'error', r.error, 'duplicate', true);
  end if;
  select lc.id, lc.account_id, lc.company_id, lc.channels, a.status as account_status into c
    from public.lemlist_conversations lc join public.lemlist_accounts a on a.id = lc.account_id
   where lc.id = p_conversation;
  if c.id is null then raise exception 'Conversation introuvable.' using errcode = 'P0001'; end if;
  if c.account_status <> 'connected' then raise exception 'Compte lemlist à reconnecter : la réponse n''est pas partie.' using errcode = 'P0001'; end if;
  if not (p_channel = any (c.channels)) then raise exception 'Cette conversation n''a pas lieu sur ce canal.' using errcode = 'P0001'; end if;
  insert into public.lemlist_replies (conversation_id, account_id, company_id, channel, dedupe_key)
  values (c.id, c.account_id, c.company_id, p_channel, p_key)
  on conflict (dedupe_key) do nothing
  returning * into r;
  if r.id is null then
    -- deux requêtes simultanées avec la même clé : la seconde voit l'envoi de la première
    select r2.* into r from public.lemlist_replies r2 where r2.dedupe_key = p_key;
    return jsonb_build_object('id', r.id, 'status', r.status, 'error', r.error, 'duplicate', true);
  end if;
  return jsonb_build_object('id', r.id, 'status', r.status, 'error', null, 'duplicate', false);
end;
$$;

-- Résultat d'un envoi réservé (une seule fois : un envoi terminé ne change plus d'état).
create or replace function public.lemlist_reply_finish(p_id uuid, p_status text, p_error text)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Réponse lemlist');
  if p_status not in ('sent', 'failed', 'uncertain') then raise exception 'État inconnu.' using errcode = '22023'; end if;
  update public.lemlist_replies set status = p_status, error = left(p_error, 300), finished_at = now()
   where id = p_id and status = 'sending';
  if not found then raise exception 'Envoi introuvable ou déjà terminé.' using errcode = 'P0001'; end if;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public.lemlist_reply_claim(uuid, text, text)', 'public.lemlist_reply_finish(uuid, text, text)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
