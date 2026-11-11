// Le script de nettoyage ne retire que les données « [TEST] », en une seule instruction.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDb } from "./harness";

test("le script supprime les données [TEST] et rien d'autre", async () => {
  const db = await createDb();
  const company = async (name: string) =>
    (await db.rpc<{ id: string }>("create_company", { p_company: { name }, p_people: [{ first_name: "Paul", last_name: name }] })).id;
  const test_ = await company("[TEST] Acme");
  const real = await company("Vraie entreprise");
  const test2 = await company("TEST2");

  const pipe = await db.one<{ id: string }>(`insert into pipelines (name) values ('[TEST] Vente') returning id`);
  const stage = await db.one<{ id: string }>(`insert into stages (pipeline_id, name) values ($1, 'Proposition') returning id`, [pipe.id]);
  await db.query(`update companies set pipeline_id = $1, stage_id = $2 where id = $3`, [pipe.id, stage.id, test_]);
  const list = await db.one<{ id: string }>(`insert into lists (name) values ('[TEST] Liste') returning id`);
  await db.query(`insert into list_members (list_id, company_id) values ($1, $2), ($1, $3)`, [list.id, test_, real]);
  await db.query(`insert into tasks (company_id, title, due_date) values ($1, '[TEST] Tâche', current_date), ($2, 'Vraie tâche', current_date)`, [test_, real]);
  await db.query(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes) values ($1, 'a/b.txt', 'b.txt', 'text/plain', 1)`, [test_]);
  const src = await db.one<{ id: string }>(`insert into lead_sources (name) values ('[TEST] Salon') returning id`);
  await db.query(`update companies set source_id = $1 where id = $2`, [src.id, test_]);
  const camp = await db.rpc<string>("create_campaign_draft", { p_name: "[TEST] Campagne" });
  await db.rpc("enroll_in_campaign", { p_campaign: camp, p_list_ids: [list.id] });

  await db.rpc("mail_save_draft", { p_id: "44444444-4444-4444-8444-444444444444", p: { company_id: test_, to: ["a@b.fr"], subject: "x", body: "y" } });
  await db.rpc("mail_save_draft", { p_id: "55555555-5555-4555-8555-555555555555", p: { company_id: real, to: ["a@b.fr"], subject: "garde", body: "y" } });

  // Un appel Fireflies de test rattaché à la fiche de test, un vrai appel rattaché à cette même fiche : ce dernier revient dans la file.
  await db.exec(`reset role;
    insert into fireflies_calls (account_id, fireflies_id, title, link_state, company_id) values
      ('c', 'test1', '[TEST] Appel', 'linked', '${test_}'), ('c', 'vrai1', 'Vrai appel', 'linked', '${test_}');
    insert into fireflies_import_jobs (meeting_id, status, call_id) select fireflies_id, 'done', id from fireflies_calls;`);

  // Script prévu pour le SQL Editor de Supabase : il s'y exécute avec les droits d'administration.
  await db.exec(readFileSync(join(__dirname, "..", "..", "supabase", "maintenance", "delete-test-data.sql"), "utf8"));
  expect((await db.query(`select title, link_state, company_id from fireflies_calls`)).rows).toEqual([{ title: "Vrai appel", link_state: "to_link", company_id: null }]);
  expect((await db.query(`select meeting_id from fireflies_import_jobs`)).rows).toEqual([{ meeting_id: "vrai1" }]);

  const names = await db.query<{ name: string }>(`select name from companies order by name`);
  expect(names.rows.map((r) => r.name).sort()).toEqual(["TEST2", "Vraie entreprise"].sort());
  expect(await db.one(`select count(*)::int n from tasks`)).toEqual({ n: 1 });
  expect(await db.one(`select count(*)::int n from company_files`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n, min(subject) s from mail_messages`)).toEqual({ n: 1, s: "garde" });
  expect(await db.one(`select count(*)::int n from lead_sources where name like '[TEST]%'`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from pipelines where name like '[TEST]%'`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from lists`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from people where company_id = $1`, [test2])).toEqual({ n: 1 });
});

test("une fiche [TEST] gagnée avec projet, fichiers, revenu, facture, avoir, règlement, rendez-vous et temps : tout part, le réel reste", async () => {
  const db = await createDb();
  const company = async (name: string, email: string) =>
    (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name }, p_people: [{ first_name: "Ana", email }] })).id!;
  const t = await company("[TEST] Client gagné", "ana@client.example.test");
  const real = await company("Vrai client", "ana@vrai-client.fr");
  const pl = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
  const st = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [pl])).id;
  for (const c of [t, real]) await db.rpc("move_company", { p_company: c, p_stage: st });
  const won = async (c: string, key: string) => db.rpc<{ sale_id: string; mission_id: string; project_id: string }>("sale_confirm",
    { p_company: c, p_data: { revenue: { mode: "ponctuel", amount: 3000, date: "2026-11-01" } }, p_idempotency_key: key });
  const s1 = await won(t, "cle-test-gagne-1");
  const s2 = await won(real, "cle-vrai-gagne-1");
  for (const [c, s] of [[t, s1], [real, s2]] as const) {
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: c, mission_id: s.mission_id, issue_date: "2026-11-01", amount_ht: 3000, amount_ttc: 3000 } })).id;
    await db.rpc("finance_record_payment", { p_invoice: inv, p_paid_on: "2026-11-05", p_amount: 1000 });
    await db.rpc("finance_record_credit_note", { p_invoice: inv, p_data: { issue_date: "2026-11-06", amount_ht: 500, amount_ttc: 500 } });
    const file = (await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status, category) values ($1, $2, 'Proposition.pdf', 'application/pdf', 10, 'ready', 'Proposition') returning id`, [c, `${c}/p.pdf`])).id;
    const folder = (await db.one<{ id: string }>(`insert into project_folders (project_id, name) values ($1, 'Livrables') returning id`, [s.project_id])).id;
    await db.query(`insert into project_files (project_id, file_id, folder_id) values ($1, $2, $3)`, [s.project_id, file, folder]);
    await db.query(`insert into project_tasks (project_id, title) values ($1, 'Kick-off')`, [s.project_id]);
    await db.query(`insert into time_entries (company_id, started_at, ended_at) values ($1, now() - interval '1 hour', now())`, [c]);
  }
  // un vrai rendez-vous rattaché par erreur à la fiche de test, et un rendez-vous de test
  await db.exec("reset role;");
  const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  const type = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Appel', 'appel', 30, $1) returning id`, [sched])).id;
  for (const [i, email] of ["invite@example.test", "vrai.invite@gmail.com"].entries()) {
    await db.query(
      `insert into appt_bookings (event_type_id, status, starts_at, ends_at, schedule_timezone, invitee_timezone, first_name, last_name, email, email_norm,
         event_snapshot, company_id, idempotency_key, manage_token_hash)
       values ($1, 'confirmed', now() + make_interval(days => $2), now() + make_interval(days => $2, mins => 30), 'Europe/Paris', 'Europe/Paris',
         'In', 'Vité', $3, $3, '{}', $4, $5, $6)`,
      [type, 2 + i, email, t, `cle-rdv-test-${i}`, String(i).repeat(64)]);
  }
  await db.as("owner");

  const script = readFileSync(join(__dirname, "..", "..", "supabase", "maintenance", "delete-test-data.sql"), "utf8");
  // comme dans le SQL Editor de Supabase : droits d'administration
  await db.exec("reset role;");
  // 1. aperçu en lecture seule : rien ne change
  const preview = script.slice(0, script.indexOf("-- ============================================================ SUPPRESSION"));
  const res = await db.query<{ element: string; nombre: number }>(preview.replace(/^--.*$/gm, ""));
  const count = (e: string) => Number(res.rows.find((r) => r.element.startsWith(e))?.nombre);
  expect(count("fiches [TEST]")).toBe(1);
  expect(count("ventes")).toBe(1);
  expect(count("projets")).toBe(1);
  expect(count("factures et avoirs")).toBe(2);
  expect(count("règlements")).toBe(1);
  expect(count("BLOQUANT")).toBe(0);
  expect(await db.one(`select count(*)::int n from companies`)).toEqual({ n: 2 });

  // 2. suppression
  await db.exec(script);
  expect((await db.query(`select name from companies`)).rows).toEqual([{ name: "Vrai client" }]);
  const left = await db.one(`select (select count(*)::int from sales) s, (select count(*)::int from projects) p, (select count(*)::int from finance_missions) m,
    (select count(*)::int from finance_invoices) i, (select count(*)::int from finance_payments) r, (select count(*)::int from project_files) pf,
    (select count(*)::int from project_tasks) pt, (select count(*)::int from time_entries) te, (select count(*)::int from company_files) f`);
  expect(left).toEqual({ s: 1, p: 1, m: 1, i: 2, r: 1, pf: 1, pt: 1, te: 1, f: 1 });
  expect((await db.query(`select email, company_id from appt_bookings`)).rows).toEqual([{ email: "vrai.invite@gmail.com", company_id: null }]);
  expect(count("rendez-vous")).toBe(1);
});

test("garde-fou : une fiche réelle fusionnée dans une fiche [TEST] bloque tout, rien n'est supprimé", async () => {
  const db = await createDb();
  const t = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "[TEST] Garde" }, p_people: [] })).id!;
  const r = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Réelle" }, p_people: [] })).id!;
  await db.exec(`update companies set merged_into_id = '${t}' where id = '${r}'`);
  const script = readFileSync(join(__dirname, "..", "..", "supabase", "maintenance", "delete-test-data.sql"), "utf8");
  await db.exec("reset role;");
  await expect(db.exec(script)).rejects.toThrow(/fusionnée/);
  expect(await db.one(`select count(*)::int n from companies`)).toEqual({ n: 2 });
});
