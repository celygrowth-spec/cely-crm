-- Prospection v2 : campagnes avec statut, séquences versionnées, types d'étapes manuelles,
-- brouillons personnalisés, journal d'actions annulables, résultats commerciaux,
-- « Ne plus contacter », vues enregistrées. Migration additive : aucune donnée supprimée.

-- ---------------------------------------------------------------------------
-- Types d'étapes
-- ---------------------------------------------------------------------------

create or replace function public.step_channel(p_type text)
returns text
language sql
immutable
as $$
  select case
    when p_type = 'email' then 'email'
    when p_type like 'linkedin_%' then 'linkedin'
    when p_type = 'call' then 'phone'
    else 'other' end;
$$;

-- type d'interaction enregistrée lorsque l'étape est réalisée
create or replace function public.step_interaction_kind(p_type text)
returns text
language sql
immutable
as $$
  select case
    when p_type in ('email', 'linkedin_message', 'linkedin_invite') then 'message_out'
    when p_type = 'call' then 'call'
    else 'prospecting' end;
$$;

-- ---------------------------------------------------------------------------
-- Colonnes ajoutées
-- ---------------------------------------------------------------------------

alter table public.companies
  add column do_not_contact boolean not null default false,
  add column do_not_contact_reason text check (do_not_contact_reason is null or char_length(do_not_contact_reason) <= 500),
  add column do_not_contact_at timestamptz;

alter table public.campaigns
  add column status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'finished', 'archived')),
  add column current_version int not null default 1,
  add column description text check (description is null or char_length(description) <= 2000);
update public.campaigns set status = case when archived_at is not null then 'archived' else 'active' end;

alter table public.template_steps
  add column step_type text,
  add column subject text check (subject is null or char_length(subject) <= 300),
  add column instructions text check (instructions is null or char_length(instructions) <= 2000);
update public.template_steps set step_type = case channel
  when 'linkedin' then 'linkedin_message' when 'email' then 'email' when 'phone' then 'call' else 'task' end;
alter table public.template_steps alter column step_type set not null;

alter table public.campaign_steps
  add column version int not null default 1,
  add column step_type text,
  add column subject text check (subject is null or char_length(subject) <= 300),
  add column instructions text check (instructions is null or char_length(instructions) <= 2000);
update public.campaign_steps set step_type = case channel
  when 'linkedin' then 'linkedin_message' when 'email' then 'email' when 'phone' then 'call' else 'task' end;
alter table public.campaign_steps alter column step_type set not null;
alter table public.campaign_steps drop constraint campaign_steps_campaign_id_position_key;
alter table public.campaign_steps add constraint campaign_steps_version_position_key unique (campaign_id, version, position);

do $$
declare t text;
begin
  foreach t in array array['template_steps', 'campaign_steps'] loop
    execute format($f$alter table public.%I add constraint %I check (step_type in
      ('email','linkedin_invite','linkedin_message','call','linkedin_visit','linkedin_interaction','task'))$f$, t, t || '_type_check');
  end loop;
end $$;

-- variables v1 {prénom} / {entreprise} → syntaxe v2 {{prenom}} / {{entreprise}}
update public.template_steps set message = regexp_replace(regexp_replace(message,
  '\{\s*pr[ée]nom\s*\}', '{{prenom}}', 'gi'), '\{\s*entreprise\s*\}', '{{entreprise}}', 'gi') where message is not null;
update public.campaign_steps set message = regexp_replace(regexp_replace(message,
  '\{\s*pr[ée]nom\s*\}', '{{prenom}}', 'gi'), '\{\s*entreprise\s*\}', '{{entreprise}}', 'gi') where message is not null;

alter table public.campaign_participants drop constraint campaign_participants_status_check;
alter table public.campaign_participants add constraint campaign_participants_status_check
  check (status in ('a_preparer', 'a_contacter', 'en_cours', 'a_repondu', 'termine', 'arrete'));
alter table public.campaign_participants
  add column sequence_version int,
  add column outcome text not null default 'none'
    check (outcome in ('none', 'replied', 'interested', 'not_interested', 'meeting', 'do_not_contact')),
  add column outcome_at timestamptz,
  add column activated_at timestamptz,
  add column moved_to_pipeline_at timestamptz;
update public.campaign_participants set sequence_version = 1, activated_at = created_at;
update public.campaign_participants set outcome = 'replied', outcome_at = updated_at where status = 'a_repondu';
alter table public.campaign_participants alter column sequence_version set not null;

-- ---------------------------------------------------------------------------
-- Nouvelles tables
-- ---------------------------------------------------------------------------

-- Brouillon personnalisé d'une étape pour un participant (≠ modèle, ≠ contenu envoyé)
create table public.participant_drafts (
  participant_id uuid not null references public.campaign_participants (id) on delete cascade,
  sequence_version int not null,
  step_position int not null,
  subject text check (subject is null or char_length(subject) <= 300),
  body text check (body is null or char_length(body) <= 20000),
  updated_at timestamptz not null default now(),
  primary key (participant_id, sequence_version, step_position)
);

-- Journal des actions sur un participant, pour l'annulation courte
create table public.participant_actions (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.campaign_participants (id) on delete cascade,
  action text not null check (action in ('done', 'skip')),
  step_position int not null,
  interaction_id uuid references public.interactions (id) on delete set null,
  prev_state jsonb not null,
  next_state jsonb not null,
  created_at timestamptz not null default now(),
  undone_at timestamptz
);
create index participant_actions_participant_idx on public.participant_actions (participant_id, created_at desc);

