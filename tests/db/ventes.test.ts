// Ventes : clôture, revenu, projet et suivi après-vente (vraies migrations, PGlite).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let co: string;
let stage: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() - n * 86400000));
type Res = { sale_id: string; project_id: string | null; mission_id: string | null; created: Record<string, boolean> };
const confirm = (data: Record<string, unknown>, key: string | null = null, company = co) => db.rpc<Res>("sale_confirm", { p_company: company, p_data: data, p_idempotency_key: key });
const overview = (company = co) => db.one<Record<string, unknown>>(`select * from sales_overview where company_id = $1`, [company]);
const n = async (table: string, where = "true") => (await db.one<{ n: number }>(`select count(*)::int n from ${table} where ${where}`)).n;

async function company(name: string) {
  const id = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name }, p_people: [{ first_name: "Claire", last_name: "Martin", email: `claire@${name.toLowerCase().replace(/\W/g, "")}.fr` }] })).id!;
  await db.rpc("move_company", { p_company: id, p_stage: stage });
  return id;
}

beforeEach(async () => {
  db = await createDb();
  const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
  stage = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [p])).id;
  co = await company("Studio Démo");
});

describe("marquer comme gagné", () => {
  test("mensuel : fiche gagnée, revenu mensuel prévu, projet à préparer, suivi en Devis / Contrat", async () => {
    const r = await confirm({ closed_on: today(), revenue: { mode: "mensuel", amount: 1000, date: daysAgo(-5), end_date: null } });
    expect(r.created).toMatchObject({ revenue: true, project: true });
    const o = await overview();
    expect(o).toMatchObject({ deal_status: "won", sale_state: "won", revenue_mode: "mensuel", mission_kind: "recurrent", mission_amount: "1000.00",
      project_name: "Mission Studio Démo", project_status: "a_preparer", billing: "prevu", stage: "devis_contrat" });
    expect(await n("project_members")).toBe(1);
    expect(await n("interactions", "kind = 'deal_status'")).toBe(1);
  });

  test("ponctuel, documents déjà validés : directement en Onboarding ; montant repris sur la fiche", async () => {
    await confirm({ documents_ready: true, revenue: { mode: "ponctuel", amount: 2500, date: today() } });
    const o = await overview();
    expect(o).toMatchObject({ stage: "onboarding", mission_kind: "ponctuel", mission_amount: "2500.00", deal_amount: "2500.00", billing: "prevu" });
  });

  test("sans montant : vente validée, facturation à renseigner, projet créé quand même", async () => {
    const r = await confirm({ revenue: { mode: "plus_tard" } });
    expect(r.mission_id).toBeNull();
    expect(await overview()).toMatchObject({ billing: "a_renseigner", stage: "devis_contrat", revenue_mode: "plus_tard" });
    expect(await n("finance_missions")).toBe(0);
    // compléter plus tard : le revenu s'ajoute au même dossier, le projet n'est pas recréé
    await confirm({ revenue: { mode: "ponctuel", amount: 800, date: today() } });
    expect(await n("finance_missions")).toBe(1);
    expect(await n("projects")).toBe(1);
  });

  test("double clic / relance : même clé ou même fiche → même projet, même revenu", async () => {
    const data = { revenue: { mode: "mensuel", amount: 1000, date: today() } };
    const a = await confirm(data, "cle-vente-1");
    const b = await confirm(data, "cle-vente-1");
    const c = await confirm(data, "cle-vente-2");
    expect(b).toEqual(a);
    expect(c.project_id).toBe(a.project_id);
    expect(c.mission_id).toBe(a.mission_id);
    expect(await n("projects")).toBe(1);
    expect(await n("finance_missions")).toBe(1);
    expect(await n("sales")).toBe(1);
    expect(await n("interactions", "kind = 'deal_status'")).toBe(1);
  });

  test("facture déjà enregistrée : rattachée (revenu créé depuis elle si besoin), état « facturé » puis « encaissé »", async () => {
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, issue_date: today(), amount_ht: 1200, amount_ttc: 1200 } })).id;
    await confirm({ revenue: { mode: "plus_tard" }, link_invoice_id: inv });
    const o = await overview();
    expect(o).toMatchObject({ mission_kind: "ponctuel", mission_amount: "1200.00", billing: "facture" });
    expect((await db.one<{ mission_id: string }>(`select mission_id from finance_invoices where id = $1`, [inv])).mission_id).toBe(o.mission_id);
    await db.rpc("finance_record_payment", { p_invoice: inv, p_paid_on: today(), p_amount: 1200 });
    expect((await overview()).billing).toBe("encaisse");
  });

  test("revenu existant : lié, jamais dupliqué ; refus s'il appartient à une autre fiche", async () => {
    const m = (await db.rpc<{ id: string }>("finance_add_revenue", { p_data: { company_id: co, label: "Accompagnement", kind: "mensuel", amount: 900, date: today() } })).id;
    await confirm({ revenue: { mode: "mensuel", amount: 1000, date: today() }, link_mission_id: m });
    expect(await overview()).toMatchObject({ mission_id: m, mission_amount: "900.00" });
    expect(await n("finance_missions")).toBe(1);
    const other = await company("Acme");
    await expect(confirm({ link_mission_id: m }, null, other)).rejects.toThrow(/n'appartient pas/);
  });

  test("validations : date future, montant manquant, fiche perdue", async () => {
    const tomorrow = daysAgo(-2);
    await expect(confirm({ closed_on: tomorrow })).rejects.toThrow(/futur/);
    await expect(confirm({ revenue: { mode: "mensuel", date: today() } })).rejects.toThrow(/montant/);
    await expect(confirm({ revenue: { mode: "ponctuel", amount: 500 } })).rejects.toThrow(/encaissement/);
    expect(await n("sales")).toBe(0);
    await db.rpc("set_deal_status", { p_company: co, p_status: "lost", p_lost_reason: "Budget" });
    await expect(confirm({})).rejects.toThrow(/perdue/);
  });
});

