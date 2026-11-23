-- Onboarding de l'offre découverte : « Je ne sais pas » et lien du site.
-- Migration additive, après 20261127100500. Les réponses déjà enregistrées restent valides : la case est décochée
-- par défaut (unknown = false) et aucune ligne existante n'est modifiée.
--
--   discovery_answers.unknown   le client a coché « Je ne sais pas » : la réponse est vide et la question ressort
--                               « à compléter avec le client » dans mon panneau. Une réponse saisie la décoche.
--   réponse « website_url »     lien du site saisi par le client (question 4). Format vérifié ici en dernière
--                               barrière ; il est recopié sur la fiche (companies.website) quand elle n'a pas de
--                               site, ou quand son site venait déjà de l'onboarding. Un site que j'ai saisi moi-même
--                               n'est jamais écrasé.
--
-- Accès inchangés : aucune écriture directe sur les tables, le client passe par portal_discovery_answer, qui
-- revérifie la session, l'appartenance au projet, la publication, l'archivage et la case « Offre découverte ».
-- La fonction garde ses six premiers paramètres ; le septième (p_unknown) a une valeur par défaut : une version
-- de l'application qui ne l'envoie pas continue de fonctionner.

alter table public.discovery_answers add column unknown boolean not null default false;
alter table public.discovery_answers add constraint discovery_answers_unknown_empty check (not unknown or value = '');

-- Contenu vu par un contact (ou par moi) : chaque réponse porte maintenant « unknown ».
create or replace function discovery_private.view(p_project uuid, p_person uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'project', jsonb_build_object('id', p.id, 'name', p.name, 'company', c.name,
                                  'read_only', coalesce((select read_only from portal_private.visible_projects(p_person) where project_id = p.id), p.status = 'archive')),
    'me', case when p_person is null then null else jsonb_build_object('id', p_person, 'first_name', (select first_name from public.people where id = p_person)) end,
    'settings', jsonb_build_object('lemlist_invite_email', (select lemlist_invite_email from public.discovery_settings where id)),
    'started_at', o.started_at, 'sent_at', o.sent_at, 'sent_by', discovery_private.person_name(o.sent_by),
    'position', (select screen from public.discovery_progress where project_id = p.id and person_id = p_person),
    'answers', coalesce((select jsonb_object_agg(a.key, jsonb_build_object('value', a.value, 'unknown', a.unknown, 'rev', a.rev,
                                                                          'by', discovery_private.person_name(a.updated_by),
                                                                          'mine', a.updated_by = p_person, 'at', a.updated_at))
                           from public.discovery_answers a where a.project_id = p.id), '{}'),
    'steps', coalesce((select jsonb_object_agg(s.step, jsonb_build_object('status', s.status, 'by', discovery_private.person_name(s.updated_by), 'at', s.updated_at))
                         from public.discovery_steps s where s.project_id = p.id), '{}'),
    'files', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'step', d.step, 'name', f.display_name, 'size', f.size_bytes, 'account', d.account_name,
                                                          'by', discovery_private.person_name(d.person_id), 'mine', d.person_id = p_person, 'at', d.created_at)
                                        order by d.created_at)
                         from public.discovery_files d join public.company_files f on f.id = d.file_id
                        where d.project_id = p.id and f.status = 'ready'), '[]'),
    'targets', coalesce((select jsonb_agg(jsonb_build_object(
                           'position', t.position, 'name', t.name, 'sector', t.sector, 'company_size', t.company_size, 'roles', t.roles,
                           'geography', t.geography, 'notes', t.notes, 'client_filled', to_jsonb(t.client_filled), 'rev', t.rev,
                           'validated_at', t.validated_at, 'validated_by', discovery_private.person_name(t.validated_by),
                           'modified_since_validation', t.modified_since_validation,
                           'comments', coalesce((select jsonb_agg(jsonb_build_object('id', cm.id, 'body', cm.body, 'by', discovery_private.person_name(cm.person_id),
                                                                                     'mine', cm.person_id = p_person, 'at', cm.created_at) order by cm.created_at)
                                                   from public.discovery_target_comments cm where cm.target_id = t.id), '[]'))
                         order by t.position)
                           from public.discovery_targets t where t.project_id = p.id), '[]'))
    from public.discovery_onboardings o
    join public.projects p on p.id = o.project_id
    join public.companies c on c.id = p.company_id
   where o.project_id = p_project;
$$;

-- Le site donné par le client arrive sur sa fiche, sans double saisie. p_before : lien précédent de l'onboarding.
create or replace function discovery_private.sync_website(p_project uuid, p_before text, p_after text)
returns void language plpgsql set search_path = '' as $$
declare v_company uuid; v_site text;
begin
  if coalesce(p_after, '') = '' then return; end if; -- lien retiré : la fiche garde ce qu'elle a
  select c.id, c.website into v_company, v_site from public.projects p join public.companies c on c.id = p.company_id
   where p.id = p_project for update of c;
  if v_site is not null and v_site is distinct from nullif(p_before, '') then return; end if; -- site saisi par moi : conservé
  update public.companies set website = p_after where id = v_company;
  insert into public.interactions (company_id, kind, content, content_origin, source, meta)
  values (v_company, 'system', 'Site web renseigné par le client (onboarding offre découverte)', 'system', 'user',
          jsonb_build_object('project_id', p_project));
