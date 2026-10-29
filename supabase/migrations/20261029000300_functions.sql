-- Logique métier transactionnelle. Toutes les fonctions sont « security invoker » :
-- elles s'exécutent avec les droits de l'appelant, donc sous RLS.
-- L'interface (server actions) et le connecteur Claude appellent les mêmes fonctions.

-- ---------------------------------------------------------------------------
-- Utilitaires
-- ---------------------------------------------------------------------------

create or replace function public.lock_keys(p_keys text[])
returns void
language plpgsql
as $$
declare k text;
begin
  -- verrous transactionnels triés pour éviter les interblocages : deux créations
  -- simultanées avec le même domaine / email sont sérialisées.
  for k in select distinct x from unnest(p_keys) x where x is not null order by 1
  loop
    perform pg_advisory_xact_lock(hashtextextended('crm:' || k, 0));
  end loop;
end;
$$;

create or replace function public.idem_get(p_key text)
returns jsonb
language plpgsql
as $$
declare v jsonb;
begin
  if p_key is null then return null; end if;
  perform public.lock_keys(array['idem:' || p_key]);
  select result into v from public.idempotency_keys where key = p_key;
  return v;
end;
$$;

create or replace function public.idem_put(p_key text, p_scope text, p_result jsonb)
returns jsonb
language plpgsql
as $$
begin
  if p_key is not null then
    insert into public.idempotency_keys (key, scope, result) values (p_key, p_scope, p_result)
    on conflict (key) do nothing;
  end if;
  return p_result;
end;
$$;

create or replace function public.log_event(
  p_company uuid, p_kind text, p_content text, p_meta jsonb default '{}', p_person uuid default null)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  insert into public.interactions (company_id, person_id, kind, content, content_origin, source, meta)
  values (p_company, p_person, p_kind, p_content, 'system',
          case when public.current_actor() = 'claude' then 'claude' else 'system' end, coalesce(p_meta, '{}'))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.assert_not_claude(p_action text)
returns void
language plpgsql
as $$
begin
  if public.current_actor() = 'claude' then
    raise exception '% : action réservée à l''application, impossible via Claude', p_action using errcode = '42501';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Détection des doublons
-- strength = 'exact' (correspondance forte) ou 'similar' (ressemblance à vérifier)
-- ---------------------------------------------------------------------------

create or replace function public.find_duplicates(
  p_name text,
  p_website text default null,
  p_emails text[] default '{}',
  p_linkedins text[] default '{}',
  p_person_names text[] default '{}',
  p_exclude uuid default null)
returns table (company_id uuid, name text, website text, archived boolean, strength text, reasons text[])
language plpgsql
stable
as $$
declare
  v_name text := public.norm_company_name(p_name);
  v_domain text := public.norm_domain(p_website);
  v_emails text[] := coalesce(array(select distinct public.norm_email(e) from unnest(p_emails) e where public.norm_email(e) is not null), '{}');
  v_email_domains text[];
  v_linkedins text[] := coalesce(array(select distinct public.norm_linkedin(l) from unnest(p_linkedins) l where public.norm_linkedin(l) is not null), '{}');
  v_pnames text[] := coalesce(array(select distinct x from unnest(p_person_names) x where coalesce(x, '') <> ''), '{}');
begin
  perform public.assert_owner();
  -- domaines d'email professionnels uniquement : Gmail, Outlook… ne rapprochent jamais.
  v_email_domains := coalesce(array(
    select distinct public.email_domain(e) from unnest(v_emails) e
     where public.email_domain(e) is not null and not public.is_free_email_domain(public.email_domain(e))), '{}');
  v_pnames := coalesce(array(select distinct public.norm_person_name(x, null) from unnest(v_pnames) x
                              where public.norm_person_name(x, null) is not null), '{}');

  return query
  with hits as (
    select c.id, 'exact'::text as s, 'Même domaine : ' || c.domain_norm as r
      from public.companies c
     where v_domain is not null and c.domain_norm = v_domain
    union all
    select c.id, 'exact', 'Domaine de l''email identique au site de l''entreprise : ' || c.domain_norm
      from public.companies c
     where c.domain_norm = any (v_email_domains)
    union all
    select p.company_id, 'exact', 'Domaine du site identique à l''email de ' || coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), p.email)
      from public.people p
     where v_domain is not null and not public.is_free_email_domain(v_domain)
       and public.email_domain(p.email_norm) = v_domain
    union all
    select p.company_id, 'exact', 'Même email : ' || p.email_norm
      from public.people p
     where p.email_norm = any (v_emails)
    union all
    select p.company_id, 'exact', 'Même profil LinkedIn : ' || p.linkedin_norm
      from public.people p
     where p.linkedin_norm = any (v_linkedins)
    union all
    select c.id, 'similar', 'Nom d''entreprise identique après normalisation'
      from public.companies c
     where v_name is not null and c.name_norm = v_name
    union all
    select c.id, 'similar', 'Nom d''entreprise proche (' || round(extensions.similarity(c.name_norm, v_name) * 100) || ' %)'
      from public.companies c
     where v_name is not null and c.name_norm <> v_name and char_length(v_name) >= 3
       and extensions.similarity(c.name_norm, v_name) >= 0.55
    union all
    select p.company_id, 'similar', 'Personne au nom identique : ' || btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,''))
      from public.people p
     where p.full_name_norm = any (v_pnames) and position(' ' in p.full_name_norm) > 0
  )
  select c.id, c.name, c.website, c.archived_at is not null,
         case when bool_or(h.s = 'exact') then 'exact' else 'similar' end,
         array_agg(distinct h.r)
    from hits h
    join public.companies c on c.id = h.id
   where c.merged_into_id is null
     and (p_exclude is null or c.id <> p_exclude)
   group by c.id, c.name, c.website, c.archived_at
   order by case when bool_or(h.s = 'exact') then 0 else 1 end, c.name
   limit 20;
end;
$$;

