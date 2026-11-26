-- Connecteur Claude : ouverture de l'onboarding de l'offre découverte (écriture) et des appels et emails d'une
-- fiche (lecture). Migration additive, après 20261129090000. Aucune donnée existante n'est modifiée : les
-- réponses, étapes et fichiers déjà enregistrés gardent l'origine « client » (ils viennent tous du portail).
--
-- 1. Origine de chaque valeur de l'onboarding : client (portail), owner (moi) ou claude (proposition de Claude).
--    Elle est posée par un déclencheur, d'après la fonction qui écrit : le portail n'a pas à changer.
-- 2. Écritures côté propriétaire (elles n'existaient que côté client) : réponse, « je ne sais pas », lien du site,
--    étape, envoi, fichier. Une valeur saisie par le client ou par moi n'est remplacée que sur demande explicite
--    (p_overwrite), et la valeur remplacée est renvoyée.
-- 3. Case « Offre découverte », réglage lemlist et cibles : ouverts à un jeton Claude (contrôle du propriétaire
--    conservé). discovery_target_save gagne deux paramètres facultatifs : l'application actuelle continue de
--    fonctionner sans les envoyer.
-- 4. Journal : chaque écriture de Claude sur ces tables arrive dans activity_log.
-- 5. Lecture des appels Fireflies et des emails d'une fiche, sans dossier de diagnostic.
--
-- Rien ici n'envoie de message, ne supprime définitivement, ni ne contourne le contrôle du propriétaire.

-- ---------------------------------------------------------------------------
-- 1. Origine des valeurs
-- ---------------------------------------------------------------------------
alter table public.discovery_answers add column origin text not null default 'client' check (origin in ('client', 'owner', 'claude'));
alter table public.discovery_steps add column origin text not null default 'client' check (origin in ('client', 'owner', 'claude'));
alter table public.discovery_files add column origin text not null default 'client' check (origin in ('client', 'owner', 'claude'));
-- champs d'une cible dont la valeur actuelle a été proposée par Claude (pendant de client_filled)
alter table public.discovery_targets add column claude_filled text[] not null default '{}';
alter table public.discovery_onboardings add column sent_origin text check (sent_origin is null or sent_origin in ('client', 'owner', 'claude'));
update public.discovery_onboardings set sent_origin = 'client' where sent_at is not null;

-- Les fonctions du propriétaire annoncent leur origine pour la transaction ; sans annonce, c'est le portail.
create or replace function discovery_private.tg_origin()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.origin := case when current_setting('cely.discovery_origin', true) in ('owner', 'claude')
                     then current_setting('cely.discovery_origin', true) else 'client' end;
  return new;
end; $$;
create trigger discovery_origin before insert or update on public.discovery_answers for each row execute function discovery_private.tg_origin();
create trigger discovery_origin before insert or update on public.discovery_steps for each row execute function discovery_private.tg_origin();
create trigger discovery_origin before insert on public.discovery_files for each row execute function discovery_private.tg_origin();

-- Cible : un champ réécrit par Claude est marqué ; réécrit par quelqu'un d'autre (client ou moi), il ne l'est plus.
create or replace function discovery_private.tg_target_origin()
returns trigger language plpgsql set search_path = '' as $$
declare f text; v_new jsonb := to_jsonb(new); v_old jsonb := to_jsonb(old);
begin
  foreach f in array array['name', 'sector', 'company_size', 'roles', 'geography', 'notes'] loop
    if (v_new ->> f) is distinct from (v_old ->> f) then
      new.claude_filled := array_remove(new.claude_filled, f);
      if current_setting('cely.discovery_origin', true) = 'claude' and (v_new ->> f) <> '' then
        new.claude_filled := new.claude_filled || f;
      end if;
    end if;
  end loop;
  return new;
end; $$;
create trigger discovery_target_origin before update on public.discovery_targets for each row execute function discovery_private.tg_target_origin();

-- Contrôle commun des écritures du propriétaire : propriétaire connecté, onboarding existant, origine annoncée.
create or replace function discovery_private.owner_begin(p_project uuid, p_origin text)
returns text language plpgsql set search_path = '' as $$
declare v_origin text := case when p_origin = 'claude' then 'claude' else 'owner' end;
begin
  perform public.assert_owner();
  if not exists (select 1 from public.discovery_onboardings where project_id = p_project) then
    raise exception 'Onboarding introuvable : cochez d''abord « Offre découverte » sur ce projet' using errcode = 'P0002';
  end if;
  perform set_config('cely.discovery_origin', v_origin, true);
  return v_origin;
end; $$;

-- ---------------------------------------------------------------------------
-- 2. Écritures du propriétaire
-- ---------------------------------------------------------------------------

-- Réponse à une question (ou lien du site, clé « website_url »). Une réponse non vide saisie par le client ou par
-- moi n'est pas remplacée sans p_overwrite : la fonction renvoie alors la valeur en place et n'écrit rien.
create or replace function public.discovery_answer_save(p_project uuid, p_key text, p_value text, p_unknown boolean default false,
                                                        p_origin text default 'owner', p_overwrite boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_origin text := discovery_private.owner_begin(p_project, p_origin);
  a public.discovery_answers;
  v_value text := btrim(coalesce(p_value, ''));
  v_unknown boolean;
  v_current jsonb;
  v_company uuid;
  v_site text;
  v_fiche text;
  v_rev int;
begin
  if p_key !~ '^[a-z0-9_]{1,60}$' then raise exception 'Question inconnue' using errcode = '22023'; end if;
  if char_length(v_value) > 5000 then raise exception 'Réponse trop longue (5 000 caractères au plus)' using errcode = '22023'; end if;
  v_unknown := coalesce(p_unknown, false) and v_value = '' and p_key <> 'website_url';
  if p_key = 'website_url' and v_value <> '' and (char_length(v_value) > 300 or v_value !~* '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?([/?#][^\s]*)?$') then
    raise exception 'Lien de site invalide (exemple : https://www.exemple.fr)' using errcode = '22023';
  end if;
  select * into a from public.discovery_answers where project_id = p_project and key = p_key for update;
  if found then
    if a.value = v_value and a.unknown = v_unknown then return jsonb_build_object('status', 'unchanged', 'rev', a.rev, 'origin', a.origin); end if;
    v_current := jsonb_build_object('value', a.value, 'unknown', a.unknown, 'origin', a.origin,
                                    'by', discovery_private.person_name(a.updated_by), 'at', a.updated_at);
    if a.value <> '' and a.origin <> 'claude' and not coalesce(p_overwrite, false) then
      return jsonb_build_object('status', 'kept', 'current', v_current);
    end if;
    update public.discovery_answers set value = v_value, unknown = v_unknown, rev = a.rev + 1, updated_by = null, updated_at = now()
     where project_id = p_project and key = p_key;
    v_rev := a.rev + 1;
  else
    if (select count(*) from public.discovery_answers where project_id = p_project) >= 60 then raise exception 'Trop de réponses' using errcode = '22023'; end if;
    insert into public.discovery_answers (project_id, key, value, unknown, updated_by) values (p_project, p_key, v_value, v_unknown, null);
    v_rev := 1;
  end if;
  -- lien du site : recopié sur la fiche si elle n'en a pas, ou si son site venait déjà de l'onboarding
  if p_key = 'website_url' and v_value <> '' then
    select c.id, c.website into v_company, v_site from public.projects p join public.companies c on c.id = p.company_id
     where p.id = p_project for update of c;
    if v_site is null or v_site is not distinct from nullif(a.value, '') then
      update public.companies set website = v_value where id = v_company and website is distinct from v_value;
      v_fiche := 'site recopié sur la fiche';
    else
      v_fiche := 'la fiche garde son site actuel : ' || v_site;
    end if;
  end if;
  return jsonb_build_object('status', 'saved', 'rev', v_rev, 'origin', v_origin, 'replaced', v_current, 'fiche', v_fiche);
end; $$;

-- Étape : done (terminée), none (rien à fournir), later (plus tard) ou null (remise à zéro).
create or replace function public.discovery_step_save(p_project uuid, p_step text, p_status text, p_origin text default 'owner', p_overwrite boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_origin text := discovery_private.owner_begin(p_project, p_origin);
  s public.discovery_steps;
  v_current jsonb;
begin
  if p_step not in ('welcome', 'offer', 'lemlist', 'blacklist', 'linkedin', 'documents', 'targets') then raise exception 'Étape inconnue' using errcode = '22023'; end if;
  if p_status is not null and p_status not in ('done', 'none', 'later') then raise exception 'État inconnu' using errcode = '22023'; end if;
  select * into s from public.discovery_steps where project_id = p_project and step = p_step for update;
  if found then
    if s.status = p_status then return jsonb_build_object('status', 'unchanged', 'origin', s.origin); end if;
    v_current := jsonb_build_object('status', s.status, 'origin', s.origin, 'by', discovery_private.person_name(s.updated_by), 'at', s.updated_at);
    if s.origin <> 'claude' and not coalesce(p_overwrite, false) then return jsonb_build_object('status', 'kept', 'current', v_current); end if;
  elsif p_status is null then
    return jsonb_build_object('status', 'unchanged');
  end if;
  if p_status is null then
    delete from public.discovery_steps where project_id = p_project and step = p_step;
  else
    insert into public.discovery_steps (project_id, step, status, updated_by) values (p_project, p_step, p_status, null)
    on conflict (project_id, step) do update set status = excluded.status, updated_by = null, updated_at = now();
  end if;
  return jsonb_build_object('status', 'saved', 'origin', v_origin, 'replaced', v_current);
end; $$;

-- Étape « récapitulatif » : l'onboarding est marqué envoyé sans passer par le client (p_sent = false annule un
-- envoi que j'ai marqué moi-même ; un envoi fait par le client ne s'annule pas).
create or replace function public.discovery_mark_sent(p_project uuid, p_sent boolean, p_origin text default 'owner')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_origin text := discovery_private.owner_begin(p_project, p_origin);
  o public.discovery_onboardings;
begin
  select * into o from public.discovery_onboardings where project_id = p_project for update;
  if coalesce(p_sent, true) then
    if o.sent_at is not null then
      return jsonb_build_object('status', 'unchanged', 'sent_at', o.sent_at, 'sent_origin', o.sent_origin, 'sent_by', discovery_private.person_name(o.sent_by));
    end if;
    update public.discovery_onboardings set sent_at = now(), sent_by = null, sent_origin = v_origin where project_id = p_project;
    perform portal_private.log(p_project, 'owner', null, 'discovery_sent', jsonb_build_object('origin', v_origin));
    return jsonb_build_object('status', 'saved', 'sent_at', now(), 'sent_origin', v_origin);
  end if;
  if o.sent_at is null then return jsonb_build_object('status', 'unchanged'); end if;
  if o.sent_origin = 'client' then raise exception 'Cet onboarding a été envoyé par le client : l''envoi ne s''annule pas' using errcode = '22023'; end if;
  update public.discovery_onboardings set sent_at = null, sent_by = null, sent_origin = null where project_id = p_project;
  perform portal_private.log(p_project, 'owner', null, 'discovery_unsent', jsonb_build_object('origin', v_origin));
  return jsonb_build_object('status', 'saved', 'sent_at', null);
end; $$;

-- Fichier : un document déjà déposé sur la fiche du projet (envoi vérifié) est rattaché à une étape de
-- l'onboarding et rangé dans le dossier interne « Onboarding offre découverte ».
create or replace function public.discovery_file_attach(p_project uuid, p_step text, p_file uuid, p_account text default null, p_origin text default 'owner')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_origin text := discovery_private.owner_begin(p_project, p_origin);
  f public.company_files;
  v_id uuid;
begin
  select cf.* into f from public.company_files cf join public.projects p on p.company_id = cf.company_id
   where cf.id = p_file and p.id = p_project and cf.status = 'ready';
  if not found then raise exception 'Document introuvable sur la fiche de ce projet (envoi non confirmé ?)' using errcode = 'P0002'; end if;
  select id into v_id from public.discovery_files where file_id = p_file;
  if v_id is not null then return jsonb_build_object('status', 'unchanged', 'id', v_id); end if;
  perform discovery_private.file_rules(p_step, f.mime_type, f.size_bytes);
  if p_step = 'linkedin' and coalesce(btrim(p_account), '') = '' then raise exception 'Indiquez à qui appartient ce compte LinkedIn' using errcode = '22023'; end if;
  if (select count(*) from public.discovery_files where project_id = p_project) >= 100 then raise exception 'Nombre maximal de fichiers atteint' using errcode = '22023'; end if;
  insert into public.project_files (project_id, file_id, folder_id, shared_by_kind)
  values (p_project, p_file, discovery_private.folder(p_project), 'owner')
  on conflict (project_id, file_id) do nothing;
  insert into public.discovery_files (project_id, step, file_id, account_name, person_id)
  values (p_project, p_step, p_file, nullif(left(btrim(coalesce(p_account, '')), 120), ''), null)
  returning id into v_id;
  perform portal_private.log(p_project, 'owner', null, 'discovery_file', jsonb_build_object('file_id', p_file, 'step', p_step, 'origin', v_origin));
  return jsonb_build_object('status', 'saved', 'id', v_id, 'origin', v_origin, 'name', f.display_name);
end; $$;

-- Retirer de l'onboarding un fichier que le client n'a pas déposé : le document reste sur la fiche et dans le projet.
create or replace function public.discovery_file_detach(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.discovery_files; v_name text;
begin
  perform public.assert_owner();
  select * into d from public.discovery_files where id = p_id;
  if not found then raise exception 'Fichier introuvable' using errcode = 'P0002'; end if;
  if d.origin = 'client' then raise exception 'Ce fichier a été déposé par le client : il se retire depuis son espace' using errcode = '22023'; end if;
  select display_name into v_name from public.company_files where id = d.file_id;
  delete from public.discovery_files where id = p_id;
  perform portal_private.log(d.project_id, 'owner', null, 'discovery_file_removed', jsonb_build_object('file_id', d.file_id, 'step', d.step));
  return jsonb_build_object('status', 'saved', 'name', v_name);
end; $$;

-- ---------------------------------------------------------------------------
-- 3. Case, réglage et cibles : ouverts à Claude (le contrôle du propriétaire reste)
-- ---------------------------------------------------------------------------
create or replace function public.discovery_set_enabled(p_project uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  if not exists (select 1 from public.projects where id = p_project) then raise exception 'Projet introuvable' using errcode = 'P0002'; end if;
  perform discovery_private.ensure(p_project, p_enabled, 'owner');
  -- décocher masque l'onglet : réponses, fichiers et cibles sont conservés
  update public.discovery_onboardings set enabled = p_enabled, enabled_source = 'owner' where project_id = p_project and enabled is distinct from p_enabled;
  if found then perform portal_private.log(p_project, 'owner', null, case when p_enabled then 'discovery_enabled' else 'discovery_disabled' end); end if;
  return jsonb_build_object('enabled', p_enabled);
end; $$;

create or replace function public.discovery_settings_save(p_lemlist_invite_email text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  update public.discovery_settings set lemlist_invite_email = nullif(btrim(lower(p_lemlist_invite_email)), ''), updated_at = now() where id;
end; $$;

-- Cibles. Une cible déjà validée par le client et modifiée ici perd sa validation et s'affiche « Modifiée depuis ta
-- validation ». p_overwrite = false (connecteur Claude) : si un champ non vide saisi par le client ou par moi
-- changerait, rien n'est écrit et les champs concernés sont renvoyés dans « kept ».
drop function public.discovery_target_save(uuid, int, jsonb);
create function public.discovery_target_save(p_project uuid, p_position int, p_data jsonb, p_origin text default 'owner', p_overwrite boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_origin text := discovery_private.owner_begin(p_project, p_origin);
  t public.discovery_targets; n public.discovery_targets; f text;
  v_old jsonb; v_new jsonb;
  v_kept jsonb := '[]'; v_replaced jsonb := '[]';
begin
  if p_position not between 1 and 3 then raise exception 'Cible inconnue' using errcode = '22023'; end if;
  perform discovery_private.ensure(p_project, false, 'owner');
  select * into t from public.discovery_targets where project_id = p_project and position = p_position for update;
  n := t;
  n.name := btrim(coalesce(p_data ->> 'name', t.name));
  n.sector := btrim(coalesce(p_data ->> 'sector', t.sector));
  n.company_size := btrim(coalesce(p_data ->> 'company_size', t.company_size));
  n.roles := btrim(coalesce(p_data ->> 'roles', t.roles));
  n.geography := btrim(coalesce(p_data ->> 'geography', t.geography));
  n.notes := btrim(coalesce(p_data ->> 'notes', t.notes));
  if (n.name, n.sector, n.company_size, n.roles, n.geography, n.notes) is not distinct from (t.name, t.sector, t.company_size, t.roles, t.geography, t.notes) then
    return jsonb_build_object('rev', t.rev, 'changed', false);
  end if;
  v_old := to_jsonb(t); v_new := to_jsonb(n);
  foreach f in array array['name', 'sector', 'company_size', 'roles', 'geography', 'notes'] loop
    if (v_new ->> f) is distinct from (v_old ->> f) and (v_old ->> f) <> '' and not (f = any (t.claude_filled)) then
      if coalesce(p_overwrite, true) then
        v_replaced := v_replaced || jsonb_build_object('field', f, 'before', v_old ->> f, 'origin', case when f = any (t.client_filled) then 'client' else 'owner' end);
      else
        v_kept := v_kept || jsonb_build_object('field', f, 'current', v_old ->> f, 'origin', case when f = any (t.client_filled) then 'client' else 'owner' end);
      end if;
    end if;
  end loop;
  if jsonb_array_length(v_kept) > 0 then
    return jsonb_build_object('rev', t.rev, 'changed', false, 'kept', v_kept);
  end if;
  -- un champ que je réécris n'est plus « rempli par le client »
  foreach f in array t.client_filled loop
    if (v_new ->> f) is distinct from (v_old ->> f) then n.client_filled := array_remove(n.client_filled, f); end if;
  end loop;
  update public.discovery_targets
     set name = n.name, sector = n.sector, company_size = n.company_size, roles = n.roles, geography = n.geography, notes = n.notes,
         client_filled = n.client_filled, rev = t.rev + 1, owner_updated_at = now(), updated_at = now(),
         modified_since_validation = t.validated_at is not null or t.modified_since_validation,
         validated_at = null, validated_by = null
   where id = t.id;
  return jsonb_build_object('rev', t.rev + 1, 'changed', true, 'validation_dropped', t.validated_at is not null, 'origin', v_origin, 'replaced', v_replaced);
end; $$;

-- Panneau de suivi et connecteur : ajoute l'origine de chaque valeur (« origins »). Le contenu vu par le client
-- (discovery_private.view) est inchangé : il ne voit pas ces origines.
create or replace function public.discovery_admin(p_project uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.discovery_onboardings;
begin
  perform public.assert_owner();
  select * into o from public.discovery_onboardings where project_id = p_project;
  if not found then
    return jsonb_build_object('exists', false, 'enabled', false,
      'suggested', exists (select 1 from public.sales s join public.finance_missions m on m.id = s.mission_id
                            where s.project_id = p_project and m.label ~* 'd[ée]couverte'));
  end if;
  return discovery_private.view(p_project, null) || jsonb_build_object(
    'exists', true, 'enabled', o.enabled, 'enabled_source', o.enabled_source, 'changed_after_send_at', o.changed_after_send_at,
    'sent_task_id', o.sent_task_id, 'sent_origin', o.sent_origin,
    'company_id', (select company_id from public.projects where id = p_project),
    'company_website', (select c.website from public.projects p join public.companies c on c.id = p.company_id where p.id = p_project),
    'origins', jsonb_build_object(
      'answers', coalesce((select jsonb_object_agg(a.key, a.origin) from public.discovery_answers a where a.project_id = p_project), '{}'),
      'steps', coalesce((select jsonb_object_agg(s.step, s.origin) from public.discovery_steps s where s.project_id = p_project), '{}'),
      'files', coalesce((select jsonb_object_agg(d.id, d.origin) from public.discovery_files d where d.project_id = p_project), '{}'),
      'targets', coalesce((select jsonb_object_agg(t.position, to_jsonb(t.claude_filled)) from public.discovery_targets t where t.project_id = p_project), '{}')),
    'changes', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'label', x.label, 'before', x.before, 'after', x.after,
                                                             'by', discovery_private.person_name(x.person_id), 'at', x.created_at) order by x.id desc)
                           from (select * from public.discovery_changes where project_id = p_project order by id desc limit 200) x), '[]'),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', pp.id, 'name', discovery_private.person_name(pp.id),
                                                              'position', (select screen from public.discovery_progress g where g.project_id = p_project and g.person_id = pp.id),
                                                              'seen_at', (select updated_at from public.discovery_progress g where g.project_id = p_project and g.person_id = pp.id)))
                            from public.project_members m join public.people pp on pp.id = m.person_id where m.project_id = p_project), '[]'));
