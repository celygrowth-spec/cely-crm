-- Suppression des données de TEST — à exécuter manuellement dans le SQL Editor de Supabase.
--
-- Périmètre, et rien d'autre :
--   * les fiches dont le nom commence par « [TEST] » et tout ce qui leur est rattaché : personnes, historique,
--     tâches, participations aux campagnes, ventes, projets (et tout leur contenu : membres, accès portail, tâches,
--     fichiers partagés, dossiers, points, idées, onboarding), revenus, factures, avoirs, règlements, rendez-vous,
--     emails, appels Fireflies, diagnostics, fichiers, temps ;
--   * les rendez-vous dont l'invité utilise le domaine réservé example.test, les appels titrés « [TEST] » ;
--   * un VRAI rendez-vous ou un VRAI appel rattaché à une fiche de test n'est pas supprimé : il est détaché
--     (l'appel repasse « à rattacher »).
--   * les campagnes, listes, sources, modèles, pipelines et types de rendez-vous nommés « [TEST] ».
--
-- Garde-fous : refus (rien n'est supprimé) si une fiche réelle a été fusionnée dans une fiche de test, si un
-- pipeline [TEST] contient une fiche réelle, ou si un type de rendez-vous [TEST] porte des rendez-vous réels.
--
-- Le contenu des fichiers est dans Storage : ce script ne retire que les références en base. Supprimez les
-- fichiers depuis la fiche avant, ou depuis Storage après (requête des chemins en fin d'aperçu).
--
-- 1. Exécutez d'abord l'APERÇU (lecture seule) et relisez les nombres.
-- 2. Puis exécutez le bloc SUPPRESSION : tout est supprimé, ou rien en cas d'erreur.

-- ============================================================ APERÇU (lecture seule)
with t as (select id from public.companies where name like '[TEST]%'),
     p as (select id from public.projects where company_id in (select id from t)),
     inv as (select id from public.finance_invoices where company_id in (select id from t)),
     bk as (select id from public.appt_bookings where email_norm like '%@example.test'),
     calls as (select id from public.fireflies_calls where title like '[TEST]%')
select * from (values
  ('fiches [TEST]', (select count(*) from t)),
  ('personnes', (select count(*) from public.people where company_id in (select id from t))),
  ('historique', (select count(*) from public.interactions where company_id in (select id from t))),
  ('tâches CRM', (select count(*) from public.tasks where company_id in (select id from t))),
  ('participations aux campagnes', (select count(*) from public.campaign_participants where company_id in (select id from t))),
  ('ventes', (select count(*) from public.sales where company_id in (select id from t))),
  ('projets (avec tout leur contenu)', (select count(*) from p)),
  ('tâches de projet', (select count(*) from public.project_tasks where project_id in (select id from p))),
  ('revenus', (select count(*) from public.finance_missions where company_id in (select id from t))),
  ('factures et avoirs', (select count(*) from inv)),
  ('règlements', (select count(*) from public.finance_payments where invoice_id in (select id from inv))),
  ('rendez-vous', (select count(*) from bk)),
  ('emails', (select count(*) from public.mail_messages where company_id in (select id from t) or business_type = 'mail_test')),
  ('appels Fireflies [TEST]', (select count(*) from calls)),
  ('vrais appels rattachés à une fiche [TEST] (détachés, conservés)', (select count(*) from public.fireflies_calls where company_id in (select id from t) and id not in (select id from calls))),
  ('vrais rendez-vous sur une fiche [TEST] (détachés, conservés)', (select count(*) from public.appt_bookings where company_id in (select id from t) and id not in (select id from bk))),
  ('diagnostics', (select count(*) from public.diagnostics where company_id in (select id from t))),
  ('fichiers (références)', (select count(*) from public.company_files where company_id in (select id from t))),
  ('temps passé', (select count(*) from public.time_entries where company_id in (select id from t))),
  ('campagnes [TEST]', (select count(*) from public.campaigns where name like '[TEST]%')),
  ('pipelines [TEST]', (select count(*) from public.pipelines where name like '[TEST]%')),
  ('BLOQUANT si > 0 : fiche réelle fusionnée dans une fiche [TEST]', (select count(*) from public.companies where merged_into_id in (select id from t) and name not like '[TEST]%')),
  ('BLOQUANT si > 0 : fiche réelle dans un pipeline [TEST]', (select count(*) from public.companies c join public.pipelines pl on pl.id = c.pipeline_id where pl.name like '[TEST]%' and c.name not like '[TEST]%')),
  ('BLOQUANT si > 0 : rendez-vous réel sur un type [TEST]', (select count(*) from public.appt_bookings b join public.appt_event_types e on e.id = b.event_type_id where e.name like '[TEST]%' and b.id not in (select id from bk)))
) as apercu(element, nombre);
-- Chemins Storage des fichiers concernés :
-- select storage_path from public.company_files where company_id in (select id from public.companies where name like '[TEST]%');

-- ============================================================ SUPPRESSION (un seul bloc)
do $$
declare
  t uuid[];
  p uuid[];
  inv uuid[];
  bk uuid[];
  n int;
begin
  select coalesce(array_agg(id), '{}') into t from public.companies where name like '[TEST]%';

  -- garde-fous : jamais de donnée réelle entraînée par une donnée de test
  select count(*) into n from public.companies where merged_into_id = any (t) and name not like '[TEST]%';
  if n > 0 then raise exception 'Arrêt : % fiche(s) réelle(s) fusionnée(s) dans une fiche [TEST]. Rien n''a été supprimé.', n; end if;
  select count(*) into n from public.companies c join public.pipelines pl on pl.id = c.pipeline_id where pl.name like '[TEST]%' and c.name not like '[TEST]%';
  if n > 0 then raise exception 'Arrêt : % fiche(s) réelle(s) dans un pipeline [TEST]. Déplacez-les d''abord. Rien n''a été supprimé.', n; end if;

  select coalesce(array_agg(id), '{}') into p from public.projects where company_id = any (t);
  select coalesce(array_agg(id), '{}') into inv from public.finance_invoices where company_id = any (t);
  select coalesce(array_agg(id), '{}') into bk from public.appt_bookings where email_norm like '%@example.test';
  select count(*) into n from public.appt_bookings b join public.appt_event_types e on e.id = b.event_type_id where e.name like '[TEST]%' and not (b.id = any (bk));
  if n > 0 then raise exception 'Arrêt : % rendez-vous réel(s) sur un type [TEST]. Rien n''a été supprimé.', n; end if;

  -- appels [TEST] (transcriptions supprimées avec eux) ; un vrai appel rattaché sera détaché avec la fiche
  delete from public.fireflies_import_jobs where call_id in (select id from public.fireflies_calls where title like '[TEST]%');
  delete from public.fireflies_calls where title like '[TEST]%';
  -- ventes, puis projets et tout leur contenu
  delete from public.sales where company_id = any (t);
  delete from public.projects where id = any (p);
  -- finance : règlements, avoirs, factures, revenus
  delete from public.finance_payments where invoice_id = any (inv);
  delete from public.finance_invoices where id = any (inv) and kind = 'avoir';
  delete from public.finance_invoices where id = any (inv);
  delete from public.finance_missions where company_id = any (t);
  -- rendez-vous (événements, rappels et créneaux supprimés avec eux)
  delete from public.appt_bookings where id = any (bk);
  -- emails, diagnostics, fichiers, prospection, historique
  delete from public.mail_messages where company_id = any (t) or business_type = 'mail_test';
  delete from public.diagnostics where company_id = any (t);
  delete from public.company_files where company_id = any (t);
  delete from public.campaign_participants where company_id = any (t);
  delete from public.campaigns where name like '[TEST]%';
  delete from public.interactions where company_id = any (t);
  delete from public.tasks where company_id = any (t);
  delete from public.list_members where company_id = any (t);
  delete from public.merges where kept_company_id = any (t) or merged_company_id = any (t);
  delete from public.time_entries where company_id = any (t);
  delete from public.people where company_id = any (t);
  -- fiches absorbées par une fusion d'abord, puis les autres
  delete from public.companies where id = any (t) and merged_into_id is not null;
  delete from public.companies where id = any (t);
  -- éléments nommés [TEST]
  delete from public.lists where name like '[TEST]%';
  delete from public.lead_sources where name like '[TEST]%';
  delete from public.templates where name like '[TEST]%';
  delete from public.mail_templates where name like '[TEST]%';
  delete from public.appt_event_types where name like '[TEST]%';
  delete from public.stages where pipeline_id in (select id from public.pipelines where name like '[TEST]%');
  delete from public.pipelines where name like '[TEST]%';
  raise notice 'Données de test supprimées : % fiche(s).', coalesce(array_length(t, 1), 0);
end $$;