-- Toutes les paires de doublons potentiels de la base (vue « Doublons à vérifier »)
create or replace function public.list_duplicate_pairs()
returns table (company_a uuid, name_a text, company_b uuid, name_b text, strength text, reasons text[])
language plpgsql
stable
as $$
begin
  perform public.assert_owner();
  return query
  with active as (
    select * from public.companies where merged_into_id is null
  ), pairs as (
    select a.id as x, b.id as y, 'exact'::text as s, 'Même domaine : ' || a.domain_norm as r
      from active a join active b on a.domain_norm = b.domain_norm and a.id < b.id
    union all
    select least(pa.company_id, pb.company_id), greatest(pa.company_id, pb.company_id), 'exact', 'Même email : ' || pa.email_norm
      from public.people pa join public.people pb on pa.email_norm = pb.email_norm and pa.company_id <> pb.company_id
    union all
    select least(pa.company_id, pb.company_id), greatest(pa.company_id, pb.company_id), 'exact', 'Même profil LinkedIn : ' || pa.linkedin_norm
      from public.people pa join public.people pb on pa.linkedin_norm = pb.linkedin_norm and pa.company_id <> pb.company_id
    union all
    select least(c.id, p.company_id), greatest(c.id, p.company_id), 'exact', 'Email de ' || p.email_norm || ' sur le domaine ' || c.domain_norm
      from active c join public.people p
        on public.email_domain(p.email_norm) = c.domain_norm and p.company_id <> c.id
     where not public.is_free_email_domain(c.domain_norm)
    union all
    select a.id, b.id, 'similar',
           case when a.name_norm = b.name_norm then 'Nom d''entreprise identique après normalisation'
                else 'Nom d''entreprise proche (' || round(extensions.similarity(a.name_norm, b.name_norm) * 100) || ' %)' end
      from active a join active b on a.id < b.id
       and (a.name_norm = b.name_norm or (a.name_norm operator(extensions.%) b.name_norm
            and extensions.similarity(a.name_norm, b.name_norm) >= 0.55))
    union all
    select least(pa.company_id, pb.company_id), greatest(pa.company_id, pb.company_id), 'similar',
           'Personne au nom identique : ' || btrim(coalesce(pa.first_name,'') || ' ' || coalesce(pa.last_name,''))
      from public.people pa join public.people pb
        on pa.full_name_norm = pb.full_name_norm and pa.company_id <> pb.company_id
     where position(' ' in pa.full_name_norm) > 0
  )
  select p.x, ca.name, p.y, cb.name,
         case when bool_or(p.s = 'exact') then 'exact' else 'similar' end,
         array_agg(distinct p.r)
    from pairs p
    join active ca on ca.id = p.x
    join active cb on cb.id = p.y
   where not exists (select 1 from public.duplicate_dismissals d where d.company_a = p.x and d.company_b = p.y)
   group by p.x, ca.name, p.y, cb.name
   order by case when bool_or(p.s = 'exact') then 0 else 1 end, ca.name;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fiches : création et modification avec contrôle des doublons
-- p_company : {name, website, description, source_id, tags[]}
-- p_people  : [{first_name, last_name, title, email, phone, linkedin_url, is_primary}]
-- Retourne {status:'created', id} ou {status:'duplicates', candidates:[…]}
-- ---------------------------------------------------------------------------

create or replace function public.create_company(
  p_company jsonb,
  p_people jsonb default '[]',
  p_force boolean default false,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
  v_emails text[];
  v_linkedins text[];
  v_pnames text[];
  v_candidates jsonb;
  v_person jsonb;
  v_idx bigint;
  v_primary_idx bigint;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  if coalesce(btrim(p_company ->> 'name'), '') = '' then
    raise exception 'Le nom de l''entreprise est obligatoire' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_people, '[]')) <> 'array' then
    raise exception 'Format des personnes invalide' using errcode = '22023';
  end if;

  select coalesce(array_agg(x ->> 'email') filter (where coalesce(x ->> 'email', '') <> ''), '{}'),
         coalesce(array_agg(x ->> 'linkedin_url') filter (where coalesce(x ->> 'linkedin_url', '') <> ''), '{}'),
         coalesce(array_agg(btrim(coalesce(x ->> 'first_name', '') || ' ' || coalesce(x ->> 'last_name', ''))), '{}')
    into v_emails, v_linkedins, v_pnames
    from jsonb_array_elements(coalesce(p_people, '[]')) x;

  perform public.lock_keys(
    array['domain:' || public.norm_domain(p_company ->> 'website'),
          'name:' || public.norm_company_name(p_company ->> 'name')]
    || array(select 'email:' || public.norm_email(e) from unnest(v_emails) e)
    || array(select 'li:' || public.norm_linkedin(l) from unnest(v_linkedins) l));

  select coalesce(jsonb_agg(to_jsonb(d)), '[]') into v_candidates
    from public.find_duplicates(p_company ->> 'name', p_company ->> 'website', v_emails, v_linkedins, v_pnames) d;

  if jsonb_array_length(v_candidates) > 0 and not p_force then
    -- pas d'enregistrement de la clé : l'utilisateur peut confirmer ensuite
    return jsonb_build_object('status', 'duplicates', 'candidates', v_candidates);
  end if;

  insert into public.companies (name, website, description, source_id, tags)
  values (p_company ->> 'name',
          p_company ->> 'website',
          nullif(btrim(coalesce(p_company ->> 'description', '')), ''),
          nullif(p_company ->> 'source_id', '')::uuid,
          coalesce(array(select jsonb_array_elements_text(p_company -> 'tags')), '{}'))
  returning id into v_id;

  -- un seul contact principal : le premier marqué comme tel, sinon le premier saisi
  select coalesce(min(o) filter (where coalesce((x ->> 'is_primary')::boolean, false)), 1) into v_primary_idx
    from jsonb_array_elements(coalesce(p_people, '[]')) with ordinality as t(x, o);

  for v_person, v_idx in select x, o from jsonb_array_elements(coalesce(p_people, '[]')) with ordinality as t(x, o)
  loop
    insert into public.people (company_id, first_name, last_name, title, email, phone, linkedin_url, is_primary)
    values (v_id, v_person ->> 'first_name', v_person ->> 'last_name', v_person ->> 'title',
            v_person ->> 'email', v_person ->> 'phone', v_person ->> 'linkedin_url', v_idx = v_primary_idx);
  end loop;

  perform public.log_event(v_id, 'system', 'Fiche créée',
    case when jsonb_array_length(v_candidates) > 0
         then jsonb_build_object('created_despite_duplicates', v_candidates) else '{}'::jsonb end);

  return public.idem_put(p_idempotency_key, 'create_company', jsonb_build_object('status', 'created', 'id', v_id));
end;
$$;

-- Modification : seuls les champs présents dans p_patch sont modifiés.
create or replace function public.update_company(p_id uuid, p_patch jsonb, p_force boolean default false)
returns jsonb
language plpgsql
as $$
declare
  c public.companies;
  v_candidates jsonb := '[]';
