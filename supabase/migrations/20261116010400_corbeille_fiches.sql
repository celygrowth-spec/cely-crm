-- Corbeille, lot 4 : fiches (entreprises, contacts) et ventes associées.
--  * Une entreprise part avec tout ce qui lui est rattaché : contacts (et leurs accès au portail), vente, tâches,
--    historique, revenus, factures et règlements, projets (et tout leur contenu), fichiers, diagnostics,
--    participations aux campagnes, temps, mails et appels enregistrés. Les rendez-vous restent dans l'agenda
--    (sans fiche tant qu'elle est à la corbeille) : aucun changement d'agenda, aucun mail.
--  * Un contact part avec son accès au portail (fermé) et sa place dans les projets ; ses échanges restent sur la
--    fiche. S'il était contact principal, la fiche peut en désigner un autre ; il redevient principal à la
--    restauration si la place est libre.
-- Additif : politiques restrictives ajoutées (y compris sur les tables Mail, Fireflies, Diagnostic, Temps et
-- Prospection rattachées à une fiche) ; aucune table du module Rendez-vous n'est modifiée.

-- ---------------------------------------------------------------------------
-- Invisibilité imposée par la base (application, Claude)
-- ---------------------------------------------------------------------------
select trash_private.hide('companies', array['id:companies']);
select trash_private.hide('people', array['id:people', 'company_id:companies']);
select trash_private.hide('sales', array['id:sales', 'company_id:companies']);
select trash_private.hide('tasks', array['id:tasks', 'company_id:companies']);
select trash_private.hide('interactions', array['id:interactions', 'company_id:companies']);
select trash_private.hide('company_files', array['id:company_files', 'company_id:companies']);
select trash_private.hide('company_file_texts', array['file_id:company_files']);
select trash_private.hide('diagnostics', array['id:diagnostics', 'company_id:companies']);
select trash_private.hide('diagnostic_questions', array['id:diagnostic_questions', 'diagnostic_id:diagnostics']);
select trash_private.hide('diagnostic_versions', array['id:diagnostic_versions', 'diagnostic_id:diagnostics']);
select trash_private.hide('list_members', array['company_id:companies']);
select trash_private.hide('campaign_participants', array['id:campaign_participants', 'company_id:companies']);
select trash_private.hide('participant_drafts', array['participant_id:campaign_participants']);
select trash_private.hide('participant_actions', array['id:participant_actions', 'participant_id:campaign_participants']);
select trash_private.hide('time_entries', array['id:time_entries', 'company_id:companies']);
select trash_private.hide('mail_messages', array['id:mail_messages', 'company_id:companies']);
select trash_private.hide('mail_attachments', array['mail_id:mail_messages']);
select trash_private.hide('fireflies_calls', array['id:fireflies_calls', 'company_id:companies']);
select trash_private.hide('fireflies_call_transcripts', array['call_id:fireflies_calls']);
select trash_private.hide('portal_accesses', array['id:portal_accesses', 'person_id:people']);
select trash_private.hide('portal_sessions', array['id:portal_sessions', 'access_id:portal_accesses']);
select trash_private.hide('duplicate_dismissals', array['company_a:companies', 'company_b:companies']);
select trash_private.hide('import_row_keys', array['company_id:companies']);
select trash_private.hide('merges', array['kept_company_id:companies']);

-- ---------------------------------------------------------------------------
-- Contact
-- ---------------------------------------------------------------------------
create or replace function trash_private.person_name(p public.people)
returns text language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), p.email, 'Contact sans nom');
$$;

create or replace function trash_private.describe_person(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', trash_private.person_name(p),
    'context', c.name,
    'parents', jsonb_build_array(jsonb_build_object('t', 'companies', 'id', p.company_id)),
    'warnings', to_jsonb(array_remove(array[
      case when exists (select 1 from public.portal_accesses a where a.person_id = p.id and a.revoked_at is null)
           then 'Son accès au portail client est fermé ; il revient si vous restaurez le contact.' end,
      (select case when count(*) > 0 then 'Retiré de ' || count(*) || ' projet' || case when count(*) > 1 then 's' else '' end || ' (il y revient à la restauration).' end
         from public.project_members m where m.person_id = p.id),
      case when p.is_primary then 'Contact principal : vous pourrez en désigner un autre ; il le redevient à la restauration si la place est libre.' end,
      'Ses échanges, tâches et rendez-vous restent sur la fiche ' || c.name || '.'
    ], null)))
    from public.people p join public.companies c on c.id = p.company_id
   where p.id = p_id;
$$;

