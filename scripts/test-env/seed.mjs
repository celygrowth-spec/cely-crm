// Données fictives de l'environnement de test. Tout est marqué « [TEST] » (noms) ou utilise le domaine réservé
// example.test (emails) : reconnaissable, et supprimable par supabase/maintenance/delete-test-data.sql.
export async function seed(pg) {
  const sched = (await pg.query(`select id from appt_schedules where is_default`)).rows[0].id;
  await pg.query(
    `insert into appt_event_types (name, slug, description, duration_min, schedule_id, min_notice_min, buffer_after_min, questions, meeting_url)
     values ('[TEST] Appel découverte', 'appel-decouverte', 'Un premier échange de 30 minutes.', 30, $1, 60, 10,
     '[{"id":"besoin","label":"Quel est votre besoin ?","kind":"long","required":true}]'::jsonb, 'https://meet.example.test/cely')`,
    [sched],
  );
  const p = (await pg.query(`insert into public.pipelines (name) values ('[TEST] Vente') returning id`)).rows[0].id;
  const stages = [];
  for (const [i, n] of ["Qualifié", "Proposition", "Négociation"].entries()) {
    stages.push((await pg.query(`insert into public.stages (pipeline_id, name, position) values ($1, $2, $3) returning id`, [p, n, i])).rows[0].id);
  }
  const acme = (await pg.query(`insert into public.companies (name, website, pipeline_id, stage_id) values ('[TEST] Acme', 'acme.example.test', $1, $2) returning id`, [p, stages[0]])).rows[0].id;
  const studio = (await pg.query(`insert into public.companies (name, website, pipeline_id, stage_id, amount) values ('[TEST] Studio Démo', 'studio.example.test', $1, $2, 2500) returning id`, [p, stages[1]])).rows[0].id;
  await pg.query(`insert into public.people (company_id, first_name, last_name, email, is_primary) values ($1, 'Jean', 'Test', 'jean@acme.example.test', true)`, [acme]);
  await pg.query(`insert into public.people (company_id, first_name, last_name, email, is_primary) values ($1, 'Claire', 'Test', 'claire@studio.example.test', true), ($1, 'Marc', 'Test', 'marc@studio.example.test', false)`, [studio]);
}
