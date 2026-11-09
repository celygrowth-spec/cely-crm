-- Mail — brouillons fiables (phase 1 du composeur). Migration additive : une colonne, une fonction redéfinie.
-- * draft_version : numéro incrémenté à chaque enregistrement d'un brouillon. Le composeur envoie la version
--   qu'il a lue ; si le brouillon a été enregistré entre-temps ailleurs (autre onglet, autre appareil), rien
--   n'est écrasé : la fonction renvoie le conflit et la version actuelle, et l'interface propose de choisir.
-- * le contenu mis en forme (body_html) est enregistré avec le brouillon, à côté de sa version texte.

alter table public.mail_messages add column draft_version integer not null default 0;

drop function public.mail_save_draft(uuid, jsonb);

-- p : {account_id, company_id, person_id, to, cc, bcc, subject, body (texte), html, signature, file_ids,
--      in_reply_to, references, thread_id}
-- p_expected_version : version lue par le composeur (null : premier enregistrement ou écrasement voulu).
create or replace function public.mail_save_draft(p_id uuid, p jsonb, p_expected_version integer default null)
returns jsonb
language plpgsql
as $$
declare
  v public.mail_messages;
  v_company uuid := nullif(p ->> 'company_id', '')::uuid;
  arr text[];
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Brouillon d''email');
  select * into v from public.mail_messages where id = p_id for update;
  if v.id is not null and v.status <> 'draft' then
    raise exception 'Ce message n''est plus un brouillon.' using errcode = 'P0001';
  end if;
  if v.id is not null and p_expected_version is not null and v.draft_version <> p_expected_version then
    return jsonb_build_object('conflict', true, 'current', public.mail_row(p_id));
  end if;
  insert into public.mail_messages (id, account_id, company_id, person_id, to_addrs, cc_addrs, bcc_addrs, subject, body_text, body_html,
                                    signature, in_reply_to, references_hdr, provider_thread_id, draft_version)
  values (p_id,
    nullif(p ->> 'account_id', '')::uuid, v_company, nullif(p ->> 'person_id', '')::uuid,
    array(select jsonb_array_elements_text(coalesce(p -> 'to', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'cc', '[]'))),
    array(select jsonb_array_elements_text(coalesce(p -> 'bcc', '[]'))),
    coalesce(p ->> 'subject', ''), coalesce(p ->> 'body', ''), nullif(p ->> 'html', ''), coalesce(p ->> 'signature', ''),
    p ->> 'in_reply_to', p ->> 'references', p ->> 'thread_id', 1)
  on conflict (id) do update set
    account_id = excluded.account_id, person_id = excluded.person_id, to_addrs = excluded.to_addrs,
    cc_addrs = excluded.cc_addrs, bcc_addrs = excluded.bcc_addrs, subject = excluded.subject,
    body_text = excluded.body_text, body_html = excluded.body_html, signature = excluded.signature,
    draft_version = public.mail_messages.draft_version + 1;
  if p ? 'file_ids' then
    select array(select jsonb_array_elements_text(p -> 'file_ids')) into arr;
    perform public.mail_replace_attachments(p_id, v_company, arr::uuid[]);
  end if;
  return public.mail_row(p_id) || jsonb_build_object('conflict', false);
end;
$$;

revoke execute on function public.mail_save_draft(uuid, jsonb, integer) from public, anon;
grant execute on function public.mail_save_draft(uuid, jsonb, integer) to authenticated;
