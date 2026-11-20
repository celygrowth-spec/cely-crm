-- Supprime le jeu de données fictives de Tracking site (scripts/test-env/seed-tracking.mjs) et rien d'autre :
-- seules les lignes marquées « demo » et les fiches « [TEST] » portant l'étiquette tracking-demo sont touchées.
-- Sans effet s'il n'y a pas de données fictives. Commande : node scripts/test-env/seed-tracking.mjs --supprimer
begin;
delete from public.site_attributions where demo;
delete from public.site_visits where demo;            -- pages vues et événements supprimés en cascade
delete from public.site_visitors where demo;
delete from public.site_bot_hits where demo;
delete from public.site_utm_links where demo;
delete from public.seo_daily where demo;
delete from public.people where company_id in (select id from public.companies where 'tracking-demo' = any (tags) and name like '[TEST] %');
delete from public.companies where 'tracking-demo' = any (tags) and name like '[TEST] %';
commit;
