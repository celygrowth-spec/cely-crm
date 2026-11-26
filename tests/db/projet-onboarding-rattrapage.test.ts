// Rattrapage de la préparation de projet (20261129110000). La production a reçu la première version du module
// (fixtures/projet_onboarding_ancienne_version.sql, fondée sur deal_closings), puis toutes les migrations suivantes,
// sans la réécriture 20261114000100 : c'est cet état qui est reconstruit ici, avec des données, avant le rattrapage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { applyMigrations, createDb, migrationFiles, migrationVersion, type Db } from "./harness";
import { company } from "./projets-helpers";

const MIGRATIONS = join(__dirname, "..", "..", "supabase", "migrations");
const RATTRAPAGE = "20261129110000_projet_onboarding_rattrapage.sql";
const err = async (p: Promise<unknown>) => p.then(() => null, (e: { message: string }) => e.message);
const admin = async <T,>(d: Db, q: string, params: unknown[] = []) => { await d.query("reset role"); return (await d.query<T>(q, params)).rows; };
const columns = async (d: Db, table: string) => (await admin<{ column_name: string }>(d, `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by 1`, [table])).map((r) => r.column_name);

/** Colonnes (nom, type, ordre) et lignes de sales_overview : la vue doit ressortir du rattrapage inchangée. */
async function overview(d: Db) {
  const cols = await admin(d, `select column_name, data_type, ordinal_position from information_schema.columns where table_schema = 'public' and table_name = 'sales_overview' order by ordinal_position`);
  const rows = await admin(d, `select row_id, company_id, sale_id, deal_status, project_id, stage from sales_overview order by company_id`);
  return { cols, rows };
}

/** Base dans l'état de la production : ancienne version du module, puis toutes les migrations sauf sa réécriture. */
async function productionLike(): Promise<Db> {
  const d = await createDb({ upTo: "20261112000100" });
  await d.exec("reset role;");
  await d.exec(readFileSync(join(__dirname, "fixtures", "projet_onboarding_ancienne_version.sql"), "utf8"));
  for (const f of migrationFiles()) {
    const v = migrationVersion(f);
    if (v <= "20261112000100" || v === "20261114000100" || v >= "20261129110000") continue;
    await d.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
  }
  await d.as("owner");
  return d;
}

