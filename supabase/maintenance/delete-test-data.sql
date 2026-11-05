-- Supprime définitivement les données de test dont le nom commence par « [TEST] ».
-- À exécuter manuellement dans le SQL Editor de Supabase. Ne touche à aucune autre donnée.
-- Le contenu des fichiers est dans Storage : supprimez-les d'abord depuis la fiche.
-- Un seul bloc : tout est supprimé, ou rien en cas d'erreur.
do $$
declare
  test_ids uuid[];
begin
  select coalesce(array_agg(id), '{}') into test_ids from public.companies where name like '[TEST]%';
  delete from public.campaigns where name like '[TEST]%';
  delete from public.campaign_participants where company_id = any (test_ids);
  delete from public.mail_messages where company_id = any (test_ids) or business_type = 'mail_test';
  delete from public.company_files where company_id = any (test_ids);
  delete from public.interactions where company_id = any (test_ids);
  delete from public.tasks where company_id = any (test_ids);
  delete from public.list_members where company_id = any (test_ids);
  delete from public.people where company_id = any (test_ids);
  delete from public.companies where id = any (test_ids);
  delete from public.lists where name like '[TEST]%';
  delete from public.lead_sources where name like '[TEST]%';
  delete from public.templates where name like '[TEST]%';
  delete from public.stages where pipeline_id in (select id from public.pipelines where name like '[TEST]%');
  delete from public.pipelines where name like '[TEST]%';
end $$;