end; $$;

-- ---------------------------------------------------------------------------
-- 4. Journal des écritures de Claude sur l'onboarding
-- ---------------------------------------------------------------------------
create or replace function discovery_private.tg_claude_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_row jsonb; v_project uuid;
begin
  if public.current_actor() <> 'claude' then return null; end if;
  v_row := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_project := (v_row ->> 'project_id')::uuid;
  insert into public.activity_log (actor, table_name, operation, row_id, company_id, summary, data)
  values ('claude', tg_table_name, tg_op,
          case when tg_table_name in ('discovery_files', 'discovery_targets') then (v_row ->> 'id')::uuid else v_project end,
          (select company_id from public.projects where id = v_project),
          'origine : ' || coalesce(nullif(current_setting('cely.discovery_origin', true), ''), 'owner'), v_row);
  return null;
end; $$;

do $$
declare t text;
begin
  foreach t in array array['discovery_onboardings', 'discovery_answers', 'discovery_steps', 'discovery_files', 'discovery_targets', 'discovery_settings'] loop
    execute format('create trigger claude_log after insert or update or delete on public.%I for each row execute function discovery_private.tg_claude_log()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Appels Fireflies et emails d'une fiche, en lecture (mêmes contenus que pour un dossier de diagnostic)
-- ---------------------------------------------------------------------------
create or replace function public.company_calls(p_company uuid, p_before timestamptz, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'titre', c.title, 'date', c.occurred_at, 'duree_minutes', c.duration_minutes, 'participants', c.participants,
      'resume', c.summary, 'etat_resume', c.summary_state, 'note_interne', c.internal_note, 'lignes_transcription', c.line_count
    ) order by c.occurred_at desc nulls last), '[]')
    from (
      select * from public.fireflies_calls
       where company_id = p_company and link_state = 'linked' and (p_before is null or occurred_at < p_before)
       order by occurred_at desc nulls last limit least(greatest(p_limit, 1), 50)
    ) c
  );
