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
