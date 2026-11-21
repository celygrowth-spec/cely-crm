-- Mail, lot M02 — lecture de la boîte : liste des fils d'un dossier, par pages.
-- Migration additive : une fonction de lecture exécutée avec les droits de l'appelant (les politiques d'accès de
-- mailbox_threads s'appliquent : propriétaire dans l'application uniquement).

-- p_label : identifiant de libellé Gmail (INBOX, SENT, SPAM, Label_…), ou 'ALL' pour « Tous les messages » (hors
-- Spam et Corbeille, comme dans Gmail). Pagination par repère (date, identifiant du dernier fil reçu) : stable même
-- si des messages arrivent entre deux pages.
create or replace function public.mailbox_list_threads(p_label text default 'INBOX', p_before timestamptz default null, p_before_id text default null, p_limit int default 50)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.last_at desc, x.thread_id desc), '[]'::jsonb)
    from (
      select t.thread_id, t.last_at, t.subject, t.snippet, t.participants, t.message_count, t.label_ids, t.unread, t.starred,
             t.important, t.has_attachments
        from public.mailbox_threads t
       where t.account_id = (select a.id from public.mail_accounts a where a.status <> 'disconnected'
                              order by a.is_default desc, a.connected_at desc limit 1)
         and case when p_label = 'ALL'
                  then exists (select 1 from public.mailbox_messages m
                                where m.account_id = t.account_id and m.thread_id = t.thread_id
                                  and not (m.label_ids && array['SPAM', 'TRASH']))
                  else t.label_ids @> array[p_label] end
         and (p_before is null or (t.last_at, t.thread_id) < (p_before, coalesce(p_before_id, '')))
       order by t.last_at desc, t.thread_id desc
       limit least(greatest(coalesce(p_limit, 50), 1), 100)
    ) x;
$$;
revoke execute on function public.mailbox_list_threads(text, timestamptz, text, int) from public, anon;
grant execute on function public.mailbox_list_threads(text, timestamptz, text, int) to authenticated;
