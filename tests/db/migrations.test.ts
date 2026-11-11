// Gestion des migrations (C15) : identifiants uniques, ordre stable, bundle à jour, garde-fous sur les fonctions
// modifiées par remplacement de texte, mise à niveau depuis l'état audité (d5cb064) avec des données en place.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { applyMigrations, createDb, migrationFiles, migrationVersion } from "./harness";

/** Dernière migration présente au commit audité (d5cb064). Toute migration du chantier vient après. */
export const AUDITED_UP_TO = "20261114000100";
const ROOT = join(__dirname, "..", "..");

describe("fichiers de migration", () => {
  test("noms bien formés et versions uniques", () => {
    const files = migrationFiles();
    for (const f of files) expect(f).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    const versions = files.map(migrationVersion);
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("ordre d'application inchangé pour les migrations auditées (le renommage Fireflies garde sa place)", () => {
    const files = migrationFiles();
    const i = (n: string) => files.findIndex((f) => f.includes(n));
    expect(i("_finance_revenus")).toBeLessThan(i("_fireflies.sql"));
    expect(i("_fireflies.sql")).toBeLessThan(i("_fireflies_rattachement"));
    expect(files).toContain("20261108000150_fireflies.sql");
  });

  test("supabase/install.sql correspond exactement aux migrations (npm run db:bundle)", () => {
    const body = migrationFiles().map((f) => `-- ===== ${f} =====\n${readFileSync(join(ROOT, "supabase", "migrations", f), "utf8")}`).join("\n\n");
    const install = readFileSync(join(ROOT, "supabase", "install.sql"), "utf8");
    expect(install.endsWith(body)).toBe(true);
  });
});

describe("fonctions", () => {
  test("les 13 fonctions ouvertes à Claude par remplacement de texte gardent leur contrôle (une redéfinition ne l'efface pas)", async () => {
    const db = await createDb();
    const names = ["project_create", "project_add_member", "project_remove_member", "portal_access_set_expiry", "portal_access_revoke",
      "project_link_meeting", "project_publish_recap", "project_idea_to_task", "project_folder_save", "project_files_move",
      "project_folder_delete", "portal_preview_project", "portal_preview_meeting"];
    const { rows } = await db.query<{ proname: string; src: string }>(
      `select proname, prosrc src from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)`, [names]);
    expect(rows.map((r) => r.proname).sort()).toEqual([...names].sort());
    for (const r of rows) {
      expect(r.src, r.proname).toContain("public.assert_owner()");
      expect(r.src, r.proname).not.toContain("assert_owner_user");
    }
  });
});

describe("mise à niveau", () => {
  test("depuis l'état audité, avec des données réelles de forme : rien n'est perdu, tout reste utilisable", async () => {
    const db = await createDb({ upTo: AUDITED_UP_TO });
    // état « avant chantier » : une fiche gagnée avec vente, revenu, projet, facture et règlement
    const co = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Client existant" }, p_people: [{ first_name: "Ana", email: "ana@client.example.test" }] })).id!;
    const pl = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
    const st = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [pl])).id;
    await db.rpc("move_company", { p_company: co, p_stage: st });
    const sale = await db.rpc<{ sale_id: string; mission_id: string; project_id: string }>("sale_confirm",
      { p_company: co, p_data: { revenue: { mode: "ponctuel", amount: 3000, date: "2026-11-01" } }, p_idempotency_key: "migration-test-1" });
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, mission_id: sale.mission_id, issue_date: "2026-11-01", amount_ht: 3000, amount_ttc: 3000 } })).id;
    await db.rpc("finance_record_payment", { p_invoice: inv, p_paid_on: "2026-11-05", p_amount: 1000 });
    const before = await db.one(`select (select count(*)::int from sales) s, (select count(*)::int from projects) p, (select count(*)::int from finance_missions) m,
      (select count(*)::int from finance_invoices) i, (select count(*)::int from finance_payments) r`);

    await applyMigrations(db, { after: AUDITED_UP_TO });

    expect(await db.one(`select (select count(*)::int from sales) s, (select count(*)::int from projects) p, (select count(*)::int from finance_missions) m,
      (select count(*)::int from finance_invoices) i, (select count(*)::int from finance_payments) r`)).toEqual(before);
    const o = await db.one<Record<string, unknown>>(`select deal_status, project_id, mission_id from sales_overview where company_id = $1`, [co]);
    expect(o).toMatchObject({ deal_status: "won", project_id: sale.project_id, mission_id: sale.mission_id });
  });

  test("installation complète sur une base vide", async () => {
    const db = await createDb();
    expect((await db.one<{ n: number }>(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace`)).n).toBeGreaterThan(100);
  });
});
