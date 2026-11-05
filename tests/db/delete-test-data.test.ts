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

  await db.exec(readFileSync(join(__dirname, "..", "..", "supabase", "maintenance", "delete-test-data.sql"), "utf8"));

  const names = await db.query<{ name: string }>(`select name from companies order by name`);
  expect(names.rows.map((r) => r.name).sort()).toEqual(["TEST2", "Vraie entreprise"].sort());
  expect(await db.one(`select count(*)::int n from tasks`)).toEqual({ n: 1 });
  expect(await db.one(`select count(*)::int n from company_files`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from lead_sources where name like '[TEST]%'`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from pipelines where name like '[TEST]%'`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from lists`)).toEqual({ n: 0 });
  expect(await db.one(`select count(*)::int n from people where company_id = $1`, [test2])).toEqual({ n: 1 });
});
