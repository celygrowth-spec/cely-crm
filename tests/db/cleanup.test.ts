// Le script de nettoyage supprime uniquement les données « [TEST] ».
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createDb } from "./harness";

test("delete-test-data.sql ne supprime que les données [TEST]", async () => {
  const db = await createDb();
  const t = await db.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Acme", website: "t.example" }, p_people: [{ first_name: "Paul" }] });
  const keep = await db.rpc<{ id: string }>("create_company", { p_company: { name: "Vrai client" }, p_people: [{ first_name: "Zoé" }] });
  const l = await db.one<{ id: string }>(`insert into lists (name) values ('[TEST] Liste A') returning id`);
  await db.query(`insert into list_members (list_id, company_id) values ($1, $2), ($1, $3)`, [l.id, t.id, keep.id]);
  const tpl = await db.rpc<string>("save_template", { p_id: null, p_name: "[TEST] Séquence", p_steps: [{ name: "Msg", channel: "linkedin", delay_days: 0 }] });
  const camp = await db.rpc<{ id: string }>("create_campaign", { p_name: "[TEST] Campagne", p_template: tpl, p_list_ids: [l.id] });
  const cp = await db.one<{ id: string }>(`select id from campaign_participants where company_id = $1`, [t.id]);
  await db.rpc("mark_step_sent", { p_participant: cp.id, p_content: "Bonjour" });
  const p = await db.one<{ id: string }>(`insert into pipelines (name) values ('[TEST] Vente') returning id`);
  const s = await db.one<{ id: string }>(`insert into stages (pipeline_id, name) values ($1, 'Proposition') returning id`, [p.id]);
  await db.rpc("move_company", { p_company: t.id, p_stage: s.id });
  expect(camp.id).toBeTruthy();

  await db.exec(`reset role;`);
  await db.exec(readFileSync(join(import.meta.dirname, "..", "..", "supabase", "maintenance", "delete-test-data.sql"), "utf8"));
  const n = async (sql: string) => (await db.one<{ n: number }>(sql)).n;
  expect(await n(`select count(*)::int n from companies`)).toBe(1);
  expect(await n(`select count(*)::int n from people`)).toBe(1);
  expect(await n(`select count(*)::int n from companies where name = 'Vrai client'`)).toBe(1);
  expect(await n(`select count(*)::int n from lists`)).toBe(0);
  expect(await n(`select count(*)::int n from pipelines`)).toBe(0);
  expect(await n(`select count(*)::int n from campaigns`)).toBe(0);
});
