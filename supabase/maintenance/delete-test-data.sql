-- Supprime définitivement les données de test dont le nom commence par « [TEST] ».
-- À exécuter manuellement dans le SQL Editor de Supabase. Ne touche à aucune autre donnée.
begin;
create temporary table _test_companies on commit drop as
  select id from public.companies where name like '[TEST]%';
delete from public.campaigns where name like '[TEST]%';
delete from public.campaign_participants where company_id in (select id from _test_companies);
delete from public.interactions where company_id in (select id from _test_companies);
delete from public.tasks where company_id in (select id from _test_companies);
delete from public.list_members where company_id in (select id from _test_companies);
delete from public.people where company_id in (select id from _test_companies);
delete from public.companies where id in (select id from _test_companies);
delete from public.lists where name like '[TEST]%';
delete from public.templates where name like '[TEST]%';
delete from public.stages where pipeline_id in (select id from public.pipelines where name like '[TEST]%');
delete from public.pipelines where name like '[TEST]%';
commit;