end; $$;

create or replace function public.company_call_transcript(p_company uuid, p_call uuid, p_offset integer, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_lines jsonb;
begin
  perform public.assert_owner();
  select t.lines into v_lines
    from public.fireflies_calls c
    left join public.fireflies_call_transcripts t on t.call_id = c.id
   where c.id = p_call and c.company_id = p_company and c.link_state = 'linked';
  if not found then raise exception 'Appel introuvable sur cette fiche' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'total', coalesce(jsonb_array_length(v_lines), 0),
    'lignes', coalesce((
      select jsonb_agg(e order by ord)
        from jsonb_array_elements(coalesce(v_lines, '[]')) with ordinality as t(e, ord)
       where ord > greatest(p_offset, 0) and ord <= greatest(p_offset, 0) + least(greatest(p_limit, 1), 1000)
    ), '[]')
  );
end; $$;

-- Emails de la fiche : envoyés depuis le CRM (acceptés) et reçus rattachés à la fiche.
create or replace function public.company_mail_list(p_company uuid, p_before timestamptz, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform public.assert_owner();
  if not exists (select 1 from public.companies where id = p_company) then raise exception 'Fiche introuvable' using errcode = 'P0002'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'sens', case m.direction when 'in' then 'reçu' else 'envoyé' end, 'date', m.at, 'de', m.from_addr, 'a', m.to_addrs, 'cc', m.cc_addrs,
      'objet', m.subject, 'fil', m.provider_thread_id, 'apercu', left(m.body_text, 400)
    ) order by m.at desc), '[]')
    from (
      select x.*, coalesce(x.sent_at, x.received_at, x.created_at) as at from public.mail_messages x
       where x.company_id = p_company
         and ((x.direction = 'out' and x.status = 'accepted') or (x.direction = 'in' and x.status = 'received' and x.link_state = 'linked'))
         and (p_before is null or coalesce(x.sent_at, x.received_at, x.created_at) < p_before)
       order by coalesce(x.sent_at, x.received_at, x.created_at) desc limit least(greatest(p_limit, 1), 100)
    ) m
  );
