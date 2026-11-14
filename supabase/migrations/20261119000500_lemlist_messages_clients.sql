-- Messages lemlist : entrée par client. Additive : deux fonctions de lecture, rien d'autre (aucune table modifiée).
--  * lemlist_clients : une ligne par client ayant un compte lemlist non déconnecté (Connecté ou À reconnecter), avec
--    son nombre de conversations non lues (MÊME règle que lemlist_counts et la liste : la somme des pastilles est égale
--    au compteur de la navigation) et la date de sa réponse la plus récente.
--  * lemlist_company_inbox : la liste et les comptes de Messages, limités à un client.
--  * Propriétaire uniquement (RLS des tables lues), ni portail ni Claude. Fonctions security invoker.

create or replace function public.lemlist_clients()
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'company_id', x.company_id, 'company_name', x.company_name, 'status', x.status,
      'unread', x.unread, 'last_reply_at', x.last_reply_at, 'last_activity_at', x.last_activity_at)
    order by (x.unread > 0) desc, x.last_reply_at desc nulls last, x.last_activity_at desc nulls last, x.company_name), '[]'::jsonb)
    from (
      select co.id as company_id, co.name as company_name,
             case when bool_and(a.status = 'connected') then 'connected' else 'needs_reconnect' end as status,
             coalesce((select count(*) from public.lemlist_conversations c
                        join public.lemlist_accounts ca on ca.id = c.account_id and ca.status <> 'disconnected'
                       where c.company_id = co.id and c.lemlist_unread and (c.seen_at is null or c.seen_at < c.last_activity_at)), 0)::int as unread,
             (select max(c.last_reply_at) from public.lemlist_conversations c
                join public.lemlist_accounts ca on ca.id = c.account_id and ca.status <> 'disconnected'
               where c.company_id = co.id) as last_reply_at,
             (select max(c.last_activity_at) from public.lemlist_conversations c
                join public.lemlist_accounts ca on ca.id = c.account_id and ca.status <> 'disconnected'
               where c.company_id = co.id) as last_activity_at
        from public.lemlist_accounts a
        join public.companies co on co.id = a.company_id
       where a.status <> 'disconnected' and public.current_actor() = 'user'
       group by co.id, co.name
    ) x;
$$;

create or replace function public.lemlist_company_inbox(p_company uuid, p_limit integer default 500)
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
       where c.company_id = p_company
       order by c.last_activity_at desc
       limit least(greatest(coalesce(p_limit, 500), 1), 2000)) x), '[]'::jsonb),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'company_id', a.company_id, 'company_name', co.name,
        'team_name', a.team_name, 'status', a.status, 'last_synced_at', a.last_synced_at, 'last_error', a.last_error) order by a.team_name)
      from public.lemlist_accounts a join public.companies co on co.id = a.company_id
     where a.status <> 'disconnected' and a.company_id = p_company), '[]'::jsonb)
  );
$$;

do $$
declare f text;
begin
  foreach f in array array['public.lemlist_clients()', 'public.lemlist_company_inbox(uuid, integer)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