describe("suivi après-vente", () => {
  test("Devis / Contrat → Onboarding → En mission → terminé : un seul état, partagé avec le projet", async () => {
    const r = await confirm({ revenue: { mode: "plus_tard" } });
    await db.rpc("sale_set_stage", { p_sale: r.sale_id, p_stage: "onboarding" });
    expect((await overview()).stage).toBe("onboarding");
    await db.rpc("sale_set_stage", { p_sale: r.sale_id, p_stage: "en_mission" });
    expect(await overview()).toMatchObject({ stage: "en_mission", project_status: "en_cours" });
    // depuis Projets : le projet passe « terminé » → la vente quitte le tableau, reste gagnée
    await db.exec(`update projects set status = 'termine' where id = '${r.project_id}'`);
    expect(await overview()).toMatchObject({ stage: "termine", deal_status: "won" });
  });

  test("réouverture : liens conservés ; regagnée, la même vente reprend avec le même projet et le même revenu", async () => {
    const r = await confirm({ revenue: { mode: "mensuel", amount: 1000, date: today() } });
    await db.rpc("set_deal_status", { p_company: co, p_status: "open" });
    expect(await db.one(`select state, project_id, mission_id from sales`)).toEqual({ state: "reopened", project_id: r.project_id, mission_id: r.mission_id });
    await expect(db.rpc("sale_set_stage", { p_sale: r.sale_id, p_stage: "en_mission" })).rejects.toThrow(/rouverte/);
    const again = await confirm({ revenue: { mode: "mensuel", amount: 1000, date: today() } });
    expect(again).toMatchObject({ sale_id: r.sale_id, project_id: r.project_id, mission_id: r.mission_id });
    expect(await n("projects")).toBe(1);
    expect(await n("finance_missions")).toBe(1);
  });

  test("préparation : une seule à la fois, résultat enregistré, échec reprenable", async () => {
    const r = await confirm({});
    expect(await db.rpc("sale_prep_claim", { p_sale: r.sale_id })).toBe(true);
    expect(await db.rpc("sale_prep_claim", { p_sale: r.sale_id })).toBe(false);
    await db.rpc("sale_prep_save", { p_sale: r.sale_id, p_state: "failed", p_prep: null, p_error: "Fireflies indisponible" });
    expect(await overview()).toMatchObject({ prep_state: "failed", prep_error: "Fireflies indisponible" });
    expect(await db.rpc("sale_prep_claim", { p_sale: r.sale_id })).toBe(true);
    await db.rpc("sale_prep_save", { p_sale: r.sale_id, p_state: "incomplete", p_prep: { missing: ["contact"] } });
    expect(await overview()).toMatchObject({ prep_state: "incomplete", prep: { missing: ["contact"] }, prep_error: null });
  });
});

describe("anciens dossiers", () => {
  test("déjà gagnés ou perdus : visibles sans migration ; liens uniques proposés, rien créé en masse", async () => {
    const old = await company("Ancien client");
    await db.rpc("set_deal_status", { p_company: old, p_status: "won" });
    const lost = await company("Perdu SA");
    await db.rpc("set_deal_status", { p_company: lost, p_status: "lost", p_lost_reason: "Concurrent" });
    expect(await overview(old)).toMatchObject({ deal_status: "won", sale_id: null, stage: null, billing: "a_renseigner", candidate_mission_id: null });
    expect(await overview(lost)).toMatchObject({ deal_status: "lost", lost_reason: "Concurrent", stage_name: "Proposition", pipeline_name: "Vente" });
    expect(await n("projects")).toBe(0);
    expect(await n("finance_missions")).toBe(0);
    // un revenu et un projet uniques existent déjà : proposés, puis liés à la complétion sans doublon
    const m = (await db.rpc<{ id: string }>("finance_add_revenue", { p_data: { company_id: old, label: "Site", kind: "ponctuel", amount: 3000, date: today() } })).id;
    const p = await db.rpc<string>("project_create", { p_data: { company_id: old, name: "Refonte", status: "en_cours" }, p_person_ids: [] });
    const o = await overview(old);
    expect(o).toMatchObject({ candidate_mission_id: m, candidate_project_id: p, project_id: p, stage: "en_mission" });
    await confirm({ link_mission_id: m, link_project_id: p }, null, old);
    expect(await overview(old)).toMatchObject({ sale_id: expect.any(String), mission_id: m, project_id: p, stage: "en_mission", billing: "prevu" });
    expect(await n("projects")).toBe(1);
    expect(await n("finance_missions")).toBe(1);
    expect(await n("interactions", `company_id = '${old}' and kind = 'deal_status'`)).toBe(1); // clôture d'origine conservée
  });

  test("droits : réservé au propriétaire", async () => {
    await db.as("stranger");
    await expect(confirm({})).rejects.toThrow();
    expect((await db.query(`select * from sales_overview`)).rows).toHaveLength(0);
    await db.as("anon");
    await expect(confirm({})).rejects.toThrow();
  });
});
