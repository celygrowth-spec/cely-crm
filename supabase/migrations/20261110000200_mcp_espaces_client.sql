-- Connecteur Claude : ouvre les espaces client (module Projets) à un jeton Claude. Migration additive.
-- N'ouvre que ce que les outils MCP utilisent. Restent réservés à l'application :
--   - générer un code d'accès (portal_access_issue) : le code apparaîtrait en clair dans la conversation ;
--   - supprimer un projet, supprimer définitivement un fichier (company_files, Storage) ;
--   - créer, reporter ou annuler un rendez-vous (module Rendez-vous, Google Agenda) ;
--   - tout le reste du CRM : aucun droit n'y change.

-- ---------------------------------------------------------------------------
-- Fonctions : seules celles-ci acceptent Claude. Leur corps actuel est repris tel quel, seul le contrôle
-- change (assert_owner garde la vérification du propriétaire). Un nom absent ou déjà modifié fait échouer
-- la migration, plutôt que d'ouvrir moins (ou autre chose) que prévu.
-- ---------------------------------------------------------------------------
do $$
declare
  v_name text;
  v_oid oid;
  v_def text;
  v_new text;
  v_seen int;
begin
  foreach v_name in array array[
    'project_create', 'project_add_member', 'project_remove_member',
    'portal_access_set_expiry', 'portal_access_revoke',
    'project_link_meeting', 'project_publish_recap', 'project_idea_to_task',
    'project_folder_save', 'project_files_move', 'project_folder_delete',
    'portal_preview_project', 'portal_preview_meeting']
  loop
    v_seen := 0;
    for v_oid in select oid from pg_proc where pronamespace = 'public'::regnamespace and proname = v_name
    loop
      v_seen := v_seen + 1;
      v_def := pg_get_functiondef(v_oid);
      v_new := replace(v_def, 'perform portal_private.assert_owner_user();', 'perform public.assert_owner();');
      if v_new = v_def then raise exception 'Contrôle introuvable dans %', v_name; end if;
      execute v_new;
    end loop;
    if v_seen <> 1 then raise exception 'Fonction % : % définition(s), une seule attendue', v_name, v_seen; end if;
  end loop;

  -- L'historique de la fiche indique qui a créé le projet.
  v_def := pg_get_functiondef('public.project_create(jsonb, uuid[])'::regprocedure);
  v_new := replace(v_def, $s$'system', 'user', jsonb_build_object('project_id', v_id)$s$,
                   $s$'system', case when public.current_actor() = 'claude' then 'claude' else 'user' end, jsonb_build_object('project_id', v_id)$s$);
  if v_new = v_def then raise exception 'Historique introuvable dans project_create'; end if;
  execute v_new;
end $$;

-- ---------------------------------------------------------------------------
-- RLS : écritures directes des outils. La suppression d'un projet, les membres, les dossiers et les accès
-- restent fermés ici : ils passent par les fonctions ci-dessus, qui appliquent leurs propres règles.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['project_phases','project_milestones','meeting_recaps','project_tasks','project_task_comments','project_files','project_ideas','project_idea_comments']
  loop
    execute format('drop policy owner_insert on public.%I', t);
    execute format('create policy owner_insert on public.%I for insert to authenticated with check ((select public.is_app_owner()))', t);
  end loop;
  foreach t in array array['projects','project_phases','project_milestones','project_meetings','meeting_recaps','project_tasks','project_ideas']
  loop
    execute format('drop policy owner_update on public.%I', t);
    execute format('create policy owner_update on public.%I for update to authenticated using ((select public.is_app_owner())) with check ((select public.is_app_owner()))', t);
  end loop;
  foreach t in array array['project_phases','project_milestones','project_meetings','project_tasks','project_files']
  loop
    execute format('drop policy owner_delete on public.%I', t);
    execute format('create policy owner_delete on public.%I for delete to authenticated using ((select public.is_app_owner()))', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Journal : chaque écriture de Claude dans un espace client, rattachée à la fiche quand elle est encore
-- connue. Ni empreinte de code d'accès, ni chemin de stockage dans le journal.
-- ---------------------------------------------------------------------------
create or replace function portal_private.tg_claude_log()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_project uuid;
  v_company uuid;
begin
  if public.current_actor() <> 'claude' then
    return null;
  end if;
  v_row := (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) - 'code_hash' - 'code_hint' - 'storage_path';
  v_company := nullif(v_row ->> 'company_id', '')::uuid;
  if v_company is null then
    v_project := case tg_table_name
      when 'projects' then (v_row ->> 'id')::uuid
      when 'meeting_recaps' then (select project_id from public.project_meetings where id = (v_row ->> 'meeting_id')::uuid)
      when 'project_task_comments' then (select project_id from public.project_tasks where id = (v_row ->> 'task_id')::uuid)
      when 'project_idea_comments' then (select project_id from public.project_ideas where id = (v_row ->> 'idea_id')::uuid)
      else nullif(v_row ->> 'project_id', '')::uuid end;
    if tg_table_name = 'portal_accesses' then
      select company_id into v_company from public.people where id = (v_row ->> 'person_id')::uuid;
    else
      select company_id into v_company from public.projects where id = v_project;
    end if;
  end if;
  insert into public.activity_log (actor, table_name, operation, row_id, company_id, summary, data)
  values ('claude', tg_table_name, tg_op, coalesce(v_row ->> 'id', v_row ->> 'meeting_id')::uuid, v_company,
          coalesce(current_setting('crm.claude_summary', true), ''), v_row);
  return null;
end; $$;

do $$
declare t text;
begin
  foreach t in array array[
    'projects','project_members','project_phases','project_milestones','project_meetings','meeting_recaps','project_tasks',
    'project_task_comments','project_folders','project_files','project_ideas','project_idea_comments','portal_accesses','company_files']
  loop
    execute format('create trigger claude_log after insert or update or delete on public.%I for each row execute function portal_private.tg_claude_log()', t);
  end loop;
end $$;

revoke all on function portal_private.tg_claude_log() from public, anon, authenticated;