-- Vues enregistrées (filtres, colonnes, ordre) et préférences d'affichage
create table public.saved_views (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (char_length(scope) between 1 and 60),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  config jsonb not null default '{}',
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.user_preferences (
  key text primary key check (char_length(key) between 1 and 120),
  value jsonb not null,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['participant_drafts', 'participant_actions', 'saved_views', 'user_preferences'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_select on public.%I for select to authenticated using ((select public.is_app_owner()))', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()) and public.current_actor() = ''user'')', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- un participant prend la version courante de la séquence ; « Ne plus contacter » bloque l'inscription
create or replace function public.tg_participants_before_insert()
returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from public.companies where id = new.company_id and do_not_contact) then
    return null; -- ignoré silencieusement : les fonctions d'inscription le comptent comme bloqué
  end if;
  if new.sequence_version is null then
    select current_version into new.sequence_version from public.campaigns where id = new.campaign_id;
  end if;
  if new.status <> 'a_preparer' and new.activated_at is null then
    new.activated_at := now();
  end if;
  return new;
end;
$$;
create trigger participants_before_insert before insert on public.campaign_participants
  for each row execute function public.tg_participants_before_insert();

-- une réponse (statut a_repondu) devient le résultat « a répondu » si rien de plus précis n'existe
create or replace function public.tg_participants_outcome()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'a_repondu' and old.status <> 'a_repondu' and new.outcome = 'none' then
    new.outcome := 'replied';
    new.outcome_at := now();
  end if;
  return new;
end;
$$;
create trigger participants_outcome before update of status on public.campaign_participants
  for each row execute function public.tg_participants_outcome();

-- passage en pipeline : mémorisé sur les participations de l'entreprise (statistiques)
create or replace function public.tg_companies_pipeline_entry()
returns trigger
language plpgsql
as $$
begin
  if new.stage_id is not null and old.pipeline_id is null then
    update public.campaign_participants set moved_to_pipeline_at = coalesce(moved_to_pipeline_at, now())
     where company_id = new.id;
  end if;
  return null;
end;
$$;
create trigger companies_pipeline_entry after update of stage_id on public.companies
  for each row execute function public.tg_companies_pipeline_entry();

do $$
declare t text;
begin
  foreach t in array array['saved_views', 'user_preferences', 'participant_drafts'] loop
    if t <> 'saved_views' then
      execute format('create trigger set_updated_at before update on public.%I for each row execute function public.tg_set_updated_at()', t);
    end if;
  end loop;
end $$;

-- type ⇄ canal : l'un se déduit de l'autre si absent (compatibilité avec les écritures v1)
create or replace function public.tg_steps_type_channel()
returns trigger
language plpgsql
as $$
begin
  if new.step_type is null then
    new.step_type := case new.channel when 'linkedin' then 'linkedin_message' when 'email' then 'email'
                                      when 'phone' then 'call' else 'task' end;
  end if;
  new.channel := public.step_channel(new.step_type);
  return new;
end;
$$;
create trigger steps_type_channel before insert or update on public.template_steps
  for each row execute function public.tg_steps_type_channel();
create trigger steps_type_channel before insert or update on public.campaign_steps
  for each row execute function public.tg_steps_type_channel();

-- ---------------------------------------------------------------------------
-- Campagnes
-- ---------------------------------------------------------------------------

create or replace function public.validate_steps(p_steps jsonb)
returns void
language plpgsql
as $$
declare s jsonb; i int := 0;
begin
  if jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) = 0 then
    raise exception 'Ajoutez au moins une étape' using errcode = '22023';
  end if;
  if jsonb_array_length(p_steps) > 30 then
    raise exception '30 étapes maximum' using errcode = '22023';
  end if;
  for s in select * from jsonb_array_elements(p_steps) loop
    i := i + 1;
    if coalesce(btrim(s ->> 'name'), '') = '' then
      raise exception 'Étape % : le titre est obligatoire', i using errcode = '22023';
    end if;
    if coalesce(s ->> 'step_type', '') not in ('email','linkedin_invite','linkedin_message','call','linkedin_visit','linkedin_interaction','task') then
      raise exception 'Étape % : type inconnu', i using errcode = '22023';
    end if;
    if coalesce(nullif(s ->> 'delay_days', '')::int, 0) not between 0 and 365 then
      raise exception 'Étape % : délai entre 0 et 365 jours', i using errcode = '22023';
    end if;
  end loop;
end;
$$;

create or replace function public.insert_campaign_steps(p_campaign uuid, p_version int, p_steps jsonb)
returns void
language sql
as $$
  insert into public.campaign_steps (campaign_id, version, position, name, step_type, channel, delay_days, subject, message, instructions)
  select p_campaign, p_version, o::int, btrim(s ->> 'name'), s ->> 'step_type', public.step_channel(s ->> 'step_type'),
         coalesce(nullif(s ->> 'delay_days', '')::int, 0),
         nullif(btrim(coalesce(s ->> 'subject', '')), ''),
         nullif(coalesce(s ->> 'message', ''), ''),
         nullif(btrim(coalesce(s ->> 'instructions', '')), '')
    from jsonb_array_elements(p_steps) with ordinality as t(s, o);
$$;

create or replace function public.create_campaign_draft(p_name text, p_template uuid default null)
returns uuid
language plpgsql
as $$
declare v_id uuid; v_steps jsonb;
begin
  perform public.assert_owner();
  insert into public.campaigns (name, template_id, template_name, status)
  values (coalesce(nullif(btrim(p_name), ''), 'Nouvelle campagne'), p_template,
          (select name from public.templates where id = p_template), 'draft')
  returning id into v_id;
  if p_template is not null then
    select jsonb_agg(jsonb_build_object('name', name, 'step_type', step_type, 'delay_days', delay_days,
                     'subject', subject, 'message', message, 'instructions', instructions) order by position)
      into v_steps from public.template_steps where template_id = p_template;
    if v_steps is not null then perform public.insert_campaign_steps(v_id, 1, v_steps); end if;
  end if;
  return v_id;
end;
$$;

-- Enregistre la séquence. Si des participants ont déjà démarré sur la version courante et que la
-- structure change (ordre, types, délais, nombre), une nouvelle version est créée : les
-- participants démarrés gardent leur version, les participants à préparer passent à la nouvelle.
create or replace function public.save_campaign_sequence(p_campaign uuid, p_steps jsonb)
returns jsonb
language plpgsql
as $$
declare
  c public.campaigns;
  v_old_sig text;
  v_new_sig text;
  v_started int;
  v_new_version int;
begin
  perform public.assert_owner();
  perform public.validate_steps(p_steps);
  select * into c from public.campaigns where id = p_campaign for update;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  if c.status = 'archived' then raise exception 'Campagne archivée : désarchivez-la pour la modifier' using errcode = '22023'; end if;

  select coalesce(string_agg(step_type || ':' || delay_days, '|' order by position), '') into v_old_sig
    from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  select coalesce(string_agg((s ->> 'step_type') || ':' || coalesce(nullif(s ->> 'delay_days', '')::int, 0), '|' order by o), '')
    into v_new_sig from jsonb_array_elements(p_steps) with ordinality as t(s, o);
  select count(*) into v_started from public.campaign_participants
   where campaign_id = c.id and sequence_version = c.current_version and status <> 'a_preparer';

  if v_started > 0 and v_old_sig <> v_new_sig then
    v_new_version := c.current_version + 1;
    perform public.insert_campaign_steps(c.id, v_new_version, p_steps);
    update public.campaigns set current_version = v_new_version where id = c.id;
    update public.campaign_participants set sequence_version = v_new_version
     where campaign_id = c.id and status = 'a_preparer';
    return jsonb_build_object('version', v_new_version, 'new_version', true, 'kept_on_previous', v_started);
  end if;

  -- même structure (ou aucun participant démarré) : mise à jour de la version courante
  delete from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  perform public.insert_campaign_steps(c.id, c.current_version, p_steps);
  update public.campaigns set updated_at = now() where id = c.id;
  return jsonb_build_object('version', c.current_version, 'new_version', false);
end;
$$;

create or replace function public.set_campaign_status(p_campaign uuid, p_status text)
returns void
language plpgsql
as $$
declare c public.campaigns;
begin
  perform public.assert_owner();
  if p_status not in ('draft', 'active', 'paused', 'finished', 'archived') then
    raise exception 'Statut invalide' using errcode = '22023';
  end if;
  select * into c from public.campaigns where id = p_campaign for update;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  if p_status = 'active' and not exists (select 1 from public.campaign_steps where campaign_id = c.id and version = c.current_version) then
    raise exception 'La séquence est vide' using errcode = '22023';
  end if;
  update public.campaigns
     set status = p_status,
         archived_at = case when p_status = 'archived' then coalesce(archived_at, now()) else null end
   where id = c.id;
end;
$$;

-- Duplique structure et contenus, sans participants ni historique
create or replace function public.duplicate_campaign(p_campaign uuid)
returns uuid
language plpgsql
as $$
declare c public.campaigns; v_id uuid;
begin
  perform public.assert_owner();
  select * into c from public.campaigns where id = p_campaign;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  insert into public.campaigns (name, template_id, template_name, description, status)
  values (c.name || ' (copie)', c.template_id, c.template_name, c.description, 'draft') returning id into v_id;
  insert into public.campaign_steps (campaign_id, version, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, 1, position, name, step_type, channel, delay_days, subject, message, instructions
    from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  return v_id;
end;
$$;

create or replace function public.save_campaign_as_template(p_campaign uuid, p_name text)
returns uuid
language plpgsql
as $$
declare c public.campaigns; v_id uuid;
begin
  perform public.assert_owner();
  select * into c from public.campaigns where id = p_campaign;
  if not found then raise exception 'Campagne introuvable' using errcode = 'P0002'; end if;
  insert into public.templates (name) values (coalesce(nullif(btrim(p_name), ''), c.name)) returning id into v_id;
  insert into public.template_steps (template_id, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, position, name, step_type, channel, delay_days, subject, message, instructions
    from public.campaign_steps where campaign_id = c.id and version = c.current_version;
  return v_id;
end;
$$;

-- Modèles : nouvelle signature avec types, objet et consignes
create or replace function public.save_template(p_id uuid, p_name text, p_steps jsonb)
returns uuid
language plpgsql
as $$
declare v_id uuid := p_id;
begin
  perform public.assert_owner();
  if coalesce(btrim(p_name), '') = '' then raise exception 'Le nom du modèle est obligatoire' using errcode = '22023'; end if;
  -- compatibilité v1 : un « channel » sans step_type est converti
  select jsonb_agg(case when s ? 'step_type' then s else s || jsonb_build_object('step_type',
           case s ->> 'channel' when 'linkedin' then 'linkedin_message' when 'email' then 'email' when 'phone' then 'call' else 'task' end) end)
    into p_steps from jsonb_array_elements(coalesce(p_steps, '[]')) s;
  perform public.validate_steps(coalesce(p_steps, '[]'));
  if v_id is null then
    insert into public.templates (name) values (btrim(p_name)) returning id into v_id;
  else
    update public.templates set name = btrim(p_name) where id = v_id;
    if not found then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
    delete from public.template_steps where template_id = v_id;
  end if;
  insert into public.template_steps (template_id, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, o::int, btrim(s ->> 'name'), s ->> 'step_type', public.step_channel(s ->> 'step_type'),
         coalesce(nullif(s ->> 'delay_days', '')::int, 0), nullif(btrim(coalesce(s ->> 'subject', '')), ''),
         nullif(coalesce(s ->> 'message', ''), ''), nullif(btrim(coalesce(s ->> 'instructions', '')), '')
    from jsonb_array_elements(p_steps) with ordinality as t(s, o);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Participants : inscription, préparation, activation
-- ---------------------------------------------------------------------------

-- Inscription « à préparer » : une entreprise n'apparaît qu'une fois, « Ne plus contacter » est exclu
create or replace function public.enroll_in_campaign(p_campaign uuid, p_company_ids uuid[] default '{}', p_list_ids uuid[] default '{}')
returns jsonb
language plpgsql
as $$
declare
  v_candidates uuid[];
  v_added int;
  v_blocked int;
  v_total int;
begin
  perform public.assert_owner();
  if not exists (select 1 from public.campaigns where id = p_campaign and status <> 'archived') then
    raise exception 'Campagne introuvable ou archivée' using errcode = 'P0002';
  end if;
  if cardinality(p_list_ids) > 0 then
    insert into public.campaign_lists (campaign_id, list_id) select p_campaign, l from unnest(p_list_ids) l on conflict do nothing;
  end if;
  select coalesce(array_agg(distinct c.id), '{}') into v_candidates
    from public.companies c
   where c.merged_into_id is null and c.archived_at is null
     and (c.id = any (p_company_ids)
          or c.id in (select company_id from public.list_members where list_id = any (p_list_ids)));
  v_total := cardinality(v_candidates);
  select count(*) into v_blocked from public.companies where id = any (v_candidates) and do_not_contact;

  insert into public.campaign_participants (campaign_id, company_id, person_id, status, next_due_date)
  select p_campaign, c.id,
         (select p.id from public.people p where p.company_id = c.id order by p.is_primary desc, p.created_at limit 1),
         'a_preparer', null
    from public.companies c
   where c.id = any (v_candidates) and not c.do_not_contact
  on conflict (campaign_id, company_id) do nothing;
  get diagnostics v_added = row_count;

  return jsonb_build_object('added', v_added, 'blocked', v_blocked, 'already_present', v_total - v_added - v_blocked);
end;
$$;

-- Sollicitations simultanées : autres participations actives des mêmes entreprises
create or replace function public.campaign_conflicts(p_campaign uuid)
returns table (participant_id uuid, company_id uuid, other_participant_id uuid, other_campaign_id uuid,
               other_campaign_name text, other_status text, other_last_done_at timestamptz, other_person_id uuid)
language sql
stable
as $$
  select cp.id, cp.company_id, o.id, oc.id, oc.name, o.status, o.last_done_at, o.person_id
    from public.campaign_participants cp
    join public.campaign_participants o on o.company_id = cp.company_id and o.campaign_id <> cp.campaign_id
    join public.campaigns oc on oc.id = o.campaign_id
   where cp.campaign_id = p_campaign
     and o.status in ('a_contacter', 'en_cours', 'a_repondu')
     and oc.status in ('active', 'paused');
$$;

-- « Activer » : rend les actions disponibles et calcule les échéances. Aucun message n'est envoyé.
create or replace function public.activate_participants(p_campaign uuid, p_ids uuid[], p_confirm_conflicts boolean default false)
returns jsonb
language plpgsql
as $$
declare
  c public.campaigns;
  v_conflicts jsonb;
  v_blocked int;
  v_activated int;
  v_first_delay int;
begin
  perform public.assert_owner();
  select * into c from public.campaigns where id = p_campaign for update;
  if not found or c.status = 'archived' then raise exception 'Campagne introuvable ou archivée' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.campaign_steps where campaign_id = c.id and version = c.current_version) then
    raise exception 'La séquence est vide : ajoutez au moins une étape' using errcode = '22023';
  end if;

  select count(*) into v_blocked from public.campaign_participants cp join public.companies co on co.id = cp.company_id
   where cp.id = any (p_ids) and cp.campaign_id = c.id and co.do_not_contact;

  select coalesce(jsonb_agg(jsonb_build_object('participant_id', k.participant_id, 'company_id', k.company_id,
           'company_name', co.name, 'other_campaign_id', k.other_campaign_id, 'other_campaign_name', k.other_campaign_name,
           'other_status', k.other_status, 'other_last_done_at', k.other_last_done_at, 'other_participant_id', k.other_participant_id)), '[]')
    into v_conflicts
    from public.campaign_conflicts(c.id) k join public.companies co on co.id = k.company_id
   where k.participant_id = any (p_ids);

  if jsonb_array_length(v_conflicts) > 0 and not p_confirm_conflicts then
    return jsonb_build_object('status', 'conflicts', 'conflicts', v_conflicts);
  end if;

  update public.campaign_participants cp
     set status = 'a_contacter',
         activated_at = now(),
         current_step = 1,
         next_due_date = public.today_paris() + coalesce((select delay_days from public.campaign_steps s
                          where s.campaign_id = c.id and s.version = cp.sequence_version and s.position = 1), 0)
   where cp.id = any (p_ids) and cp.campaign_id = c.id and cp.status = 'a_preparer'
     and not exists (select 1 from public.companies co where co.id = cp.company_id and co.do_not_contact);
  get diagnostics v_activated = row_count;

  if v_activated > 0 and c.status = 'draft' then
    update public.campaigns set status = 'active' where id = c.id;
  end if;
  return jsonb_build_object('status', 'activated', 'activated', v_activated, 'blocked', v_blocked,
                            'conflicts_confirmed', jsonb_array_length(v_conflicts));
end;
$$;

create or replace function public.save_participant_draft(p_participant uuid, p_position int, p_subject text, p_body text)
returns void
language plpgsql
as $$
declare cp public.campaign_participants;
begin
  perform public.assert_owner();
  select * into cp from public.campaign_participants where id = p_participant;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  if p_subject is null and p_body is null then
    delete from public.participant_drafts where participant_id = cp.id and sequence_version = cp.sequence_version and step_position = p_position;
    return;
  end if;
  insert into public.participant_drafts (participant_id, sequence_version, step_position, subject, body)
  values (cp.id, cp.sequence_version, p_position, p_subject, p_body)
  on conflict (participant_id, sequence_version, step_position)
  do update set subject = excluded.subject, body = excluded.body, updated_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Exécution des étapes
-- ---------------------------------------------------------------------------

create or replace function public.participant_state(cp public.campaign_participants)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('status', cp.status, 'current_step', cp.current_step, 'next_due_date', cp.next_due_date,
                            'last_done_at', cp.last_done_at, 'person_id', cp.person_id);
$$;

-- Réalise l'étape courante (envoi, appel, visite…). Une seule transaction : interaction,
-- avancement et prochaine échéance (calculée depuis la date réelle de réalisation).
create or replace function public.complete_step(
  p_participant uuid,
  p_content text default null,
  p_subject text default null,
  p_done_at timestamptz default null,
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
  v_at timestamptz := coalesce(p_done_at, now());
  v_person uuid;
  v_kind text;
  v_var text;
  v_interaction uuid;
  v_action uuid;
  v_before jsonb;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;

  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  select * into v_camp from public.campaigns where id = cp.campaign_id;
  if v_camp.status in ('paused', 'archived') then
    raise exception 'Campagne % : reprenez-la avant de réaliser une étape', case v_camp.status when 'paused' then 'en pause' else 'archivée' end
      using errcode = '22023';
  end if;
  if cp.status = 'a_preparer' then raise exception 'Ce participant n''est pas encore activé' using errcode = '22023'; end if;
  if cp.status in ('termine', 'arrete') then raise exception 'Le suivi de cette fiche est terminé ou arrêté' using errcode = '22023'; end if;
  if exists (select 1 from public.companies where id = cp.company_id and do_not_contact) then
    raise exception 'Fiche marquée « Ne plus contacter »' using errcode = '22023';
  end if;
  if v_at > now() + interval '1 day' then raise exception 'La date ne peut pas être dans le futur' using errcode = '22023'; end if;

  select * into st from public.campaign_steps
   where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step;
  if not found then raise exception 'Étape introuvable' using errcode = 'P0002'; end if;
  select * into nxt from public.campaign_steps
   where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step + 1;

  -- jamais de variable non remplacée dans un contenu réellement envoyé
  v_var := substring(coalesce(p_subject, '') || ' ' || coalesce(p_content, '') from '\{\{\s*[[:alnum:]_]+\s*\}\}');
  if v_var is not null then
    raise exception 'Variable non remplacée : % — complétez la fiche ou retirez-la du message', v_var using errcode = '22023';
  end if;
  v_kind := public.step_interaction_kind(st.step_type);
  if st.step_type in ('email', 'linkedin_message') and coalesce(btrim(p_content), '') = '' then
    raise exception 'Le contenu réellement envoyé est obligatoire' using errcode = '22023';
  end if;

  v_person := coalesce(p_person, cp.person_id);
  if v_person is not null and not exists (select 1 from public.people where id = v_person and company_id = cp.company_id) then
    raise exception 'Cette personne n''appartient pas à la fiche' using errcode = '22023';
  end if;

  insert into public.interactions (company_id, person_id, kind, channel, occurred_at, content, content_origin, source,
                                   campaign_participant_id, meta)
  values (cp.company_id, v_person, v_kind, st.channel, v_at,
          coalesce(nullif(btrim(p_content), ''), case when v_kind = 'prospecting' then st.name end), 'user',
          case when public.current_actor() = 'claude' then 'claude' else 'user' end, cp.id,
          jsonb_build_object('campaign_id', v_camp.id, 'campaign_name', v_camp.name, 'step_position', st.position,
                             'step_name', st.name, 'step_type', st.step_type, 'subject', nullif(btrim(p_subject), ''),
                             'sequence_version', cp.sequence_version))
  returning id into v_interaction;

  v_before := public.participant_state(cp);
  if nxt.id is not null then
    update public.campaign_participants
       set status = 'en_cours', current_step = nxt.position, last_done_at = v_at, person_id = v_person,
           next_due_date = (v_at at time zone 'Europe/Paris')::date + nxt.delay_days
     where id = cp.id returning * into cp;
  else
    update public.campaign_participants
       set status = 'termine', current_step = st.position + 1, last_done_at = v_at, person_id = v_person, next_due_date = null
     where id = cp.id returning * into cp;
  end if;

  insert into public.participant_actions (participant_id, action, step_position, interaction_id, prev_state, next_state)
  values (cp.id, 'done', st.position, v_interaction, v_before, public.participant_state(cp))
  returning id into v_action;

  if v_kind = 'message_out' or v_kind = 'call' then
    update public.companies set prospect_status = 'contacte' where id = cp.company_id and prospect_status = 'nouveau';
  end if;

  return public.idem_put(p_idempotency_key, 'complete_step', jsonb_build_object(
    'status', 'done', 'action_id', v_action, 'finished', nxt.id is null,
    'next_due_date', cp.next_due_date, 'next_step', case when nxt.id is null then null else nxt.position end));
end;
$$;

-- Ignorer une étape : passe à la suivante sans rien enregistrer comme envoyé (≠ arrêter le suivi)
create or replace function public.skip_step(p_participant uuid, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare
  v_prev jsonb;
  cp public.campaign_participants;
  st public.campaign_steps;
  nxt public.campaign_steps;
  v_before jsonb;
  v_action uuid;
  v_interaction uuid;
begin
  perform public.assert_owner();
  v_prev := public.idem_get(p_idempotency_key);
  if v_prev is not null then return v_prev; end if;
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;
  if cp.status not in ('a_contacter', 'en_cours') then raise exception 'Seul un suivi actif peut ignorer une étape' using errcode = '22023'; end if;
  select * into st from public.campaign_steps where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step;
  select * into nxt from public.campaign_steps where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step + 1;
  v_interaction := public.log_event(cp.company_id, 'prospecting', 'Étape ignorée : ' || coalesce(st.name, '?'),
    jsonb_build_object('campaign_id', cp.campaign_id, 'step_position', cp.current_step, 'skipped', true));
  update public.interactions set campaign_participant_id = cp.id where id = v_interaction;
  v_before := public.participant_state(cp);
  update public.campaign_participants
     set current_step = cp.current_step + 1,
         status = case when nxt.id is null then 'termine' else cp.status end,
         next_due_date = case when nxt.id is null then null else public.today_paris() + nxt.delay_days end
   where id = cp.id returning * into cp;
  insert into public.participant_actions (participant_id, action, step_position, interaction_id, prev_state, next_state)
  values (cp.id, 'skip', st.position, v_interaction, v_before, public.participant_state(cp)) returning id into v_action;
  return public.idem_put(p_idempotency_key, 'skip_step', jsonb_build_object('status', 'skipped', 'action_id', v_action, 'finished', nxt.id is null));
end;
$$;

-- Annulation courte : rétablit l'état précédent si rien n'a changé depuis
create or replace function public.undo_participant_action(p_action uuid)
returns jsonb
language plpgsql
as $$
declare
  a public.participant_actions;
  cp public.campaign_participants;
begin
  perform public.assert_owner();
  perform public.assert_not_claude('Annulation');
  select * into a from public.participant_actions where id = p_action for update;
  if not found then raise exception 'Action introuvable' using errcode = 'P0002'; end if;
  if a.undone_at is not null then return jsonb_build_object('status', 'already_undone'); end if;
  if a.created_at < now() - interval '15 minutes' then
    raise exception 'Délai d''annulation dépassé' using errcode = '22023';
  end if;
  select * into cp from public.campaign_participants where id = a.participant_id for update;
  if public.participant_state(cp) is distinct from a.next_state then
    raise exception 'Annulation impossible : ce suivi a été modifié depuis' using errcode = '22023';
  end if;
  update public.campaign_participants
     set status = a.prev_state ->> 'status',
         current_step = (a.prev_state ->> 'current_step')::int,
         next_due_date = nullif(a.prev_state ->> 'next_due_date', '')::date,
         last_done_at = nullif(a.prev_state ->> 'last_done_at', '')::timestamptz,
         person_id = nullif(a.prev_state ->> 'person_id', '')::uuid
   where id = cp.id;
  if a.interaction_id is not null then
    delete from public.interactions where id = a.interaction_id;
  end if;
  update public.participant_actions set undone_at = now() where id = a.id;
  return jsonb_build_object('status', 'undone');
end;
$$;

-- compatibilité : l'ancienne action « Marquer comme envoyé » passe par complete_step
create or replace function public.mark_step_sent(
  p_participant uuid, p_content text, p_sent_at timestamptz default null, p_person uuid default null, p_idempotency_key text default null)
returns jsonb
language plpgsql
as $$
declare r jsonb;
begin
  r := public.complete_step(p_participant, p_content, null, p_sent_at, p_person, p_idempotency_key);
  return jsonb_build_object('status', 'sent', 'finished', (r ->> 'finished')::boolean, 'action_id', r ->> 'action_id');
end;
$$;

create or replace function public.record_reply(
  p_participant uuid, p_content text, p_received_at timestamptz default null, p_person uuid default null, p_channel text default null)
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
   where campaign_id = cp.campaign_id and version = cp.sequence_version and position = greatest(cp.current_step - 1, 1);
  -- add_interaction suspend les relances actives de toute l'entreprise (tous ses contacts)
  v_res := public.add_interaction(cp.company_id, 'message_in', p_content, p_received_at,
                                  coalesce(p_person, cp.person_id), coalesce(p_channel, st.channel));
  update public.interactions set campaign_participant_id = cp.id where id = (v_res ->> 'id')::uuid;
  update public.campaign_participants set status = 'a_repondu', next_due_date = null
   where id = cp.id and status not in ('arrete');
  return jsonb_build_object('status', 'paused', 'paused_followups', (v_res ->> 'paused_followups')::int);
end;
$$;

-- Résultat commercial d'une participation (distinct du statut d'exécution et du statut CRM)
create or replace function public.set_participant_outcome(
  p_participant uuid, p_outcome text, p_stage uuid default null, p_note text default null)
returns jsonb
language plpgsql
as $$
declare
  cp public.campaign_participants;
  v_stopped int := 0;
  v_move jsonb;
begin
  perform public.assert_owner();
  if p_outcome not in ('replied', 'interested', 'not_interested', 'meeting', 'do_not_contact') then
    raise exception 'Résultat invalide' using errcode = '22023';
  end if;
  select * into cp from public.campaign_participants where id = p_participant for update;
  if not found then raise exception 'Participant introuvable' using errcode = 'P0002'; end if;

  update public.campaign_participants set outcome = p_outcome, outcome_at = now() where id = cp.id;

  if p_outcome in ('not_interested', 'do_not_contact') then
    update public.campaign_participants
       set status = 'arrete', next_due_date = null,
           stop_reason = case p_outcome when 'not_interested' then 'Pas intéressé' else 'Ne plus contacter' end
     where company_id = cp.company_id and status in ('a_preparer', 'a_contacter', 'en_cours', 'a_repondu');
    get diagnostics v_stopped = row_count;
    update public.companies set prospect_status = 'pas_interesse' where id = cp.company_id;
  end if;
  if p_outcome = 'do_not_contact' then
    update public.companies set do_not_contact = true, do_not_contact_at = now(),
           do_not_contact_reason = coalesce(nullif(btrim(p_note), ''), do_not_contact_reason)
     where id = cp.company_id;
  end if;
  if p_outcome = 'interested' then
    update public.companies set prospect_status = 'qualifie' where id = cp.company_id and prospect_status <> 'qualifie';
    if p_stage is not null then
      v_move := public.move_company(cp.company_id, p_stage, true, null);
    end if;
  end if;
  if p_outcome = 'meeting' then
    update public.companies set prospect_status = 'qualifie' where id = cp.company_id and prospect_status in ('nouveau','contacte','en_discussion');
  end if;

  perform public.log_event(cp.company_id, 'prospecting',
    case p_outcome
      when 'replied' then 'Résultat : a répondu'
      when 'interested' then 'Résultat : intéressé'
      when 'not_interested' then 'Résultat : pas intéressé — prospection arrêtée'
      when 'meeting' then 'Résultat : rendez-vous obtenu'
      else 'Ne plus contacter' || coalesce(' : ' || nullif(btrim(p_note), ''), '') end,
    jsonb_build_object('campaign_id', cp.campaign_id, 'participant_id', cp.id, 'outcome', p_outcome));

  return jsonb_build_object('status', 'ok', 'stopped', v_stopped, 'moved', v_move is not null);
end;
$$;

create or replace function public.set_do_not_contact(p_company uuid, p_value boolean, p_reason text default null)
returns void
language plpgsql
as $$
begin
  perform public.assert_owner();
  update public.companies
     set do_not_contact = p_value, do_not_contact_at = case when p_value then now() end,
         do_not_contact_reason = case when p_value then nullif(btrim(coalesce(p_reason, '')), '') end
   where id = p_company;
  if not found then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  if p_value then
    update public.campaign_participants set status = 'arrete', next_due_date = null, stop_reason = 'Ne plus contacter'
     where company_id = p_company and status in ('a_preparer', 'a_contacter', 'en_cours', 'a_repondu');
  end if;
  perform public.log_event(p_company, 'prospecting', case when p_value then 'Marquée « Ne plus contacter »' else '« Ne plus contacter » retiré' end);
end;
$$;

-- reprise / report : versions compatibles avec les séquences versionnées
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
    if cp.status not in ('a_contacter','en_cours') then raise exception 'Seul un suivi actif peut être reporté' using errcode = '22023'; end if;
    update public.campaign_participants set next_due_date = p_due where id = cp.id;
  elsif p_action = 'resume' then
    if exists (select 1 from public.companies where id = cp.company_id and do_not_contact) then
      raise exception 'Fiche marquée « Ne plus contacter »' using errcode = '22023';
    end if;
    if not exists (select 1 from public.campaign_steps where campaign_id = cp.campaign_id and version = cp.sequence_version and position = cp.current_step) then
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
  elsif p_action = 'unprepare' then
    if cp.status <> 'a_preparer' then raise exception 'Seul un participant à préparer peut être retiré' using errcode = '22023'; end if;
    delete from public.campaign_participants where id = cp.id;
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
-- Vues : file de travail et synthèse des campagnes
-- ---------------------------------------------------------------------------

create or replace view public.todo_items with (security_invoker = true) as
  select 'task'::text as item_type, t.id, t.company_id, c.name as company_name, t.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as person_name,
         t.title, t.due_date, null::uuid as campaign_id, null::text as campaign_name, null::text as channel,
         null::int as step_position, null::text as step_message,
         null::text as step_type, null::text as step_subject, null::text as step_instructions, null::int as sequence_version,
         null::int as step_count
    from public.tasks t
    join public.companies c on c.id = t.company_id
    left join public.people p on p.id = t.person_id
   where t.done_at is null and c.merged_into_id is null and c.archived_at is null
  union all
  select 'followup', cp.id, cp.company_id, c.name, cp.person_id,
         btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')),
         cs.name, cp.next_due_date, ca.id, ca.name, cs.channel, cs.position, cs.message,
         cs.step_type, cs.subject, cs.instructions, cp.sequence_version,
         (select count(*)::int from public.campaign_steps x where x.campaign_id = ca.id and x.version = cp.sequence_version)
    from public.campaign_participants cp
    join public.campaigns ca on ca.id = cp.campaign_id and ca.status = 'active'
    join public.companies c on c.id = cp.company_id
    join public.campaign_steps cs on cs.campaign_id = cp.campaign_id and cs.version = cp.sequence_version and cs.position = cp.current_step
    left join public.people p on p.id = cp.person_id
   where cp.status in ('a_contacter','en_cours') and cp.next_due_date is not null
     and c.merged_into_id is null and c.archived_at is null and not c.do_not_contact;

-- Synthèse par campagne, calculée uniquement à partir des événements enregistrés.
-- Une entreprise est comptée une seule fois par campagne (une participation par entreprise).
create or replace view public.campaign_overview with (security_invoker = true) as
  select ca.id, ca.name, ca.status, ca.current_version, ca.template_name, ca.created_at, ca.updated_at,
         coalesce((select array_agg(distinct s.channel) from public.campaign_steps s
                    where s.campaign_id = ca.id and s.version = ca.current_version), '{}') as channels,
         (select count(*) from public.campaign_steps s where s.campaign_id = ca.id and s.version = ca.current_version)::int as step_count,
         count(cp.id)::int as enrolled,
         count(*) filter (where cp.status = 'a_preparer')::int as to_prepare,
         count(*) filter (where cp.status in ('a_contacter','en_cours'))::int as in_progress,
         count(*) filter (where cp.status in ('a_contacter','en_cours') and cp.next_due_date = public.today_paris())::int as due_today,
         count(*) filter (where cp.status in ('a_contacter','en_cours') and cp.next_due_date < public.today_paris())::int as overdue,
         count(*) filter (where cp.last_done_at is not null or exists (
           select 1 from public.interactions i where i.campaign_participant_id = cp.id and i.kind in ('message_out','call')))::int as contacted,
         count(*) filter (where cp.outcome <> 'none' or cp.status = 'a_repondu' or exists (
           select 1 from public.interactions i where i.campaign_participant_id = cp.id and i.kind = 'message_in'))::int as replied,
         count(*) filter (where cp.outcome in ('interested','meeting'))::int as interested,
         count(*) filter (where cp.outcome = 'meeting')::int as meetings,
         count(*) filter (where cp.outcome in ('not_interested','do_not_contact'))::int as not_interested,
         count(*) filter (where cp.moved_to_pipeline_at is not null)::int as moved_to_pipeline,
         count(*) filter (where cp.status = 'termine')::int as finished,
         count(*) filter (where cp.status = 'arrete')::int as stopped,
         greatest(ca.updated_at, (select max(i.created_at) from public.interactions i
                                   join public.campaign_participants x on x.id = i.campaign_participant_id
                                  where x.campaign_id = ca.id)) as last_activity_at
    from public.campaigns ca
    left join public.campaign_participants cp on cp.campaign_id = ca.id
   group by ca.id;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke all on public.todo_items, public.company_overview, public.campaign_overview from anon;
grant select on public.todo_items, public.company_overview, public.campaign_overview to authenticated;

-- ---------------------------------------------------------------------------
-- Fonctions v1 mises à jour pour les nouvelles colonnes
-- ---------------------------------------------------------------------------

create or replace function public.create_campaign(p_name text, p_template uuid, p_list_ids uuid[] default '{}')
returns jsonb
language plpgsql
as $$
declare v_id uuid; v_res jsonb := '{}';
begin
  perform public.assert_owner();
  if not exists (select 1 from public.template_steps where template_id = p_template) then
    raise exception 'Le modèle ne contient aucune étape' using errcode = '22023';
  end if;
  v_id := public.create_campaign_draft(p_name, p_template);
  update public.campaigns set status = 'active' where id = v_id;
  if cardinality(p_list_ids) > 0 then
    v_res := public.add_lists_to_campaign(v_id, p_list_ids);
  end if;
  return jsonb_build_object('id', v_id) || v_res;
end;
$$;

create or replace function public.duplicate_template(p_id uuid)
returns uuid
language plpgsql
as $$
declare v_id uuid;
begin
  perform public.assert_owner();
  insert into public.templates (name) select name || ' (copie)' from public.templates where id = p_id returning id into v_id;
  if v_id is null then raise exception 'Modèle introuvable' using errcode = 'P0002'; end if;
  insert into public.template_steps (template_id, position, name, step_type, channel, delay_days, subject, message, instructions)
  select v_id, position, name, step_type, channel, delay_days, subject, message, instructions
    from public.template_steps where template_id = p_id;
  return v_id;
end;
$$;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
