-- Mail, phase 4 : envoi fiable depuis la fiche.
--  * le contenu réellement envoyé (variables résolues) est figé au moment de l'envoi ; la version
--    modifiable (avec ses variables) est gardée à part et rendue si l'envoi échoue ;
--  * « Ne plus contacter » bloque l'envoi, pour la fiche comme pour toute adresse d'une fiche marquée ;
--  * chaque envoi porte notre propre Message-ID, pour répondre dans le même fil ;
--  * l'entrée d'historique décrit l'email (objet, expéditeur, destinataires, aperçu, pièces jointes).
-- Additif : aucune donnée existante n'est modifiée.

alter table public.mail_messages
  add column if not exists rfc_message_id text check (rfc_message_id is null or char_length(rfc_message_id) <= 300),
  add column if not exists draft_snapshot jsonb;

comment on column public.mail_messages.rfc_message_id is 'En-tête Message-ID de l''email envoyé (pour In-Reply-To / References des réponses).';
comment on column public.mail_messages.draft_snapshot is 'Brouillon avant résolution des variables ; rendu si l''envoi échoue.';

-- ---------------------------------------------------------------------------
-- Prise en charge de l'envoi
-- ---------------------------------------------------------------------------

drop function if exists public.mail_claim(uuid);

-- p_final (facultatif) : { subject, html, text, version } calculés côté serveur avec les variables résolues.
-- `version` doit être la version du brouillon lue pour ce calcul : si l'utilisateur a modifié le
-- brouillon entre-temps, rien n'est envoyé.
create or replace function public.mail_claim(p_id uuid, p_final jsonb default null)
returns jsonb
language plpgsql
as $$
declare
  v public.mail_messages;
  v_account public.mail_accounts;
  v_blocked text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Envoi d''email');
  select * into v from public.mail_messages where id = p_id for update;
  if not found then raise exception 'Message introuvable.' using errcode = 'P0001'; end if;
  if v.status not in ('draft', 'pending') then
    return jsonb_build_object('claimed', false, 'status', v.status, 'message', public.mail_row(p_id));
  end if;
  if v.account_id is null then
    select * into v_account from public.mail_accounts where is_default;
  else
    select * into v_account from public.mail_accounts where id = v.account_id;
  end if;
  if v_account.id is null or v_account.status <> 'connected' then
    raise exception 'Aucun compte Gmail connecté pour envoyer ce message.' using errcode = 'P0001';
  end if;
  if coalesce(array_length(v.to_addrs, 1), 0) = 0 then
    raise exception 'Indiquez au moins un destinataire.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.mail_attachments a where a.mail_id = p_id and a.file_id is null) then
    raise exception 'Une pièce jointe n''existe plus sur la fiche : retirez-la avant d''envoyer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.mail_attachments a join public.company_files f on f.id = a.file_id
              where a.mail_id = p_id and f.status <> 'ready') then
    raise exception 'Une pièce jointe n''est pas encore disponible : attendez la fin du transfert.' using errcode = 'P0001';
  end if;

  -- « Ne plus contacter » : la fiche du message, et toute fiche marquée dont une personne est destinataire.
  -- Envois automatiques : toujours bloqués. Email écrit à la main : comme à l'ouverture du composeur,
  -- seulement après une confirmation explicite donnée au moment d'envoyer (p_final.allow_dnc).
  select string_agg(distinct x, ', ') into v_blocked from (
    select c.name as x from public.companies c where c.id = v.company_id and c.do_not_contact
    union all
    select p.email from public.people p join public.companies c on c.id = p.company_id
     where c.do_not_contact and p.email is not null
       and lower(p.email) in (select lower(a) from unnest(v.to_addrs || v.cc_addrs || v.bcc_addrs) a)) b;
  if v_blocked is not null and not (v.origin = 'manual' and coalesce((p_final ->> 'allow_dnc')::boolean, false)) then
    raise exception 'Marqué « Ne plus contacter » : %. Rien n''a été envoyé.', v_blocked using errcode = 'P0001';
  end if;

  if p_final is not null then
    if (p_final ->> 'version')::int is distinct from v.draft_version then
      raise exception 'Le brouillon vient d''être modifié : relisez-le puis envoyez de nouveau.' using errcode = 'P0001';
    end if;
    if btrim(coalesce(p_final ->> 'subject', '')) = '' then
      raise exception 'Indiquez un objet.' using errcode = 'P0001';
    end if;
    if btrim(coalesce(p_final ->> 'text', '')) = '' then
      raise exception 'Le message est vide.' using errcode = 'P0001';
    end if;
    update public.mail_messages
       set draft_snapshot = jsonb_build_object('subject', v.subject, 'body_html', v.body_html, 'body_text', v.body_text),
           subject = left(p_final ->> 'subject', 500),
           body_html = p_final ->> 'html',
           body_text = p_final ->> 'text'
     where id = p_id;
  end if;

  update public.mail_messages
     set status = 'sending', account_id = v_account.id, claimed_at = now(), attempts = attempts + 1, error_code = null, last_error = null,
         rfc_message_id = '<cely.' || replace(gen_random_uuid()::text, '-', '') || '@' || split_part(v_account.email, '@', 2) || '>'
   where id = p_id;
  return jsonb_build_object(
    'claimed', true,
    'message', public.mail_row(p_id),
    'account', jsonb_build_object('id', v_account.id, 'email', v_account.email, 'display_name', v_account.display_name),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object('name', a.name, 'mime_type', f.mime_type, 'size_bytes', f.size_bytes, 'storage_path', f.storage_path) order by a.position)
        from public.mail_attachments a join public.company_files f on f.id = a.file_id
       where a.mail_id = p_id and f.status = 'ready'), '[]'::jsonb),
    'attachment_count', (select count(*) from public.mail_attachments a where a.mail_id = p_id));
