-- Mail, lot M03 — tri : après une action acceptée par Gmail, l'index reprend aussitôt les libellés que Gmail a
-- renvoyés pour chaque message du fil (sans attendre le passage de synchronisation suivant, qui les confirmera).
-- Migration additive : une fonction à clé serveur.

-- p_messages = [{id, label_ids[]}] : seuls les libellés changent ; un message inconnu de l'index est ignoré (il
-- arrivera par la synchronisation). Les repères de synchronisation ne sont pas touchés.
create or replace function public.mailbox_set_labels(p_server_key text, p_account uuid, p_messages jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_threads text[]; v_n int;
begin
  perform appt_private.assert_server(p_server_key);
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) > 2000 then
    raise exception 'Lot invalide.' using errcode = 'P0001';
  end if;
  with rows as (
    update public.mailbox_messages m
       set label_ids = coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(u -> 'label_ids') = 'array' then u -> 'label_ids' else '[]'::jsonb end) x), '{}'),
           updated_at = now()
      from jsonb_array_elements(p_messages) u
     where m.account_id = p_account and m.message_id = u ->> 'id'
    returning m.thread_id
  )
  select count(*)::int, coalesce(array_agg(distinct thread_id), '{}') into v_n, v_threads from rows;
  perform mailbox_private.refresh_threads(p_account, v_threads);
  return v_n;
end;
$$;
revoke execute on function public.mailbox_set_labels(text, uuid, jsonb) from public;
grant execute on function public.mailbox_set_labels(text, uuid, jsonb) to anon, authenticated;