create or replace function trash_private.collect_person(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'people', id from public.people where id = p_id
  union all select 'portal_accesses', id from public.portal_accesses where person_id = p_id
  union all select 'portal_sessions', s.id from public.portal_sessions s join public.portal_accesses a on a.id = s.access_id where a.person_id = p_id;
$$;

-- Date de modification : inchangée quand la corbeille ajuste un champ technique (contact principal ci-dessous).
-- Redéfinition complète de la fonction partagée ; comportement identique hors de ce cas.
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if coalesce(current_setting('cely.trash_keep_updated_at', true), '') = 'on' then
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Contact principal : la place est libérée pendant le séjour en corbeille (seul champ modifié, date de modification
-- conservée), puis rendue à la restauration si aucun autre contact n'est devenu principal entre-temps.
create or replace function trash_private.before_person(p_id uuid)
returns jsonb language plpgsql set search_path = '' as $$
declare v boolean;
begin
  select is_primary into v from public.people where id = p_id;
  if v then
    perform set_config('cely.trash_keep_updated_at', 'on', true);
    update public.people set is_primary = false where id = p_id;
    perform set_config('cely.trash_keep_updated_at', 'off', true);
    return jsonb_build_object('was_primary', true);
  end if;
  return '{}'::jsonb;
end; $$;

create or replace function trash_private.after_restore_person(p_id uuid, p_meta jsonb)
returns void language plpgsql set search_path = '' as $$
begin
  if coalesce((p_meta ->> 'was_primary')::boolean, false) then
    perform set_config('cely.trash_keep_updated_at', 'on', true);
    update public.people p set is_primary = true
     where p.id = p_id and not exists (select 1 from public.people o where o.company_id = p.company_id and o.is_primary and o.id <> p.id);
    perform set_config('cely.trash_keep_updated_at', 'off', true);
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- Entreprise
-- ---------------------------------------------------------------------------
create or replace function trash_private.describe_company(p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'label', c.name,
    'context', coalesce(c.domain_norm, c.website),
    'parents', '[]'::jsonb,
    'warnings', to_jsonb(array_remove(array[
      (select case when count(*) = 1 then 'Son projet part avec elle : ses contacts n''y ont plus accès au portail (rouvert à la restauration).'
                   when count(*) > 1 then count(*) || ' projets partent avec elle : leurs contacts n''y ont plus accès au portail (rouvert à la restauration).' end
         from public.projects p where p.company_id = c.id),
      (select case when count(*) = 1 then 'Sa facture sort des totaux de Finance (' || trash_private.eur(coalesce(sum(o.paid_net), 0)) || ' encaissés) ; son numéro reste réservé.'
                   when count(*) > 1 then count(*) || ' factures sortent des totaux de Finance (' || trash_private.eur(coalesce(sum(o.paid_net), 0)) || ' encaissés) ; leurs numéros restent réservés.' end
         from public.finance_invoice_overview o where o.company_id = c.id and o.kind = 'facture'),
      case when exists (select 1 from public.sales s where s.company_id = c.id) then 'Sa vente part avec elle (Ventes).' end,
      case when exists (select 1 from public.appt_bookings b where b.company_id = c.id)
           then 'Ses rendez-vous restent dans l''agenda, sans fiche tant qu''elle est à la corbeille.' end
    ], null)))
    from public.companies c
   where c.id = p_id and c.merged_into_id is null;
$$;

create or replace function trash_private.collect_company(p_id uuid)
returns table (row_table text, row_id uuid) language sql stable set search_path = '' as $$
  select 'companies', id from public.companies where id = p_id
  union all select x.row_table, x.row_id from public.people p cross join lateral trash_private.collect_person(p.id) x where p.company_id = p_id
  union all select 'sales', id from public.sales where company_id = p_id
  union all select 'tasks', id from public.tasks where company_id = p_id
  union all select 'interactions', id from public.interactions where company_id = p_id
  union all select 'finance_missions', id from public.finance_missions where company_id = p_id
  union all select 'finance_invoices', id from public.finance_invoices where company_id = p_id
  union all select 'finance_payments', fp.id from public.finance_payments fp join public.finance_invoices i on i.id = fp.invoice_id where i.company_id = p_id
  union all select x.row_table, x.row_id from public.projects pr cross join lateral trash_private.collect_project(pr.id) x where pr.company_id = p_id
  union all select 'company_files', id from public.company_files where company_id = p_id
  union all select 'diagnostics', id from public.diagnostics where company_id = p_id
  union all select 'diagnostic_questions', q.id from public.diagnostic_questions q join public.diagnostics d on d.id = q.diagnostic_id where d.company_id = p_id
  union all select 'diagnostic_versions', v.id from public.diagnostic_versions v join public.diagnostics d on d.id = v.diagnostic_id where d.company_id = p_id
  union all select 'campaign_participants', id from public.campaign_participants where company_id = p_id
  union all select 'participant_actions', a.id from public.participant_actions a join public.campaign_participants cp on cp.id = a.participant_id where cp.company_id = p_id
  union all select 'time_entries', id from public.time_entries where company_id = p_id
  union all select 'mail_messages', id from public.mail_messages where company_id = p_id
  union all select 'fireflies_calls', id from public.fireflies_calls where company_id = p_id;
$$;

revoke all on function trash_private.person_name(public.people), trash_private.describe_person(uuid), trash_private.collect_person(uuid),
  trash_private.before_person(uuid), trash_private.after_restore_person(uuid, jsonb),
  trash_private.describe_company(uuid), trash_private.collect_company(uuid) from public, anon;
grant execute on function trash_private.person_name(public.people), trash_private.describe_person(uuid), trash_private.collect_person(uuid),
  trash_private.before_person(uuid), trash_private.after_restore_person(uuid, jsonb),
  trash_private.describe_company(uuid), trash_private.collect_company(uuid) to authenticated;