end;
$$;

revoke execute on function public.mail_claim(uuid, jsonb) from public, anon;
grant execute on function public.mail_claim(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Échec : le brouillon redevient modifiable tel que l'utilisateur l'avait écrit (variables comprises)
-- ---------------------------------------------------------------------------

create or replace function public.mail_reopen(p_id uuid)
returns jsonb
language plpgsql
as $$
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Reprise d''email');
  update public.mail_messages
     set status = 'draft', error_code = null, last_error = null, claimed_at = null, dedupe_key = null,
         subject = coalesce(draft_snapshot ->> 'subject', subject),
         body_html = case when draft_snapshot is null then body_html else draft_snapshot ->> 'body_html' end,
         body_text = coalesce(draft_snapshot ->> 'body_text', body_text),
         draft_snapshot = null
   where id = p_id and status = 'failed';
  if not found then raise exception 'Seul un envoi en échec peut être repris.' using errcode = 'P0001'; end if;
  return public.mail_row(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Historique : une entrée par email accepté, décrite précisément
-- ---------------------------------------------------------------------------

create or replace function public.mail_log_interaction(p_id uuid)
returns void
language plpgsql
as $$
declare
  v public.mail_messages;
  v_from text;
  v_interaction uuid;
begin
  select * into v from public.mail_messages where id = p_id;
  if v.company_id is null or v.interaction_id is not null then return; end if;
  select email into v_from from public.mail_accounts where id = v.account_id;
  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source, meta)
  values (v.company_id, v.person_id, 'message_out', 'email', coalesce(v.sent_at, now()),
          left(case when v.subject = '' then v.body_text else 'Objet : ' || v.subject || E'\n\n' || v.body_text end, 20000),
          'user', case when v.origin = 'manual' then 'user' else 'system' end,
          jsonb_build_object(
            'mail_id', v.id, 'mail_origin', v.origin,
            'subject', v.subject, 'from', v_from, 'to', v.to_addrs, 'cc', v.cc_addrs,
            'preview', left(regexp_replace(v.body_text, '\s+', ' ', 'g'), 240),
            'attachments', (select count(*) from public.mail_attachments a where a.mail_id = v.id),
            'attachment_names', coalesce((select jsonb_agg(a.name order by a.position) from public.mail_attachments a where a.mail_id = v.id), '[]'::jsonb)))
  returning id into v_interaction;
  update public.mail_messages set interaction_id = v_interaction where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contexte des variables au moment d'envoyer : le message, sa fiche, et le contact de référence
-- (celui choisi ; à défaut, l'unique destinataire s'il est une personne de la fiche ; jamais deviné
-- parmi plusieurs destinataires, ni en formule collective).
-- ---------------------------------------------------------------------------

create or replace function public.mail_send_context(p_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'message', public.mail_row(m.id),
    'company', (select jsonb_build_object('name', c.name, 'website', c.website) from public.companies c where c.id = m.company_id),
    'person', (
      select jsonb_build_object('first_name', p.first_name, 'last_name', p.last_name, 'title', p.title)
        from public.people p
       where not m.collective
         and (p.id = m.person_id
              or (m.person_id is null and p.company_id = m.company_id and cardinality(m.to_addrs) = 1
                  and lower(p.email) = lower(m.to_addrs[1])))
       order by (p.id = m.person_id) desc
       limit 1))
    from public.mail_messages m where m.id = p_id;
$$;

revoke execute on function public.mail_send_context(uuid) from public, anon;
grant execute on function public.mail_send_context(uuid) to authenticated;