begin
  perform public.assert_owner();
  select * into c from public.companies where id = p_id and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;

  if p_patch ? 'name' and coalesce(btrim(p_patch ->> 'name'), '') = '' then
    raise exception 'Le nom de l''entreprise est obligatoire' using errcode = '22023';
  end if;

  if (p_patch ? 'website' and public.norm_domain(p_patch ->> 'website') is distinct from c.domain_norm)
     or (p_patch ? 'name' and public.norm_company_name(p_patch ->> 'name') is distinct from c.name_norm) then
    perform public.lock_keys(array['domain:' || public.norm_domain(p_patch ->> 'website'),
                                   'name:' || public.norm_company_name(p_patch ->> 'name')]);
    select coalesce(jsonb_agg(to_jsonb(d)), '[]') into v_candidates
      from public.find_duplicates(
             case when p_patch ? 'name' and public.norm_company_name(p_patch ->> 'name') is distinct from c.name_norm
                  then p_patch ->> 'name' end,
             case when p_patch ? 'website' then p_patch ->> 'website' end,
             '{}', '{}', '{}', p_id) d;
    if jsonb_array_length(v_candidates) > 0 and not p_force then
      return jsonb_build_object('status', 'duplicates', 'candidates', v_candidates);
    end if;
  end if;

  update public.companies set
    name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
    website = case when p_patch ? 'website' then p_patch ->> 'website' else website end,
    description = case when p_patch ? 'description' then nullif(btrim(coalesce(p_patch ->> 'description', '')), '') else description end,
    source_id = case when p_patch ? 'source_id' then nullif(p_patch ->> 'source_id', '')::uuid else source_id end,
    tags = case when p_patch ? 'tags' then coalesce(array(select jsonb_array_elements_text(p_patch -> 'tags')), '{}') else tags end,
    prospect_status = case when p_patch ? 'prospect_status' then p_patch ->> 'prospect_status' else prospect_status end,
    amount = case when p_patch ? 'amount' then nullif(p_patch ->> 'amount', '')::numeric else amount end,
    expected_close_date = case when p_patch ? 'expected_close_date' then nullif(p_patch ->> 'expected_close_date', '')::date else expected_close_date end,
    lost_reason = case when p_patch ? 'lost_reason' then nullif(btrim(coalesce(p_patch ->> 'lost_reason', '')), '') else lost_reason end
  where id = p_id;

  return jsonb_build_object('status', 'updated', 'id', p_id);
end;
$$;

-- Personnes : contrôle email / LinkedIn déjà présents ailleurs
create or replace function public.upsert_person(
  p_company uuid, p_person jsonb, p_person_id uuid default null, p_force boolean default false,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
  v_conflicts jsonb;
  v_email text := public.norm_email(p_person ->> 'email');
  v_li text := public.norm_linkedin(p_person ->> 'linkedin_url');
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  perform public.lock_keys(array['email:' || v_email, 'li:' || v_li]);

  select coalesce(jsonb_agg(jsonb_build_object(
           'person_id', p.id, 'company_id', p.company_id, 'company_name', c.name,
           'person_name', btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
           'reason', case when p.email_norm = v_email then 'Même email : ' || v_email else 'Même profil LinkedIn' end)), '[]')
    into v_conflicts
    from public.people p join public.companies c on c.id = p.company_id
   where (p_person_id is null or p.id <> p_person_id)
     and c.merged_into_id is null
     and ((v_email is not null and p.email_norm = v_email) or (v_li is not null and p.linkedin_norm = v_li));

  if jsonb_array_length(v_conflicts) > 0 and not p_force then
    return jsonb_build_object('status', 'duplicates', 'candidates', v_conflicts);
  end if;

  if coalesce((p_person ->> 'is_primary')::boolean, false) then
    update public.people set is_primary = false
     where company_id = p_company and is_primary and (p_person_id is null or id <> p_person_id);
  end if;

  if p_person_id is null then
    insert into public.people (company_id, first_name, last_name, title, email, phone, linkedin_url, is_primary)
    values (p_company, p_person ->> 'first_name', p_person ->> 'last_name', p_person ->> 'title',
            p_person ->> 'email', p_person ->> 'phone', p_person ->> 'linkedin_url',
            coalesce((p_person ->> 'is_primary')::boolean, false)
              or not exists (select 1 from public.people where company_id = p_company))
    returning id into v_id;
  else
    update public.people set
      first_name = case when p_person ? 'first_name' then p_person ->> 'first_name' else first_name end,
      last_name = case when p_person ? 'last_name' then p_person ->> 'last_name' else last_name end,
      title = case when p_person ? 'title' then p_person ->> 'title' else title end,
      email = case when p_person ? 'email' then p_person ->> 'email' else email end,
      phone = case when p_person ? 'phone' then p_person ->> 'phone' else phone end,
      linkedin_url = case when p_person ? 'linkedin_url' then p_person ->> 'linkedin_url' else linkedin_url end,
      is_primary = case when p_person ? 'is_primary' then coalesce((p_person ->> 'is_primary')::boolean, false) else is_primary end
    where id = p_person_id and company_id = p_company
    returning id into v_id;
    if v_id is null then raise exception 'Personne introuvable' using errcode = 'P0002'; end if;
  end if;

  return public.idem_put(p_idempotency_key, 'upsert_person', jsonb_build_object('status', 'saved', 'id', v_id));
end;
$$;

create or replace function public.set_archived(p_ids uuid[], p_archived boolean)
returns int
language plpgsql
as $$
declare n int;
begin
  perform public.assert_owner();
  if public.current_actor() = 'claude' and cardinality(p_ids) > 1 then
    perform public.assert_not_claude('Archivage multiple');
  end if;
  update public.companies
     set archived_at = case when p_archived then coalesce(archived_at, now()) else null end
   where id = any (p_ids) and merged_into_id is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Interactions saisies manuellement (note, message, appel, rendez-vous)
-- Un message reçu met en pause les relances actives de la fiche.
-- ---------------------------------------------------------------------------

create or replace function public.add_interaction(
  p_company uuid,
  p_kind text,
  p_content text,
  p_occurred_at timestamptz default null,
  p_person uuid default null,
  p_channel text default null,
  p_content_origin text default 'user',
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  v_id uuid;
  v_paused int := 0;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  if p_kind not in ('note','message_out','message_in','call','meeting') then
    raise exception 'Type d''interaction invalide' using errcode = '22023';
  end if;
  if not exists (select 1 from public.companies where id = p_company and merged_into_id is null) then
    raise exception 'Fiche introuvable' using errcode = 'P0002';
  end if;
  if p_person is not null and not exists (select 1 from public.people where id = p_person and company_id = p_company) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;
  if coalesce(btrim(p_content), '') = '' and p_kind in ('note','message_out','message_in') then
    raise exception 'Le contenu est obligatoire' using errcode = '22023';
  end if;
  if coalesce(p_occurred_at, now()) > now() + interval '1 day' then
    raise exception 'La date d''un échange ne peut pas être dans le futur' using errcode = '22023';
  end if;

  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source)
  values (p_company, p_person, p_kind, p_channel, coalesce(p_occurred_at, now()), nullif(btrim(p_content), ''),
          coalesce(p_content_origin, 'user'),
          case when public.current_actor() = 'claude' then 'claude' else 'user' end)
  returning id into v_id;

  if p_kind = 'message_in' then
    update public.campaign_participants
       set status = 'a_repondu', next_due_date = null
     where company_id = p_company and status in ('a_contacter','en_cours');
    get diagnostics v_paused = row_count;
    update public.companies set prospect_status = 'en_discussion'
     where id = p_company and prospect_status in ('nouveau','contacte');
  elsif p_kind = 'message_out' then
    update public.companies set prospect_status = 'contacte'
     where id = p_company and prospect_status = 'nouveau';
  end if;

  return public.idem_put(p_idempotency_key, 'add_interaction',
    jsonb_build_object('status', 'created', 'id', v_id, 'paused_followups', v_paused));
end;
$$;

-- ---------------------------------------------------------------------------
-- Campagnes manuelles
-- ---------------------------------------------------------------------------

create or replace function public.add_lists_to_campaign(p_campaign uuid, p_list_ids uuid[])
returns jsonb
language plpgsql
as $$
declare
  v_first_delay int;
  v_added int;
  v_total int;
begin
  perform public.assert_owner();
  select coalesce(delay_days, 0) into v_first_delay from public.campaign_steps
   where campaign_id = p_campaign order by position limit 1;

  insert into public.campaign_lists (campaign_id, list_id)
  select p_campaign, l from unnest(p_list_ids) l
  on conflict do nothing;

  -- une entreprise présente dans plusieurs listes n'est ajoutée qu'une fois
  select count(distinct lm.company_id) into v_total
    from public.list_members lm join public.companies c on c.id = lm.company_id
   where lm.list_id = any (p_list_ids) and c.archived_at is null and c.merged_into_id is null;

  insert into public.campaign_participants (campaign_id, company_id, person_id, next_due_date)
  select distinct on (c.id) p_campaign, c.id,
         (select p.id from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1),
         public.today_paris() + coalesce(v_first_delay, 0)
    from public.list_members lm join public.companies c on c.id = lm.company_id
   where lm.list_id = any (p_list_ids) and c.archived_at is null and c.merged_into_id is null
  on conflict (campaign_id, company_id) do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object('added', v_added, 'already_present', v_total - v_added);
end;
$$;

create or replace function public.add_companies_to_campaign(p_campaign uuid, p_company_ids uuid[])
returns jsonb
language plpgsql
as $$
declare
  v_first_delay int;
  v_added int;
begin
  perform public.assert_owner();
  select coalesce(delay_days, 0) into v_first_delay from public.campaign_steps
   where campaign_id = p_campaign order by position limit 1;
  insert into public.campaign_participants (campaign_id, company_id, person_id, next_due_date)
  select p_campaign, c.id,
         (select p.id from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1),
         public.today_paris() + coalesce(v_first_delay, 0)
    from public.companies c
   where c.id = any (p_company_ids) and c.merged_into_id is null
  on conflict (campaign_id, company_id) do nothing;
  get diagnostics v_added = row_count;
  return jsonb_build_object('added', v_added, 'already_present', cardinality(p_company_ids) - v_added);
end;
$$;

-- Les étapes du modèle sont copiées : modifier le modèle ne change pas la campagne.
create or replace function public.create_campaign(p_name text, p_template uuid, p_list_ids uuid[] default '{}')
returns jsonb
language plpgsql
as $$
declare
  v_id uuid;
  v_tpl public.templates;
  v_res jsonb := '{}';
begin
  perform public.assert_owner();
  select * into v_tpl from public.templates where id = p_template;
  if not found then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.template_steps where template_id = p_template) then
    raise exception 'Le modèle ne contient aucune étape' using errcode = '22023';
  end if;

  insert into public.campaigns (name, template_id, template_name)
  values (coalesce(nullif(btrim(p_name), ''), v_tpl.name), p_template, v_tpl.name)
  returning id into v_id;

  insert into public.campaign_steps (campaign_id, position, name, channel, delay_days, message)
  select v_id, row_number() over (order by position), name, channel, delay_days, message
    from public.template_steps where template_id = p_template;

  if cardinality(p_list_ids) > 0 then
    v_res := public.add_lists_to_campaign(v_id, p_list_ids);
  end if;
  return jsonb_build_object('id', v_id) || v_res;
