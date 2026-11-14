-- Messages lemlist, lot M4 : compteurs pour la navigation et Aujourd'hui. Additive : une fonction, rien d'autre.
--  * unread : conversations non lues (même règle que la liste de Messages).
--  * awaiting : conversations dont le dernier événement est une réponse du contact, sans réponse partie du CRM depuis.
--  * Comptes visibles et non déconnectés seulement ; propriétaire uniquement (ni portail, ni Claude).

create or replace function public.lemlist_counts()
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'unread', count(*) filter (where c.lemlist_unread and (c.seen_at is null or c.seen_at < c.last_activity_at)),
    'awaiting', count(*) filter (where c.last_reply_at is not null
      and c.last_reply_at >= c.last_activity_at - interval '1 minute'
      and not exists (select 1 from public.lemlist_replies r
                       where r.conversation_id = c.id and r.status = 'sent' and r.finished_at > c.last_reply_at))
  )
    from public.lemlist_conversations c
    join public.lemlist_accounts a on a.id = c.account_id and a.status <> 'disconnected'
   where public.current_actor() = 'user';
$$;

revoke execute on function public.lemlist_counts() from public, anon;
grant execute on function public.lemlist_counts() to authenticated;