end; $$;

create or replace function public.company_mail_thread(p_company uuid, p_mail uuid, p_offset integer, p_limit integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_thread text;
begin
  perform public.assert_owner();
  select provider_thread_id into v_thread from public.mail_messages
   where id = p_mail and company_id = p_company
     and ((direction = 'out' and status = 'accepted') or (direction = 'in' and status = 'received' and link_state = 'linked'));
  if not found then raise exception 'Email introuvable sur cette fiche' using errcode = 'P0002'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id, 'sens', case m.direction when 'in' then 'reçu' else 'envoyé' end, 'date', m.at, 'de', m.from_addr, 'a', m.to_addrs, 'cc', m.cc_addrs,
      'objet', m.subject, 'corps', m.body_text
    ) order by m.at), '[]')
    from (
      select x.*, coalesce(x.sent_at, x.received_at, x.created_at) as at from public.mail_messages x
       where x.company_id = p_company
         and ((x.direction = 'out' and x.status = 'accepted') or (x.direction = 'in' and x.status = 'received' and x.link_state = 'linked'))
         and (x.id = p_mail or (v_thread is not null and x.provider_thread_id = v_thread))
       order by coalesce(x.sent_at, x.received_at, x.created_at) offset greatest(p_offset, 0) limit least(greatest(p_limit, 1), 20)
    ) m
  );
end; $$;

-- ---------------------------------------------------------------------------
-- Droits : fonctions réservées au propriétaire connecté (jamais anon) ; fonctions privées fermées à l'API.
-- ---------------------------------------------------------------------------
revoke all on all functions in schema discovery_private from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'discovery_answer_save(uuid, text, text, boolean, text, boolean)', 'discovery_step_save(uuid, text, text, text, boolean)',
    'discovery_mark_sent(uuid, boolean, text)', 'discovery_file_attach(uuid, text, uuid, text, text)', 'discovery_file_detach(uuid)',
    'discovery_set_enabled(uuid, boolean)', 'discovery_settings_save(text)', 'discovery_target_save(uuid, int, jsonb, text, boolean)',
    'discovery_admin(uuid)',
    'company_calls(uuid, timestamptz, integer)', 'company_call_transcript(uuid, uuid, integer, integer)',
    'company_mail_list(uuid, timestamptz, integer)', 'company_mail_thread(uuid, uuid, integer, integer)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- L'API relit la liste des fonctions (sans effet hors Supabase).
notify pgrst, 'reload schema';
