-- Planificateur Supabase : appelle /api/cron toutes les 15 minutes (rappels de rendez-vous, Gmail, agenda).
-- À exécuter dans le SQL Editor de PRODUCTION, sur instruction, après avoir remplacé l'URL et le secret.
-- Prérequis : extensions pg_cron et pg_net activées (Database › Extensions).
-- Le secret est rangé dans Vault (jamais en clair dans la définition de la tâche).

select vault.create_secret('REMPLACER_PAR_CRON_SECRET', 'cely_cron_secret');

select cron.schedule('cely-passages', '*/15 * * * *', $$
  select net.http_post(
    url := 'https://REMPLACER-PAR-VOTRE-DOMAINE/api/cron?taches=rappels,gmail,agenda',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cely_cron_secret')),
    timeout_milliseconds := 55000);
$$);

-- Vérifier : select * from cron.job_run_details order by start_time desc limit 5;
-- Arrêter   : select cron.unschedule('cely-passages');
