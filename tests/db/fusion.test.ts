// Audit, lot 2 : fusion complète (C02), aperçu des conflits, rattrapage des fusions passées.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let stage: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const maintenance = (f: string) => readFileSync(join(__dirname, "..", "..", "supabase", "maintenance", f), "utf8");

async function fiche(name: string, email: string) {
  const id = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name }, p_people: [{ first_name: name, email }] })).id!;
  await db.rpc("move_company", { p_company: id, p_stage: stage });
  return id;
}
const win = (c: string, data: Record<string, unknown> = { revenue: { mode: "mensuel", amount: 1000, date: today() } }) =>
  db.rpc<{ sale_id: string; project_id: string; mission_id: string }>("sale_confirm", { p_company: c, p_data: data, p_idempotency_key: null });
const count = async (t: string, c: string) => (await db.one<{ n: number }>(`select count(*)::int n from ${t} where company_id = $1`, [c])).n;

beforeEach(async () => {
  db = await createDb();
  const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
  stage = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [p])).id;
});

describe("fusion complète", () => {
  test("projets, rendez-vous, vente, revenus, factures, fichiers, temps et historique suivent la fiche conservée", async () => {
    const keep = await fiche("Acme", "a@acme.example.test");
    const dup = await fiche("ACME SAS", "b@acme.example.test");
    const s = await win(dup);
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: dup, mission_id: s.mission_id, issue_date: today(), amount_ht: 1000, amount_ttc: 1000 } })).id;
    await db.rpc("finance_record_payment", { p_invoice: inv, p_paid_on: today(), p_amount: 1000 });
    await db.query(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, 'x/f.pdf', 'f.pdf', 'application/pdf', 1, 'ready')`, [dup]);
    await db.query(`insert into time_entries (company_id, started_at, ended_at) values ($1, now() - interval '1 hour', now())`, [dup]);
    await db.exec("reset role;");
    const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
    const type = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Appel', 'appel', 30, $1) returning id`, [sched])).id;
    await db.query(`insert into appt_bookings (event_type_id, status, starts_at, ends_at, schedule_timezone, invitee_timezone, first_name, last_name, email, email_norm, event_snapshot, company_id, idempotency_key, manage_token_hash)
      values ($1, 'confirmed', now() + interval '1 day', now() + interval '1 day 30 minutes', 'Europe/Paris', 'Europe/Paris', 'B', 'Acme', 'b@acme.example.test', 'b@acme.example.test', '{}', $2, 'cle-rdv-fusion', $3)`, [type, dup, "c".repeat(64)]);
    await db.as("owner");

    const preview = await db.rpc<{ counts: { merge: Record<string, number> }; blocking: string[]; active_sale: string }>("merge_preview", { p_keep: keep, p_merge: dup });
    expect(preview.blocking).toEqual([]);
    expect(preview.active_sale).toBe("merge");
    expect(preview.counts.merge).toMatchObject({ projets: 1, ventes: 1, revenus: 1, factures: 1, reglements: 1, rendez_vous: 1, fichiers: 1, temps: 1 });

    // l'issue gardée doit être celle de la vente active (gagnée, sur la fiche absorbée)
    await expect(db.rpc("merge_companies", { p_keep: keep, p_merge: dup, p_fields: {}, p_pipeline_from: "keep" })).rejects.toThrow(/garder sa position commerciale/);
    const res = await db.rpc<{ moved: Record<string, number> }>("merge_companies", { p_keep: keep, p_merge: dup, p_fields: {}, p_pipeline_from: "merged" });
    expect(res.moved).toMatchObject({ ventes: 1, projets: 1, rendez_vous: 1 });
    for (const t of ["projects", "appt_bookings", "sales", "finance_missions", "finance_invoices", "company_files", "time_entries", "people"]) {
      expect([t, await count(t, dup)]).toEqual([t, 0]);
    }
    expect(await db.one(`select deal_status, stage, project_id from sales_overview where company_id = $1 and sale_id is not null`, [keep]))
      .toMatchObject({ deal_status: "won", stage: "devis_contrat", project_id: s.project_id });
    // le projet garde ses capacités : un membre de la fiche conservée peut y être ajouté
    const person = (await db.one<{ id: string }>(`select id from people where company_id = $1 and email = 'a@acme.example.test'`, [keep])).id;
    await db.rpc("project_add_member", { p_project: s.project_id, p_person: person });
    // traçabilité de l'identifiant absorbé
    expect(await db.one(`select merged_into_id from companies where id = $1`, [dup])).toEqual({ merged_into_id: keep });
    expect(await db.one<{ n: number }>(`select count(*)::int n from merges where merged_company_id = $1`, [dup])).toEqual({ n: 1 });
  });

  test("deux ventes en cours : fusion bloquée avec une explication, rien n'a bougé", async () => {
    const a = await fiche("Beta", "a@beta.example.test");
    const b = await fiche("Beta bis", "b@beta.example.test");
    await win(a);
    await win(b);
    const preview = await db.rpc<{ blocking: string[] }>("merge_preview", { p_keep: a, p_merge: b });
    expect(preview.blocking[0]).toMatch(/deux fiches ont une vente en cours/);
    await expect(db.rpc("merge_companies", { p_keep: a, p_merge: b, p_fields: {}, p_pipeline_from: "keep" })).rejects.toThrow(/deux fiches ont une vente en cours/);
    expect(await db.one(`select merged_into_id from companies where id = $1`, [b])).toEqual({ merged_into_id: null });
    expect(await count("projects", b)).toBe(1);
  });

  test("ventes passées des deux côtés : toutes conservées, renumérotées en cycles", async () => {
    const a = await fiche("Gamma", "a@gamma.example.test");
    const b = await fiche("Gamma bis", "b@gamma.example.test");
    for (const c of [a, b]) {
      const s = await win(c, {});
      await db.exec(`update projects set status = 'termine' where id = '${s.project_id}'`);
      await db.rpc("deal_new_opportunity", { p_company: c, p_stage: stage });
    }
    await db.rpc("merge_companies", { p_keep: a, p_merge: b, p_fields: {}, p_pipeline_from: "keep" });
    expect((await db.query(`select cycle, state from sales where company_id = $1 order by cycle`, [a])).rows).toEqual([{ cycle: 1, state: "completed" }, { cycle: 2, state: "completed" }]);
  });
});