end;
$$;

-- « Marquer comme envoyé » : seule action qui enregistre un envoi.
-- La prochaine échéance part de la date réelle d'envoi.
create or replace function public.mark_step_sent(
  p_participant uuid,
  p_content text,
  p_sent_at timestamptz default null,
  p_person uuid default null,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  cp public.campaign_participants;
  st public.campaign_steps;
  nxt public.campaign_steps;
  v_camp public.campaigns;
  v_at timestamptz := coalesce(p_sent_at, now());
  v_person uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  if cp.status in ('termine','arrete') then
    raise exception 'Le suivi de cette fiche est terminé ou arrêté' using errcode = '22023';
  end if;
  if v_at > now() + interval '1 day' then
    raise exception 'La date d''envoi ne peut pas être dans le futur' using errcode = '22023';
  end if;
  select * into v_camp from public.campaigns where id = cp.campaign_id;
  select * into st from public.campaign_steps where campaign_id = cp.campaign_id and position = cp.current_step;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  select * into nxt from public.campaign_steps where campaign_id = cp.campaign_id and position = cp.current_step + 1;

  v_person := coalesce(p_person, cp.person_id);
  if v_person is not null and not exists (select 1 from public.people where id = v_person and company_id = cp.company_id) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;

  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source,
                                   campaign_participant_id, meta)
  values (cp.company_id, v_person, 'message_out', st.channel, v_at, nullif(btrim(p_content), ''), 'user',
          case when public.current_actor() = 'claude' then 'claude' else 'user' end, cp.id,
          jsonb_build_object('campaign_id', v_camp.id, 'campaign_name', v_camp.name,
                             'step_position', st.position, 'step_name', st.name));

  if nxt.id is not null then
    update public.campaign_participants
       set status = 'en_cours', current_step = nxt.position, last_done_at = v_at, person_id = v_person,
           next_due_date = (v_at at time zone 'Europe/Paris')::date + nxt.delay_days
     where id = cp.id;
  else
    update public.campaign_participants
       set status = 'termine', current_step = st.position + 1, last_done_at = v_at, person_id = v_person,
           next_due_date = null
     where id = cp.id;
  end if;

  update public.companies set prospect_status = 'contacte' where id = cp.company_id and prospect_status = 'nouveau';

  return public.idem_put(p_idempotency_key, 'mark_step_sent',
    jsonb_build_object('status', 'sent', 'finished', nxt.id is null));
end;
$$;

