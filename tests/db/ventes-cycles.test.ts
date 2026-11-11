// Audit, lot 1 : C03 (effets confirmés), C10 (références disparues), C11 (clés), Q05 (cycles), Q11 (recul confirmé).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let co: string;
let stages: string[];
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const inDays = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + n * 864e5));
type Res = { sale_id: string; cycle: number; project_id: string | null; mission_id: string | null; created: Record<string, boolean>; project_removed: boolean };
const confirm = (data: Record<string, unknown>, key: string | null = null) => db.rpc<Res>("sale_confirm", { p_company: co, p_data: data, p_idempotency_key: key });
const monthly = { revenue: { mode: "mensuel", amount: 1000, date: today() } };
const n = async (t: string, w = "true") => (await db.one<{ n: number }>(`select count(*)::int n from ${t} where ${w}`)).n;

beforeEach(async () => {
  db = await createDb();
  co = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Studio" }, p_people: [{ first_name: "Claire", email: "claire@studio.example.test" }] })).id!;
  const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
  stages = [];
  for (const [i, s] of ["Qualifié", "Proposition"].entries()) stages.push((await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, $2, $3) returning id`, [p, s, i])).id);
  await db.rpc("move_company", { p_company: co, p_stage: stages[1] });
});

describe("C03 — réouverture et perte : décisions explicites, une opération", () => {
  test("sans décision : refus, rien ne change ; avec décisions : projet archivé, échéances arrêtées, accès révoqués", async () => {
    const r = await confirm(monthly);
    const claire = (await db.one<{ id: string }>(`select id from people where company_id = $1`, [co])).id;
    await db.exec(`reset role; insert into portal_accesses (person_id, code_hash, code_hint) values ('${claire}', '${"a".repeat(64)}', 'AB12');`);
    await db.as("owner");
    const links = await db.rpc<{ project: { name: string }; mission: { kind: string }; portal_people: { other_projects: number }[] }>("deal_links", { p_company: co });
    expect(links.project.name).toBe("Mission Studio");
    expect(links.mission.kind).toBe("recurrent");
    expect(links.portal_people).toEqual([expect.objectContaining({ other_projects: 0 })]);

    await expect(db.rpc("deal_transition", { p_company: co, p_status: "open", p_options: {} })).rejects.toThrow(/Choisissez ce que devient le projet/);
    expect(await db.one(`select deal_status from companies where id = $1`, [co])).toEqual({ deal_status: "won" });

    const res = await db.rpc<{ effects: string[] }>("deal_transition", { p_company: co, p_status: "open",
      p_options: { project: "en_attente", revenue: "continue", portal: "keep" } });
    expect(res.effects).toEqual(["Projet mis en attente"]);
    // perdue ensuite : nouvelles décisions, appliquées ensemble
    const lost = await db.rpc<{ effects: string[] }>("deal_transition", { p_company: co, p_status: "lost",
      p_options: { project: "archive", revenue: "stop", revenue_stop_on: today(), portal: "revoke", lost_reason: "Budget gelé" } });
    expect(lost.effects).toEqual([`Projet archivé`, `Revenu mensuel arrêté au ${today().split("-").reverse().join("/")}`, "1 accès client révoqué(s)"]);
    expect(await db.one(`select deal_status, lost_reason from companies where id = $1`, [co])).toEqual({ deal_status: "lost", lost_reason: "Budget gelé" });
    expect(await db.one(`select status from projects where id = $1`, [r.project_id])).toEqual({ status: "archive" });
    expect(await db.one(`select end_date::text, status from finance_missions where id = $1`, [r.mission_id])).toEqual({ end_date: today(), status: "termine" });
    expect(await db.one(`select revoked_at is not null r from portal_accesses`)).toEqual({ r: true });
    expect(await db.one(`select state from sales where id = $1`, [r.sale_id])).toEqual({ state: "lost" });
    expect(await n("interactions", `company_id = '${co}' and kind = 'system' and content like 'Perte :%'`)).toBe(1);
  });

  test("revenu ponctuel : la prévision peut être retirée (les factures gardent leur historique)", async () => {
    const r = await confirm({ revenue: { mode: "ponctuel", amount: 2500, date: inDays(20) } });
    await db.rpc("deal_transition", { p_company: co, p_status: "open", p_options: { project: "continue", revenue: "stop" } });
    expect(await db.one(`select status from finance_missions where id = $1`, [r.mission_id])).toEqual({ status: "termine" });
    // regagnée : la vente montre clairement que son revenu est arrêté
    const again = await confirm({});
    expect(again.mission_id).toBe(r.mission_id);
    expect(await db.one(`select mission_status from sales_overview where sale_id = $1`, [r.sale_id])).toEqual({ mission_status: "termine" });
  });

  test("sans projet ni revenu actifs, la réouverture simple reste possible", async () => {
    await db.rpc("set_deal_status", { p_company: co, p_status: "won" });
    await db.rpc("set_deal_status", { p_company: co, p_status: "open" });
    expect(await db.one(`select deal_status from companies where id = $1`, [co])).toEqual({ deal_status: "open" });
  });
});

describe("C10 — revenus disparus ou liés", () => {
  test("un revenu lié à une vente ne se supprime pas ; une référence disparue n'est jamais renvoyée", async () => {
    const r = await confirm(monthly);
    await expect(db.exec(`delete from finance_missions where id = '${r.mission_id}'`)).rejects.toThrow(/arrêtez ses échéances/);
    // revenu disparu (données anciennes, avant ce garde-fou) : la vente se complète avec un nouveau revenu
    await db.exec(`reset role; alter table finance_missions disable trigger finance_mission_sale_guard; delete from finance_missions where id = '${r.mission_id}'; alter table finance_missions enable trigger finance_mission_sale_guard;`);
    await db.as("owner");
    const again = await confirm({ revenue: { mode: "ponctuel", amount: 900, date: today() } });
    expect(again.mission_id).not.toBe(r.mission_id);
    expect(await db.one(`select amount::text from finance_missions where id = $1`, [again.mission_id])).toEqual({ amount: "900.00" });
  });
});

describe("C11 — clés d'idempotence", () => {
  test("même clé, mêmes paramètres : même résultat ; autres paramètres ou autre opération : erreur explicite", async () => {
    const a = await confirm(monthly, "cle-c11-vente");
    expect(await confirm(monthly, "cle-c11-vente")).toEqual(a);
    await expect(confirm({ revenue: { mode: "ponctuel", amount: 5, date: today() } }, "cle-c11-vente")).rejects.toThrow(/d'autres informations/);
    await expect(db.rpc("finance_add_revenue", { p_data: { company_id: co, label: "x", kind: "ponctuel", amount: 10, date: today() }, p_idempotency_key: "cle-c11-vente" }))
      .rejects.toThrow(/autre opération \(sale_confirm\)/);
    expect(await n("finance_missions")).toBe(1);
  });
});

describe("Q05 — client qui revient : nouvelle vente, nouvelle mission, même fiche", () => {
  test("nouvelle opportunité puis Gagné : cycle 2, nouveau projet et nouveau revenu ; le cycle 1 reste consultable", async () => {
    const one = await confirm(monthly);
    await db.exec(`update projects set status = 'termine' where id = '${one.project_id}'`);
    await expect(db.rpc("deal_new_opportunity", { p_company: co, p_stage: stages[0] })).resolves.toMatchObject({ previous_sale_id: one.sale_id });
    expect(await db.one(`select deal_status, stage_id from companies where id = $1`, [co])).toEqual({ deal_status: "open", stage_id: stages[0] });
    const two = await confirm({ revenue: { mode: "ponctuel", amount: 4000, date: today() } });
    expect(two).toMatchObject({ cycle: 2 });
    expect(two.sale_id).not.toBe(one.sale_id);
    expect(two.project_id).not.toBe(one.project_id);
    expect(two.mission_id).not.toBe(one.mission_id);
    const rows = (await db.query<{ cycle: number; sale_state: string; stage: string }>(`select cycle, sale_state, stage from sales_overview where company_id = $1 order by cycle`, [co])).rows;
    expect(rows).toEqual([{ cycle: 1, sale_state: "completed", stage: "termine" }, { cycle: 2, sale_state: "won", stage: "devis_contrat" }]);
    expect(await n("sales", `company_id = '${co}' and state in ('won', 'reopened')`)).toBe(1);
    // le projet terminé du cycle 1 n'est jamais relié à une nouvelle vente
    await db.exec(`update projects set status = 'termine' where id = '${two.project_id}'`);
    await db.rpc("deal_new_opportunity", { p_company: co, p_stage: stages[0] });
    await expect(confirm({ link_project_id: one.project_id })).rejects.toThrow(/terminé ou archivé/);
  });

  test("un projet supprimé n'est jamais recréé en silence", async () => {
    const r = await confirm(monthly);
    await db.exec(`reset role; delete from projects where id = '${r.project_id}';`);
    await db.as("owner");
    const again = await confirm({});
    expect(again).toMatchObject({ project_id: null, project_removed: true });
    expect(await n("projects")).toBe(0);
    const created = await confirm({ create_project: true });
    expect(created.project_id).toBeTruthy();
  });
});

describe("K10 — une nouvelle pièce relance la préparation (source unique)", () => {
  test("proposition ajoutée : préparation à actualiser ; le contrat ne vaut pas confirmation des documents", async () => {
    const r = await confirm(monthly);
    await db.rpc("onboarding_prepare", { p_project: r.project_id });
    expect(await db.one(`select prep_state from project_onboarding where project_id = $1`, [r.project_id])).toEqual({ prep_state: "done" });
    await db.query(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status, category) values ($1, 'x/c.pdf', 'Contrat signé.pdf', 'application/pdf', 10, 'ready', 'Contrat')`, [co]);
    expect(await db.one(`select prep_state from project_onboarding where project_id = $1`, [r.project_id])).toEqual({ prep_state: "pending" });
    expect(await db.one(`select documents_ready, stage from sales_overview where sale_id = $1`, [r.sale_id])).toEqual({ documents_ready: false, stage: "devis_contrat" });
  });
});

describe("Q11 — un projet en cours ne recule pas sans confirmation", () => {
  test("refus explicite, puis confirmé", async () => {
    const r = await confirm(monthly);
    await db.rpc("sale_set_stage", { p_sale: r.sale_id, p_stage: "en_mission" });
    await expect(db.rpc("sale_set_stage", { p_sale: r.sale_id, p_stage: "onboarding" })).rejects.toThrow(/demande votre confirmation/);
    expect(await db.one(`select status from projects where id = $1`, [r.project_id])).toEqual({ status: "en_cours" });
    await db.rpc("sale_set_stage", { p_sale: r.sale_id, p_stage: "onboarding", p_confirm: true });
    expect(await db.one(`select status from projects where id = $1`, [r.project_id])).toEqual({ status: "a_preparer" });
  });
});