describe("fusions passées (avant la correction)", () => {
  test("diagnostic en lecture seule, puis rattrapage des cas sûrs ; le cas ambigu reste à résoudre", async () => {
    const keep = await fiche("Delta", "a@delta.example.test");
    const old = await fiche("Delta bis", "b@delta.example.test");
    const s = await win(old);
    // fusion « à l'ancienne » : seule la fiche est marquée fusionnée, le projet et la vente restent sur l'absorbée
    // (l'ancienne fusion déplaçait les revenus sans la vente : état que les contrôles actuels refusent, recréé ici tel
    // qu'il peut exister dans les données)
    await db.exec(`reset role; alter table finance_missions disable trigger finance_mission_consistency;
      update companies set merged_into_id = '${keep}', archived_at = now(), pipeline_id = null, stage_id = null where id = '${old}';
      alter table finance_missions enable trigger finance_mission_consistency;`);
    const diag = (await db.query<{ projets: number; ventes_en_cours: number }>(maintenance("diagnostic-fusions.sql"))).rows;
    expect(diag).toEqual([expect.objectContaining({ projets: 1, ventes_en_cours: 1 })]);
    // la fiche finale est ouverte : la vente gagnée de l'absorbée est un cas ambigu ; rien n'est déplacé pour cette
    // fiche (la vente, son revenu et son projet restent ensemble)
    await db.exec(maintenance("rattrapage-fusions.sql"));
    expect(await count("projects", keep)).toBe(0);
    expect(await count("projects", old)).toBe(1);
    expect(await db.one(`select company_id from sales where id = $1`, [s.sale_id])).toEqual({ company_id: old });
    // résolue à la main (fiche finale gagnée) : le rattrapage rejoué la rattache
    await db.exec(`update companies set deal_status = 'won', deal_closed_at = now() where id = '${keep}';`);
    await db.exec(maintenance("rattrapage-fusions.sql"));
    expect(await db.one(`select company_id, cycle from sales where id = $1`, [s.sale_id])).toEqual({ company_id: keep, cycle: 1 });
    expect(await count("projects", keep)).toBe(1);
    expect(await count("finance_missions", keep)).toBe(1);
    // rejouable : rien de plus, aucune trace en double
    const traces = async () => (await db.one<{ n: number }>(`select count(*)::int n from interactions where company_id = $1 and content like 'Rattrapage de fusion%'`, [keep])).n;
    const before = await traces();
    await db.exec(maintenance("rattrapage-fusions.sql"));
    expect(await traces()).toBe(before);
  });
});