-- Réponse reçue : le suivi est mis en pause, l'utilisateur décide de la suite.
create or replace function public.record_reply(
  p_participant uuid,
  p_content text,
  p_received_at timestamptz default null,
  p_person uuid default null,
  p_channel text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  st public.campaign_steps;
  v_res jsonb;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  select * into st from public.campaign_steps
   where campaign_id = cp.campaign_id and position = greatest(cp.current_step - 1, 1);
  v_res := public.add_interaction(cp.company_id, 'message_in', p_content, p_received_at,
                                  coalesce(p_person, cp.person_id), coalesce(p_channel, st.channel));
  update public.interactions set campaign_participant_id = cp.id where id = (v_res ->> 'id')::uuid;
  -- add_interaction a déjà mis en pause les participants actifs ; on couvre aussi un suivi déjà terminé.
  update public.campaign_participants set status = 'a_repondu', next_due_date = null
   where id = cp.id and status <> 'arrete';
  return jsonb_build_object('status', 'paused');
end;
$$;

create or replace function public.update_participant(
  p_participant uuid, p_action text, p_due date default null, p_reason text default null)
returns jsonb
language plpgsql
as $$
declare cp public.campaign_participants;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;

  if p_action = 'postpone' then
    if p_due is null then raise exception 'Nouvelle date obligatoire' using errcode = '22023'; end if;
    if cp.status not in ('a_contacter','en_cours') then
      raise exception 'Seul un suivi actif peut être reporté' using errcode = '22023';
    end if;
    update public.campaign_participants set next_due_date = p_due where id = cp.id;
  elsif p_action = 'resume' then
    if not exists (select 1 from public.campaign_steps where campaign_id = cp.campaign_id and position = cp.current_step) then
      raise exception 'Il ne reste aucune étape à réaliser' using errcode = '22023';
    end if;
    update public.campaign_participants
       set status = case when cp.last_done_at is null then 'a_contacter' else 'en_cours' end,
           next_due_date = coalesce(p_due, public.today_paris()), stop_reason = null
     where id = cp.id;
  elsif p_action = 'stop' then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null, stop_reason = coalesce(nullif(btrim(p_reason), ''), 'Arrêt manuel')
     where id = cp.id;
    perform public.log_event(cp.company_id, 'prospecting', 'Suivi de prospection arrêté : ' || coalesce(nullif(btrim(p_reason), ''), 'arrêt manuel'),
      jsonb_build_object('campaign_id', cp.campaign_id));
  elsif p_action = 'finish' then
    update public.campaign_participants set status = 'termine', next_due_date = null where id = cp.id;
  elsif p_action = 'set_person' then
    if p_reason is not null and not exists (select 1 from public.people where id = p_reason::uuid and company_id = cp.company_id) then
      raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
    end if;
    update public.campaign_participants set person_id = p_reason::uuid where id = cp.id;
  else
    raise exception 'Action inconnue' using errcode = '22023';
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- Pipelines
-- ---------------------------------------------------------------------------

-- Déplace (ou retire) la fiche. Aucune copie : c'est la même ligne qui change d'étape.
create or replace function public.move_company(
  p_company uuid,
  p_stage uuid,
  p_stop_followups boolean default true,
  p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  c public.companies;
  v_to public.stages;
  v_to_pipeline public.pipelines;
  v_from_stage text;
  v_from_pipeline text;
  v_stopped int := 0;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;

  if p_stage is not null then
    select * into v_to from public.stages where id = p_stage;
    if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
    select * into v_to_pipeline from public.pipelines where id = v_to.pipeline_id;
  end if;

  if c.stage_id is not distinct from p_stage and c.deal_status = 'open' then
    return jsonb_build_object('status', 'unchanged');
  end if;

  select s.name, p.name into v_from_stage, v_from_pipeline
    from public.stages s join public.pipelines p on p.id = s.pipeline_id where s.id = c.stage_id;

  update public.companies
     set pipeline_id = v_to.pipeline_id, stage_id = v_to.id,
         deal_status = 'open', deal_closed_at = null,
         prospect_status = case when p_stage is not null and prospect_status in ('nouveau','contacte','en_discussion')
                                then 'qualifie' else prospect_status end
   where id = c.id;

  -- l'entrée dans un pipeline arrête par défaut les relances de prospection actives
  if p_stage is not null and p_stop_followups then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null, stop_reason = 'Entrée dans le pipeline ' || v_to_pipeline.name
     where company_id = c.id and status in ('a_contacter','en_cours','a_repondu');
    get diagnostics v_stopped = row_count;
  end if;

  perform public.log_event(c.id, 'stage_change',
    case when p_stage is null then 'Retirée du pipeline ' || coalesce(v_from_pipeline, '')
         when c.pipeline_id is distinct from v_to.pipeline_id and c.pipeline_id is not null
           then 'Transférée de ' || v_from_pipeline || ' › ' || v_from_stage || ' vers ' || v_to_pipeline.name || ' › ' || v_to.name
         when c.pipeline_id is null then 'Entrée dans ' || v_to_pipeline.name || ' › ' || v_to.name
         else v_to_pipeline.name || ' : ' || coalesce(v_from_stage, '—') || ' → ' || v_to.name end
    || case when c.deal_status <> 'open' and p_stage is not null then ' (opportunité rouverte)' else '' end,
    jsonb_build_object('from_pipeline_id', c.pipeline_id, 'from_pipeline', v_from_pipeline,
                       'from_stage_id', c.stage_id, 'from_stage', v_from_stage,
                       'to_pipeline_id', v_to.pipeline_id, 'to_pipeline', v_to_pipeline.name,
                       'to_stage_id', v_to.id, 'to_stage', v_to.name,
                       'stopped_followups', v_stopped));

  if v_stopped > 0 then
    perform public.log_event(c.id, 'prospecting',
      v_stopped || ' relance(s) de prospection arrêtée(s) suite à l''entrée dans le pipeline');
  end if;

  return public.idem_put(p_idempotency_key, 'move_company',
    jsonb_build_object('status', 'moved', 'stopped_followups', v_stopped));
end;
$$;

-- Gagné / perdu : la fiche garde son dernier pipeline et sa dernière étape.
create or replace function public.set_deal_status(p_company uuid, p_status text, p_lost_reason text default null)
returns jsonb
language plpgsql
as $$
declare c public.companies;
begin
  perform public.assert_owner();
  if p_status not in ('open','won','lost') then raise exception 'Statut invalide' using errcode = '22023'; end if;
  select * into c from public.companies where id = p_company and merged_into_id is null for update;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if c.pipeline_id is null then
    raise exception 'La fiche doit être dans un pipeline' using errcode = '22023';
  end if;
  if c.deal_status = p_status then return jsonb_build_object('status', 'unchanged'); end if;
  update public.companies
     set deal_status = p_status,
         deal_closed_at = case when p_status = 'open' then null else now() end,
         lost_reason = case when p_status = 'lost' then nullif(btrim(coalesce(p_lost_reason, '')), '') else lost_reason end
   where id = c.id;
  perform public.log_event(c.id, 'deal_status',
    case p_status when 'won' then 'Opportunité gagnée' when 'lost' then 'Opportunité perdue' || coalesce(' : ' || nullif(btrim(p_lost_reason), ''), '')
                  else 'Opportunité rouverte' end,
    jsonb_build_object('from', c.deal_status, 'to', p_status));
  return jsonb_build_object('status', 'ok');
end;
$$;

create or replace function public.reorder_stages(p_pipeline uuid, p_stage_ids uuid[])
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  if exists (select 1 from unnest(p_stage_ids) s
              where not exists (select 1 from public.stages st where st.id = s and st.pipeline_id = p_pipeline)) then
    raise exception 'Étape étrangère au pipeline' using errcode = '22023';
  end if;
  update public.stages st set position = o.ord
    from unnest(p_stage_ids) with ordinality o(id, ord)
   where st.id = o.id;
end;
$$;

-- Suppression d'une étape : les fiches qu'elle contient vont dans l'étape de remplacement.
create or replace function public.delete_stage(p_stage uuid, p_replacement uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_stage public.stages;
  v_rep public.stages;
  v_count int;
  r record;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression d''étape');
  select * into v_stage from public.stages where id = p_stage;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  select count(*) into v_count from public.companies where stage_id = p_stage;
  if v_count > 0 then
    if p_replacement is null or p_replacement = p_stage then
      raise exception 'Cette étape contient % fiche(s) : choisissez une étape de remplacement', v_count using errcode = '22023';
    end if;
    select * into v_rep from public.stages where id = p_replacement;
    if not found then raise exception 'Étape de remplacement introuvable' using errcode = 'P0002'; end if;
    for r in select id from public.companies where stage_id = p_stage loop
      update public.companies set pipeline_id = v_rep.pipeline_id, stage_id = v_rep.id where id = r.id;
      perform public.log_event(r.id, 'stage_change',
        'Étape « ' || v_stage.name || ' » supprimée : fiche déplacée vers « ' || v_rep.name || ' »',
        jsonb_build_object('from_stage_id', v_stage.id, 'from_stage', v_stage.name, 'to_stage_id', v_rep.id, 'to_stage', v_rep.name));
    end loop;
  end if;
  delete from public.stages where id = p_stage;
  return jsonb_build_object('moved', v_count);
end;
$$;

create or replace function public.delete_pipeline(p_pipeline uuid, p_replacement_stage uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_pipe public.pipelines;
  v_rep public.stages;
  v_count int;
  r record;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Suppression de pipeline');
  select * into v_pipe from public.pipelines where id = p_pipeline;
  if not found then raise exception 'Pipeline introuvable' using errcode = 'P0002'; end if;
  select count(*) into v_count from public.companies where pipeline_id = p_pipeline;
  if v_count > 0 then
    select * into v_rep from public.stages where id = p_replacement_stage and pipeline_id <> p_pipeline;
    if not found then
      raise exception 'Ce pipeline contient % fiche(s) : choisissez une étape de destination dans un autre pipeline', v_count
        using errcode = '22023';
    end if;
    for r in select id from public.companies where pipeline_id = p_pipeline loop
      update public.companies set pipeline_id = v_rep.pipeline_id, stage_id = v_rep.id where id = r.id;
      perform public.log_event(r.id, 'stage_change',
        'Pipeline « ' || v_pipe.name || ' » supprimé : fiche déplacée vers « ' || v_rep.name || ' »',
        jsonb_build_object('from_pipeline_id', v_pipe.id, 'from_pipeline', v_pipe.name, 'to_stage_id', v_rep.id, 'to_stage', v_rep.name));
    end loop;
  end if;
  delete from public.stages where pipeline_id = p_pipeline;
  delete from public.pipelines where id = p_pipeline;
  return jsonb_build_object('moved', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Fusion explicite de deux fiches, dans une seule transaction
-- p_fields : {"name":"keep"|"merged", "website":…, "description":…, "source_id":…,
--             "amount":…, "expected_close_date":…, "prospect_status":…}
-- p_pipeline_from : 'keep' | 'merged' (pipeline, étape, statut commercial)
-- ---------------------------------------------------------------------------

create or replace function public.merge_companies(
  p_keep uuid, p_merge uuid, p_fields jsonb default '{}', p_pipeline_from text default 'keep')
returns jsonb
language plpgsql
as $$
declare
  k public.companies;
  m public.companies;
  r record;
  v_conflicts int := 0;
  v_people int;
  f text;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Fusion');
  if p_keep = p_merge then raise exception 'Impossible de fusionner une fiche avec elle-même' using errcode = '22023'; end if;
  -- verrouillage dans un ordre stable
  perform 1 from public.companies where id in (p_keep, p_merge) order by id for update;
  select * into k from public.companies where id = p_keep;
  select * into m from public.companies where id = p_merge;
  if k.id is null or m.id is null then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if k.merged_into_id is not null or m.merged_into_id is not null then
    raise exception 'Une des fiches a déjà été fusionnée' using errcode = '22023';
  end if;

  insert into public.merges (kept_company_id, merged_company_id, merged_snapshot, field_choices)
  values (k.id, m.id,
          jsonb_build_object('company', to_jsonb(m),
                             'people', coalesce((select jsonb_agg(to_jsonb(p)) from public.people p where p.company_id = m.id), '[]')),
          coalesce(p_fields, '{}') || jsonb_build_object('pipeline_from', p_pipeline_from));

  for f in select jsonb_object_keys(coalesce(p_fields, '{}')) loop
    if f not in ('name','website','description','source_id','amount','expected_close_date','prospect_status','lost_reason') then
      raise exception 'Champ inconnu : %', f using errcode = '22023';
    end if;
  end loop;

  update public.companies set
    name = case when p_fields ->> 'name' = 'merged' then m.name else k.name end,
    website = case when p_fields ->> 'website' = 'merged' then m.website else coalesce(k.website, m.website) end,
    description = case when p_fields ->> 'description' = 'merged' then m.description else coalesce(k.description, m.description) end,
    source_id = case when p_fields ->> 'source_id' = 'merged' then m.source_id else coalesce(k.source_id, m.source_id) end,
    amount = case when p_fields ->> 'amount' = 'merged' then m.amount else coalesce(k.amount, m.amount) end,
    expected_close_date = case when p_fields ->> 'expected_close_date' = 'merged' then m.expected_close_date else coalesce(k.expected_close_date, m.expected_close_date) end,
    prospect_status = case when p_fields ->> 'prospect_status' = 'merged' then m.prospect_status else k.prospect_status end,
    lost_reason = case when p_fields ->> 'lost_reason' = 'merged' then m.lost_reason else coalesce(k.lost_reason, m.lost_reason) end,
    tags = array(select distinct unnest(k.tags || m.tags)),
    pipeline_id = case when p_pipeline_from = 'merged' then m.pipeline_id else k.pipeline_id end,
    stage_id = case when p_pipeline_from = 'merged' then m.stage_id else k.stage_id end,
    deal_status = case when p_pipeline_from = 'merged' then m.deal_status else k.deal_status end,
    deal_closed_at = case when p_pipeline_from = 'merged' then m.deal_closed_at else k.deal_closed_at end,
    archived_at = case when k.archived_at is not null and m.archived_at is null then null else k.archived_at end
  where id = k.id;

  -- personnes : un seul contact principal conservé
  if exists (select 1 from public.people where company_id = k.id and is_primary) then
    update public.people set is_primary = false where company_id = m.id;
  end if;
  update public.people set company_id = k.id where company_id = m.id;
  get diagnostics v_people = row_count;

  update public.interactions set company_id = k.id where company_id = m.id;
  update public.tasks set company_id = k.id where company_id = m.id;
  update public.import_row_keys set company_id = k.id where company_id = m.id;

  insert into public.list_members (list_id, company_id, added_at)
  select list_id, k.id, added_at from public.list_members where company_id = m.id
  on conflict do nothing;
  delete from public.list_members where company_id = m.id;

  -- campagnes : sans conflit, le participant est rattaché à la fiche conservée ;
  -- en conflit, celui de la fiche fusionnée est arrêté et son état est consigné.
  for r in
    select cp.*, ca.name as campaign_name
      from public.campaign_participants cp join public.campaigns ca on ca.id = cp.campaign_id
     where cp.company_id = m.id
  loop
    if exists (select 1 from public.campaign_participants where campaign_id = r.campaign_id and company_id = k.id) then
      update public.campaign_participants
         set status = 'arrete', next_due_date = null, stop_reason = 'Fusionné dans la fiche ' || k.name
       where id = r.id;
      perform public.log_event(k.id, 'merge',
        'Campagne « ' || r.campaign_name || ' » : la fiche fusionnée y était aussi (étape ' || r.current_step
        || ', statut ' || r.status || '). Le suivi de cette fiche a été conservé.',
        jsonb_build_object('campaign_id', r.campaign_id, 'merged_participant', to_jsonb(r)));
      v_conflicts := v_conflicts + 1;
    else
      update public.campaign_participants set company_id = k.id where id = r.id;
    end if;
  end loop;

  delete from public.duplicate_dismissals where company_a = m.id or company_b = m.id;

  update public.companies
     set merged_into_id = k.id, archived_at = coalesce(archived_at, now()),
         pipeline_id = null, stage_id = null
   where id = m.id;

  perform public.log_event(k.id, 'merge',
    'Fiche « ' || m.name || ' » fusionnée dans cette fiche (ancien identifiant ' || m.id || ')',
    jsonb_build_object('merged_company_id', m.id, 'merged_name', m.name, 'people_moved', v_people,
                       'campaign_conflicts', v_conflicts,
                       'pipeline_from', p_pipeline_from,
                       'discarded_pipeline', case when p_pipeline_from = 'merged' then k.stage_id else m.stage_id end));

  return jsonb_build_object('status', 'merged', 'kept_id', k.id, 'merged_id', m.id,
                            'people_moved', v_people, 'campaign_conflicts', v_conflicts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Import CSV
-- ---------------------------------------------------------------------------

-- Vérifie les groupes d'un import : doublons en base et lignes déjà importées.
-- p_groups : [{key, name, website, emails[], linkedins[], person_names[], row_hashes[]}]
create or replace function public.import_check(p_groups jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  g jsonb;
  v_out jsonb := '[]';
  v_candidates jsonb;
  v_imported jsonb;
begin
  perform public.assert_owner();
  for g in select * from jsonb_array_elements(p_groups) loop
    select coalesce(jsonb_agg(to_jsonb(d)), '[]') into v_candidates
      from public.find_duplicates(
        g ->> 'name', g ->> 'website',
        coalesce(array(select jsonb_array_elements_text(g -> 'emails')), '{}'),
        coalesce(array(select jsonb_array_elements_text(g -> 'linkedins')), '{}'),
        coalesce(array(select jsonb_array_elements_text(g -> 'person_names')), '{}')) d;
    select coalesce(jsonb_agg(distinct k.company_id), '[]') into v_imported
      from public.import_row_keys k
      join public.companies c on c.id = k.company_id
     where k.row_hash in (select jsonb_array_elements_text(g -> 'row_hashes'));
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'key', g ->> 'key', 'candidates', v_candidates, 'already_imported_company_ids', v_imported));
  end loop;
  return v_out;
end;
$$;

-- Applique les choix explicites de l'utilisateur.
-- p_groups : [{key, action:'create'|'complete'|'skip', target_company_id, rows:[numéros],
--              row_hashes:[…], company:{name, website, description, source}, people:[…]}]
create or replace function public.import_commit(
  p_idempotency_key text, p_filename text, p_groups jsonb, p_list_id uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_existing public.imports;
  v_import_id uuid;
  g jsonb;
  pr jsonb;
  v_company uuid;
  v_source uuid;
  v_res jsonb;
  v_created int := 0;
  v_completed int := 0;
  v_skipped int := 0;
  v_people int := 0;
  v_errors jsonb := '[]';
  v_existing_person uuid;
begin
  perform public.assert_owner();
  perform public.lock_keys(array['import:' || p_idempotency_key]);
  select * into v_existing from public.imports where idempotency_key = p_idempotency_key;
  if found then return v_existing.summary || jsonb_build_object('replayed', true); end if;

  insert into public.imports (idempotency_key, filename) values (p_idempotency_key, p_filename)
  returning id into v_import_id;

  for g in select * from jsonb_array_elements(p_groups) loop
    if g ->> 'action' = 'skip' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    begin
      v_source := null;
      if coalesce(btrim(g -> 'company' ->> 'source'), '') <> '' then
        select id into v_source from public.lead_sources where lower(btrim(name)) = lower(btrim(g -> 'company' ->> 'source'));
        if v_source is null then
          insert into public.lead_sources (name, position)
          values (btrim(g -> 'company' ->> 'source'), (select coalesce(max(position), 0) + 1 from public.lead_sources))
          returning id into v_source;
        end if;
      end if;

      if g ->> 'action' = 'create' then
        v_res := public.create_company(
          jsonb_build_object('name', g -> 'company' ->> 'name', 'website', g -> 'company' ->> 'website',
                             'description', g -> 'company' ->> 'description', 'source_id', v_source),
          coalesce(g -> 'people', '[]'), true, null);
        v_company := (v_res ->> 'id')::uuid;
        update public.interactions set source = 'import', content = 'Fiche créée par import CSV'
         where company_id = v_company and kind = 'system';
        v_created := v_created + 1;
        v_people := v_people + jsonb_array_length(coalesce(g -> 'people', '[]'));
      elsif g ->> 'action' = 'complete' then
        v_company := (g ->> 'target_company_id')::uuid;
        if not exists (select 1 from public.companies where id = v_company and merged_into_id is null) then
          raise exception 'Fiche cible introuvable';
        end if;
        -- complément : on ne remplit que les champs vides, jamais d'écrasement
        update public.companies set
          website = coalesce(website, nullif(btrim(coalesce(g -> 'company' ->> 'website', '')), '')),
          description = coalesce(description, nullif(btrim(coalesce(g -> 'company' ->> 'description', '')), '')),
          source_id = coalesce(source_id, v_source)
        where id = v_company;
        for pr in select * from jsonb_array_elements(coalesce(g -> 'people', '[]')) loop
          select id into v_existing_person from public.people p
           where p.company_id = v_company
             and ((public.norm_email(pr ->> 'email') is not null and p.email_norm = public.norm_email(pr ->> 'email'))
               or (public.norm_linkedin(pr ->> 'linkedin_url') is not null and p.linkedin_norm = public.norm_linkedin(pr ->> 'linkedin_url'))
               or (public.norm_person_name(pr ->> 'first_name', pr ->> 'last_name') is not null
                   and p.full_name_norm = public.norm_person_name(pr ->> 'first_name', pr ->> 'last_name')))
           limit 1;
          if v_existing_person is null then
            insert into public.people (company_id, first_name, last_name, title, email, phone, linkedin_url, is_primary)
            values (v_company, pr ->> 'first_name', pr ->> 'last_name', pr ->> 'title', pr ->> 'email', pr ->> 'phone',
                    pr ->> 'linkedin_url', not exists (select 1 from public.people where company_id = v_company));
            v_people := v_people + 1;
          else
            update public.people set
              title = coalesce(title, nullif(btrim(coalesce(pr ->> 'title', '')), '')),
              email = coalesce(email, nullif(btrim(coalesce(pr ->> 'email', '')), '')),
              phone = coalesce(phone, nullif(btrim(coalesce(pr ->> 'phone', '')), '')),
              linkedin_url = coalesce(linkedin_url, nullif(btrim(coalesce(pr ->> 'linkedin_url', '')), ''))
            where id = v_existing_person;
          end if;
        end loop;
        perform public.log_event(v_company, 'system', 'Fiche complétée par import CSV');
        v_completed := v_completed + 1;
      else
        raise exception 'Action inconnue';
      end if;

      insert into public.import_row_keys (row_hash, company_id, import_id)
      select h, v_company, v_import_id from jsonb_array_elements_text(coalesce(g -> 'row_hashes', '[]')) h
      on conflict (row_hash) do nothing;

      if p_list_id is not null then
        insert into public.list_members (list_id, company_id) values (p_list_id, v_company) on conflict do nothing;
      end if;
    exception when others then
      v_errors := v_errors || jsonb_build_array(jsonb_build_object('rows', g -> 'rows', 'message', sqlerrm));
    end;
  end loop;

  v_res := jsonb_build_object('import_id', v_import_id, 'created', v_created, 'completed', v_completed,
                              'skipped', v_skipped, 'people', v_people, 'errors', v_errors);
  update public.imports set summary = v_res where id = v_import_id;
  return v_res;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lecture : recherche globale et relances du jour
-- ---------------------------------------------------------------------------

create or replace function public.search_companies(p_query text, p_include_archived boolean default false, p_limit int default 20)
returns table (id uuid, name text, website text, archived boolean, matched text)
language plpgsql
stable
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
  qn text := public.norm_company_name(p_query);
begin
  perform public.assert_owner();
  if q = '' then return; end if;
  return query
  select c.id, c.name, c.website, c.archived_at is not null,
         coalesce(
           case when c.name ilike '%' || q || '%' or c.name_norm like '%' || coalesce(qn, q) || '%' then null end,
           case when c.domain_norm like '%' || q || '%' then 'Domaine : ' || c.domain_norm end,
           (select 'Personne : ' || btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) || coalesce(' · ' || p.email, '')
              from public.people p
             where p.company_id = c.id
               and (p.full_name_norm like '%' || coalesce(public.norm_person_name(q, null), q) || '%'
                    or p.email_norm like '%' || q || '%' or p.linkedin_norm like '%' || q || '%')
             limit 1))
    from public.companies c
   where c.merged_into_id is null
     and (p_include_archived or c.archived_at is null)
     and (c.name ilike '%' || q || '%'
          or c.name_norm like '%' || coalesce(qn, q) || '%'
          or c.domain_norm like '%' || q || '%'
          or exists (select 1 from public.people p where p.company_id = c.id
                      and (p.full_name_norm like '%' || coalesce(public.norm_person_name(q, null), q) || '%'
                           or p.email_norm like '%' || q || '%' or p.linkedin_norm like '%' || q || '%')))
   order by (c.name_norm = qn) desc, (c.name ilike q || '%') desc, c.name
   limit greatest(1, least(p_limit, 50));
end;
$$;

-- Actions à faire : tâches ouvertes + étapes de prospection en attente.
-- Les deux sources sont distinctes (aucune tâche n'est générée pour une étape), donc pas de doublon.
create or replace view public.todo_items with (security_invoker = true) as
  select 'task'::text as item_type, t.id, t.company_id, c.name as company_name, t.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as person_name,
         t.title, t.due_date, null::uuid as campaign_id, null::text as campaign_name, null::text as channel,
         null::int as step_position, null::text as step_message
    from public.tasks t
    join public.companies c on c.id = t.company_id
    left join public.people p on p.id = t.person_id
   where t.done_at is null and c.merged_into_id is null and c.archived_at is null
  union all
  select 'followup', cp.id, cp.company_id, c.name, cp.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         cs.name, cp.next_due_date, ca.id, ca.name, cs.channel, cs.position, cs.message
    from public.campaign_participants cp
    join public.campaigns ca on ca.id = cp.campaign_id and ca.archived_at is null
    join public.companies c on c.id = cp.company_id
    join public.campaign_steps cs on cs.campaign_id = cp.campaign_id and cs.position = cp.current_step
    left join public.people p on p.id = cp.person_id
   where cp.status in ('a_contacter','en_cours') and cp.next_due_date is not null
     and c.merged_into_id is null and c.archived_at is null;

-- Vue d'ensemble d'une fiche pour les tableaux (prospection et kanban)
create or replace view public.company_overview with (security_invoker = true) as
  select c.*,
         pp.id as primary_person_id,
         nullif(btrim(coalesce(pp.first_name,'') || ' ' || coalesce(pp.last_name,'')), '') as primary_person_name,
         pp.email as primary_person_email,
         (select count(*) from public.people p where p.company_id = c.id)::int as people_count,
         coalesce((select array_agg(lm.list_id) from public.list_members lm where lm.company_id = c.id), '{}') as list_ids,
         na.title as next_action_title, na.due_date as next_action_due, na.item_type as next_action_type,
         coalesce((select string_agg(coalesce(p.email,'') || ' ' || coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,''), ' ')
                     from public.people p where p.company_id = c.id), '') as people_search
    from public.companies c
    left join lateral (
      select * from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1
    ) pp on true
    left join lateral (
      select ti.title, ti.due_date, ti.item_type from public.todo_items ti
       where ti.company_id = c.id order by ti.due_date, ti.item_type limit 1
    ) na on true
   where c.merged_into_id is null;

-- ---------------------------------------------------------------------------
-- Droits d'exécution : rien pour anon
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.todo_items, public.company_overview from anon;
grant select on public.todo_items, public.company_overview to authenticated;