describe("production : ancienne version du module, puis rattrapage", () => {
  let db: Db;
  let ancien: { company: string; project: string };
  let vendu: { company: string; project: string; sale: string };
  let overviewBefore: string;

  beforeAll(async () => {
    db = await productionLike();
    // un projet né de l'ancien circuit (deal_closings), avec sa préparation
    const a = await company(db, "[TEST] Ancien client", [{ first_name: "Anna", email: "anna@ancien.test" }]);
    await db.exec("reset role;");
    const closing = (await db.one<{ id: string }>(`insert into deal_closings (company_id) values ($1) returning id`, [a.id])).id;
    await db.as("owner");
    const pa = await db.rpc<string>("project_create", { p_data: JSON.stringify({ company_id: a.id, name: "Ancien projet" }), p_person_ids: "{}" });
    await db.exec("reset role;");
    await db.query(`insert into project_onboarding (project_id, closing_id, prep_state) values ($1, $2, 'done')`, [pa, closing]);
    ancien = { company: a.id, project: pa };
    // un projet né d'une vente (Ventes) : dans cet état, aucune préparation ne peut être créée
    const b = await company(db, "[TEST] Nouveau client", [{ first_name: "Bob", email: "bob@nouveau.test" }]);
    await db.as("owner");
    const pb = await db.rpc<string>("project_create", { p_data: JSON.stringify({ company_id: b.id, name: "Projet vendu" }), p_person_ids: "{}" });
    await db.exec("reset role;");
    const sale = (await db.one<{ id: string }>(`insert into sales (company_id, closed_on, project_id) values ($1, '2026-11-20', $2) returning id`, [b.id, pb])).id;
    vendu = { company: b.id, project: pb, sale };
    overviewBefore = JSON.stringify(await overview(db));
  }, 300_000);

  test("l'état reconstruit est celui de la production, et le bug s'y reproduit", async () => {
    expect(await columns(db, "project_onboarding")).toContain("closing_id");
    expect(await columns(db, "project_onboarding")).not.toContain("sale_id");
    expect(await columns(db, "project_onboarding_status")).toEqual(expect.arrayContaining(["closing_id", "won_at"]));
    expect((await admin(db, `select 1 from pg_proc where proname in ('project_win_deal', 'tg_deal_closing_reopen')`)).length).toBe(2);
    expect((await admin(db, `select 1 from pg_proc where proname = 'tg_sales_onboarding'`)).length).toBe(0);
    await db.as("claude");
    expect(await err(db.rpc("onboarding_ensure", { p_project: vendu.project }))).toMatch(/column "sale_id" of relation "project_onboarding" does not exist/);
  });

  test("rattrapage : schéma du dépôt, données conservées, préparation utilisable", async () => {
    await db.exec("reset role;");
    await db.exec(readFileSync(join(MIGRATIONS, RATTRAPAGE), "utf8"));
    expect(await columns(db, "project_onboarding")).toEqual(expect.arrayContaining(["sale_id", "closing_id"]));
    expect(await columns(db, "project_onboarding_status")).toEqual(["analysis_error", "analysis_state", "company_id", "open_optional", "open_required", "prep_error", "prep_state", "project_id", "sale_id", "status", "won_on"]);
    expect((await admin(db, `select 1 from pg_proc where proname in ('project_win_deal', 'tg_deal_closing_reopen')`)).length).toBe(0);
    // la préparation de l'ancien projet est conservée, sans vente ; la table deal_closings garde ses lignes
    expect(await admin(db, `select prep_state, sale_id from project_onboarding where project_id = $1`, [ancien.project])).toEqual([{ prep_state: "done", sale_id: null }]);
    expect((await admin<{ n: number }>(db, `select count(*)::int as n from deal_closings`))[0].n).toBe(1);
    // sales_overview est recréée à l'identique (mêmes colonnes, mêmes lignes) et se lit
    expect(JSON.stringify(await overview(db))).toBe(overviewBefore);
    await db.as("owner");
    expect((await db.query(`select company_id from sales_overview`)).rows.length).toBeGreaterThan(0);
    expect(await db.one(`select has_table_privilege('anon', 'public.project_onboarding_status', 'select') as a, has_table_privilege('anon', 'public.sales_overview', 'select') as b`)).toEqual({ a: false, b: false });

    // le projet né d'une vente obtient sa préparation, par le connecteur Claude comme par l'application
    await db.as("claude");
    expect(await db.rpc("onboarding_ensure", { p_project: vendu.project })).toBe(true);
    expect(await db.rpc("onboarding_ensure", { p_project: ancien.project })).toBe(true);
    await db.as("owner");
    const st = await db.one<{ sale_id: string; company_id: string; won_on: string }>(`select sale_id, company_id, won_on::text from project_onboarding_status where project_id = $1`, [vendu.project]);
    expect(st).toEqual({ sale_id: vendu.sale, company_id: vendu.company, won_on: "2026-11-20" });
    const prep = await db.rpc<{ status: string }>("onboarding_prepare", { p_project: vendu.project });
    expect(["ready", "to_complete"]).toContain(prep.status);
    expect((await admin<{ prep_state: string }>(db, `select prep_state from sales where id = $1`, [vendu.sale]))[0].prep_state).toMatch(/ready|incomplete/);
    // l'ancien projet se prépare aussi (sans date de signature)
    await db.as("owner");
    expect((await db.rpc<{ status: string }>("onboarding_prepare", { p_project: ancien.project })).status).toBeTruthy();
  });

  test("une nouvelle vente liée à un projet crée sa préparation ; rejouer le rattrapage ne change rien", async () => {
    const c = await company(db, "[TEST] Troisième client", [{ first_name: "Chloé", email: "chloe@trois.test" }]);
    await db.as("owner");
    const p = await db.rpc<string>("project_create", { p_data: JSON.stringify({ company_id: c.id, name: "Projet suivant" }), p_person_ids: "{}" });
    await db.exec("reset role;");
    const sale = (await db.one<{ id: string }>(`insert into sales (company_id, closed_on, project_id) values ($1, '2026-11-25', $2) returning id`, [c.id, p])).id;
    expect(await admin(db, `select sale_id from project_onboarding where project_id = $1`, [p])).toEqual([{ sale_id: sale }]);
    const before = await admin(db, `select project_id, sale_id, closing_id, prep_state from project_onboarding order by project_id`);
    await db.exec("reset role;");
    await db.exec(readFileSync(join(MIGRATIONS, RATTRAPAGE), "utf8"));
    expect(await admin(db, `select project_id, sale_id, closing_id, prep_state from project_onboarding order by project_id`)).toEqual(before);
    expect((await admin<{ n: number }>(db, `select count(*)::int as n from pg_trigger where tgname = 'sales_onboarding'`))[0].n).toBe(1);
  });
});

describe("base déjà à jour", () => {
  test("le rattrapage ne touche ni au schéma ni aux vues", async () => {
    const db = await createDb({ upTo: "20261129100000" });
    await db.exec("reset role;");
    const snapshot = async () => ({
      cols: await columns(db, "project_onboarding"),
      view: (await db.one<{ d: string }>(`select pg_get_viewdef('public.project_onboarding_status'::regclass, true) as d`)).d,
      oid: (await db.one<{ o: number }>(`select 'public.project_onboarding_status'::regclass::oid::int as o`)).o,
    });
    const before = await snapshot();
    await applyMigrations(db, { after: "20261129100000" });
    expect(await snapshot()).toEqual(before);
  });
});