end; $$;
revoke all on function discovery_private.sync_website(uuid, text, text) from public, anon, authenticated;

-- Réponse : p_base_rev = révision lue (0 si aucune). Révision dépassée → conflit, rien n'est écrit.
-- p_unknown : « Je ne sais pas ». Une réponse saisie l'emporte toujours (la case se décoche).
drop function public.portal_discovery_answer(text, text, uuid, text, text, int);
create function public.portal_discovery_answer(p_server_key text, p_session_hash text, p_project uuid, p_key text, p_value text, p_base_rev int,
                                               p_unknown boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_person uuid := portal_private.session_person(p_server_key, p_session_hash);
  a public.discovery_answers;
  v_value text := btrim(coalesce(p_value, ''));
  v_unknown boolean;
  v_shown text;
begin
  perform discovery_private.assert(v_person, p_project, true);
  if p_key !~ '^[a-z0-9_]{1,60}$' then raise exception 'Question inconnue' using errcode = '22023'; end if;
  if char_length(v_value) > 5000 then raise exception 'Réponse trop longue (5 000 caractères au plus)' using errcode = '22023'; end if;
  v_unknown := coalesce(p_unknown, false) and v_value = '' and p_key <> 'website_url';
  if p_key = 'website_url' and v_value <> '' and (char_length(v_value) > 300 or v_value !~* '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?([/?#][^\s]*)?$') then
    raise exception 'Lien de site invalide (exemple : https://www.exemple.fr)' using errcode = '22023';
  end if;
  v_shown := case when v_unknown then 'Je ne sais pas' else v_value end;
  select * into a from public.discovery_answers where project_id = p_project and key = p_key for update;
  if found then
    if a.value = v_value and a.unknown = v_unknown then return jsonb_build_object('ok', true, 'rev', a.rev); end if;
    if a.rev <> coalesce(p_base_rev, 0) then
      return jsonb_build_object('ok', false, 'conflict', true, 'value', a.value, 'unknown', a.unknown, 'rev', a.rev,
                                'by', discovery_private.person_name(a.updated_by), 'at', a.updated_at);
    end if;
    update public.discovery_answers set value = v_value, unknown = v_unknown, rev = a.rev + 1, updated_by = v_person, updated_at = now()
     where project_id = p_project and key = p_key;
    perform discovery_private.touch(p_project, v_person, 'answer', p_key, case when a.unknown then 'Je ne sais pas' else a.value end, v_shown);
    if p_key = 'website_url' then perform discovery_private.sync_website(p_project, a.value, v_value); end if;
    return jsonb_build_object('ok', true, 'rev', a.rev + 1);
  end if;
  if coalesce(p_base_rev, 0) <> 0 then
    raise exception 'Réponse introuvable : rechargez la page' using errcode = '22023';
  end if;
  if (select count(*) from public.discovery_answers where project_id = p_project) >= 60 then raise exception 'Trop de réponses' using errcode = '22023'; end if;
  insert into public.discovery_answers (project_id, key, value, unknown, updated_by) values (p_project, p_key, v_value, v_unknown, v_person);
  perform discovery_private.touch(p_project, v_person, 'answer', p_key, null, v_shown);
  if p_key = 'website_url' then perform discovery_private.sync_website(p_project, null, v_value); end if;
  return jsonb_build_object('ok', true, 'rev', 1);
end; $$;
revoke execute on function public.portal_discovery_answer(text, text, uuid, text, text, int, boolean) from public;
grant execute on function public.portal_discovery_answer(text, text, uuid, text, text, int, boolean) to anon;

-- Panneau de suivi (et connecteur Claude) : ajoute le site de la fiche, pour voir d'un coup d'œil si le lien donné
-- par le client y figure. Le reste est inchangé.
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
    'sent_task_id', o.sent_task_id,
    'company_id', (select company_id from public.projects where id = p_project),
    'company_website', (select c.website from public.projects p join public.companies c on c.id = p.company_id where p.id = p_project),
    'changes', coalesce((select jsonb_agg(jsonb_build_object('kind', x.kind, 'label', x.label, 'before', x.before, 'after', x.after,
                                                             'by', discovery_private.person_name(x.person_id), 'at', x.created_at) order by x.id desc)
                           from (select * from public.discovery_changes where project_id = p_project order by id desc limit 200) x), '[]'),
    'contacts', coalesce((select jsonb_agg(jsonb_build_object('id', pp.id, 'name', discovery_private.person_name(pp.id),
                                                              'position', (select screen from public.discovery_progress g where g.project_id = p_project and g.person_id = pp.id),
                                                              'seen_at', (select updated_at from public.discovery_progress g where g.project_id = p_project and g.person_id = pp.id)))
                            from public.project_members m join public.people pp on pp.id = m.person_id where m.project_id = p_project), '[]'));
end; $$;
