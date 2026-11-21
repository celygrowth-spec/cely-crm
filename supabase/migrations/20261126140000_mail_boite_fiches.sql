-- Mail, lot M05 — lien entre la boîte et les fiches.
-- Migration additive : une lecture (fiches correspondant aux adresses d'un fil) et une écriture à clé serveur
-- (trace d'un message envoyé depuis la boîte dans l'historique de la fiche, sans doublon).

-- Fiches dont une personne a l'une de ces adresses. Exécutée avec les droits de l'appelant : les politiques
-- d'accès des fiches s'appliquent (propriétaire ; les fiches à la corbeille ou fusionnées n'apparaissent pas).
create or replace function public.mailbox_crm_context(p_emails text[])
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(x.row order by x.company_name, x.person_name), '[]'::jsonb)
    from (
      select c.name as company_name, btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) as person_name,
             jsonb_build_object(
               'email', p.email_norm,
               'person', jsonb_build_object('id', p.id, 'name', nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'title', p.title),
               'company', jsonb_build_object('id', c.id, 'name', c.name, 'prospect_status', c.prospect_status, 'deal_status', c.deal_status),
               'pipeline', (select pl.name from public.pipelines pl where pl.id = c.pipeline_id),
               'stage', (select s.name from public.stages s where s.id = c.stage_id),
               'next_action', (select jsonb_build_object('title', t.title, 'due_date', t.due_date)
                                 from public.tasks t where t.company_id = c.id and t.done_at is null
                                order by t.due_date, t.created_at limit 1)
             ) as row
        from public.people p
        join public.companies c on c.id = p.company_id
       where c.merged_into_id is null
         and p.email_norm = any (select lower(btrim(e)) from unnest(p_emails[1:50]) e where btrim(e) <> '')
       limit 20
    ) x;
$$;
revoke execute on function public.mailbox_crm_context(text[]) from public, anon;
grant execute on function public.mailbox_crm_context(text[]) to authenticated;

-- Message envoyé depuis la boîte : s'il s'adresse aux personnes d'UNE seule fiche, il entre dans son historique
-- (même forme qu'un email envoyé depuis la fiche). Aucune fiche : rien n'est conservé. Plusieurs fiches : rien
-- n'est rattaché d'office. Un message déjà connu (même identifiant Gmail ou même clé) n'est jamais enregistré deux fois.
-- p : {provider_message_id, provider_thread_id, rfc_message_id, to[], cc[], subject, text}
create or replace function public.mailbox_record_sent(p_server_key text, p_account uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gmail text := p ->> 'provider_message_id';
  v_key text;
  v_to text[];
  v_cc text[];
  v_companies int; v_company uuid; v_person uuid; v_inter uuid; v_id uuid;
begin
  perform appt_private.assert_server(p_server_key);
  if coalesce(v_gmail, '') = '' then raise exception 'Message invalide.' using errcode = 'P0001'; end if;
  v_key := 'boite:' || v_gmail;
  if exists (select 1 from public.mail_messages where dedupe_key = v_key or (account_id = p_account and provider_message_id = v_gmail)) then
    return jsonb_build_object('recorded', false, 'reason', 'duplicate');
  end if;
  v_to := array(select lower(btrim(x)) from jsonb_array_elements_text(case when jsonb_typeof(p -> 'to') = 'array' then p -> 'to' else '[]'::jsonb end) x);
  v_cc := array(select lower(btrim(x)) from jsonb_array_elements_text(case when jsonb_typeof(p -> 'cc') = 'array' then p -> 'cc' else '[]'::jsonb end) x);
  select count(distinct pe.company_id), min(pe.company_id::text)::uuid into v_companies, v_company
    from public.people pe join public.companies c on c.id = pe.company_id
   where c.merged_into_id is null and pe.email_norm = any (v_to || v_cc);
  if v_companies = 0 then return jsonb_build_object('recorded', false, 'reason', 'no_record'); end if;
  if v_companies > 1 then return jsonb_build_object('recorded', false, 'reason', 'several_records'); end if;
  -- la personne : un destinataire direct de préférence
  select pe.id into v_person from public.people pe
   where pe.company_id = v_company and pe.email_norm = any (v_to || v_cc)
   order by (pe.email_norm = any (v_to)) desc, pe.is_primary desc, pe.created_at limit 1;

  insert into public.interactions (company_id, person_id, kind, channel, content, content_origin, source, meta)
  values (v_company, v_person, 'message_out', 'email',
          left(coalesce(nullif(btrim(p ->> 'subject'), ''), '(sans objet)') || E'\n\n' || coalesce(p ->> 'text', ''), 20000),
          'system', 'system', jsonb_build_object('gmail_message_id', v_gmail, 'thread_id', p ->> 'provider_thread_id', 'from', 'boite'))
  returning id into v_inter;
  -- même cycle de vie qu'un envoi depuis le CRM : en attente, en cours, puis accepté par Gmail
  insert into public.mail_messages (account_id, status, origin, company_id, person_id, to_addrs, cc_addrs, subject, body_text, dedupe_key,
                                    rfc_message_id, attempts, interaction_id)
  values (p_account, 'pending', 'manual', v_company, v_person, v_to, v_cc, left(coalesce(p ->> 'subject', ''), 500),
          left(coalesce(p ->> 'text', ''), 200000), v_key, nullif(p ->> 'rfc_message_id', ''), 1, v_inter)
  returning id into v_id;
  update public.mail_messages set status = 'sending', claimed_at = now() where id = v_id;
  update public.mail_messages set status = 'accepted', provider_message_id = v_gmail, provider_thread_id = p ->> 'provider_thread_id', sent_at = now() where id = v_id;
  return jsonb_build_object('recorded', true, 'company_id', v_company, 'person_id', v_person);
end;
$$;
revoke execute on function public.mailbox_record_sent(text, uuid, jsonb) from public;
grant execute on function public.mailbox_record_sent(text, uuid, jsonb) to anon, authenticated;
