// Fiche prospect : « Ajouter à une pipeline » et « Passer en client » (menu Actions, Claude).
// Mêmes mécanismes que le parcours normal (move_company, sale_confirm, create_task), en une seule opération.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let co: string;
let stages: string[];
let other: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const n = async (t: string, w = "true") => (await db.one<{ n: number }>(`select count(*)::int n from ${t} where ${w}`)).n;
type Client = { sale_id: string; project_id: string | null; mission_id: string | null; created: Record<string, boolean>; moved: boolean; stopped_followups: number; kept_followups: number; task_id: string | null };
const add = (args: Record<string, unknown>) => db.rpc<{ status: string; stopped_followups: number; kept_followups: number; task_id: string | null }>("company_add_to_pipeline", { p_company: co, ...args });
const client = (args: Record<string, unknown>) => db.rpc<Client>("company_make_client", { p_company: co, ...args });
const sale = (extra: Record<string, unknown> = {}) => ({ closed_on: today(), documents_ready: false, revenue: { mode: "ponctuel", amount: 4000, date: today() }, project_name: "[TEST] Mission Studio", ...extra });
const next = (title = "Lancer l'onboarding") => ({ task: { title, due_date: today() } });

async function inCampaign() {
  const campaign = await db.rpc<string>("create_campaign_draft", { p_name: "[TEST] Fondateurs" });
  await db.rpc("save_campaign_sequence", { p_campaign: campaign, p_steps: [{ name: "Invitation", step_type: "linkedin_invite", delay_days: 0, message: "" }] });
  await db.rpc("enroll_in_campaign", { p_campaign: campaign, p_company_ids: [co] });
  const p = (await db.one<{ id: string }>(`select id from campaign_participants where company_id = $1`, [co])).id;
  await db.rpc("activate_participants", { p_campaign: campaign, p_ids: [p] });
  return p;
}

beforeEach(async () => {
  db = await createDb();
  co = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "[TEST] Studio", amount: 4000 }, p_people: [{ first_name: "Claire", email: "claire@studio.example.test" }] })).id!;
  const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
  stages = [];
  for (const [i, s] of ["Qualifié", "Proposition"].entries()) stages.push((await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, $2, $3) returning id`, [p, s, i])).id);
  const p2 = (await db.one<{ id: string }>(`insert into pipelines (name, position) values ('Partenariats', 1) returning id`)).id;
  other = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Premier échange', 0) returning id`, [p2])).id;
});

describe("Ajouter à une pipeline", () => {
  test("même fiche placée dans l'étape, prochaine action créée, puis déplaçable dans une autre pipeline", async () => {
    const r = await add({ p_stage: stages[0], p_next: next("Envoyer la proposition"), p_idempotency_key: "test-add-0001" });
    expect(r).toMatchObject({ status: "moved", stopped_followups: 0 });
    expect(await db.one(`select stage_id, prospect_status from companies where id = $1`, [co])).toEqual({ stage_id: stages[0], prospect_status: "qualifie" });
    expect(await n("companies")).toBe(1); // aucune copie
    expect(await db.one(`select title from todo_items where company_id = $1`, [co])).toEqual({ title: "Envoyer la proposition" });
    expect(await n("interactions", `company_id = '${co}' and kind = 'stage_change'`)).toBe(1);
    // double clic : même résultat, aucune tâche en double
    expect(await add({ p_stage: stages[0], p_next: next("Envoyer la proposition"), p_idempotency_key: "test-add-0001" })).toEqual(r);
    expect(await n("tasks")).toBe(1);
    // déjà dans une pipeline : déplacement
    await add({ p_stage: other });
    expect(await db.one(`select stage_id from companies where id = $1`, [co])).toEqual({ stage_id: other });
  });

  test("relances en cours : refus sans choix (rien n'est écrit) ; « keep » les garde, « stop » les arrête", async () => {
    const p = await inCampaign();
    await expect(add({ p_stage: stages[0] })).rejects.toThrow(/1 relance\(s\) de prospection en cours/);
    expect(await db.one(`select stage_id from companies where id = $1`, [co])).toEqual({ stage_id: null });
    const kept = await add({ p_stage: stages[0], p_followups: "keep" });
    expect(kept).toMatchObject({ stopped_followups: 0, kept_followups: 1 });
    expect(await db.one(`select status from campaign_participants where id = $1`, [p])).toEqual({ status: "a_contacter" });
    const stopped = await add({ p_stage: stages[1], p_followups: "stop" });
    expect(stopped.stopped_followups).toBe(1);
    expect(await db.one(`select status from campaign_participants where id = $1`, [p])).toEqual({ status: "arrete" });
  });

  test("fiche cliente ou perdue : refus explicite ; prochaine action incomplète : rien n'est déplacé", async () => {
    await expect(add({ p_stage: stages[0], p_next: { task: { title: " ", due_date: today() } } })).rejects.toThrow(/Indiquez la prochaine action/);
    expect(await db.one(`select stage_id from companies where id = $1`, [co])).toEqual({ stage_id: null });
    await client({ p_stage: stages[1], p_sale: sale() });
    await expect(add({ p_stage: stages[0] })).rejects.toThrow(/déjà cliente/);
  });
});

describe("Passer en client", () => {
  test("fiche hors pipeline : même résultat que Prospection → Pipeline → Gagné (vente, revenu, projet, onboarding)", async () => {
    const r = await client({ p_stage: stages[1], p_sale: sale(), p_next: next(), p_idempotency_key: "test-client-0001" });
    expect(r.moved).toBe(true);
    expect(r.created).toEqual({ sale: true, revenue: true, project: true });
    expect(await db.one(`select deal_status, stage_id from companies where id = $1`, [co])).toEqual({ deal_status: "won", stage_id: stages[1] });
    expect(await db.one(`select state, project_id, mission_id from sales where id = $1`, [r.sale_id])).toEqual({ state: "won", project_id: r.project_id, mission_id: r.mission_id });
    expect(await db.one(`select name, status from projects where id = $1`, [r.project_id])).toEqual({ name: "[TEST] Mission Studio", status: "a_preparer" });
    expect(await n("project_onboarding", `project_id = '${r.project_id}'`)).toBe(1);
    expect(await n("project_members", `project_id = '${r.project_id}'`)).toBe(1); // contact principal
    expect(await db.one(`select deal_status, stage from sales_overview where sale_id = $1`, [r.sale_id])).toMatchObject({ deal_status: "won" });
    expect(await db.one(`select title from todo_items where company_id = $1`, [co])).toEqual({ title: "Lancer l'onboarding" });

    // double validation (même clé) puis nouvel essai sans clé : une seule vente, un seul projet, un seul revenu
    expect(await client({ p_stage: stages[1], p_sale: sale(), p_next: next(), p_idempotency_key: "test-client-0001" })).toEqual(r);
    await expect(client({ p_stage: stages[1], p_sale: sale() })).rejects.toThrow(/déjà cliente/);
    expect([await n("sales"), await n("projects"), await n("finance_missions"), await n("tasks")]).toEqual([1, 1, 1, 1]);
  });

  test("résultat identique au parcours normal (move_company puis sale_confirm)", async () => {
    const r = await client({ p_stage: stages[1], p_sale: sale() });
    const snap = async (id: string) => ({
      company: await db.one(`select deal_status, stage_id, pipeline_id, prospect_status, amount::text from companies where id = $1`, [id]),
      sale: await db.one(`select state, cycle, revenue_mode, documents_ready, closed_on::text from sales where company_id = $1`, [id]),
      project: await db.one(`select status from projects where company_id = $1`, [id]),
      mission: await db.one(`select kind, amount::text, status from finance_missions where company_id = $1`, [id]),
      onboarding: await n("project_onboarding o join projects p on p.id = o.project_id", `p.company_id = '${id}'`),
    });
    const ref = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "[TEST] Référence", amount: 4000 }, p_people: [{ first_name: "Léa" }] })).id!;
    await db.rpc("move_company", { p_company: ref, p_stage: stages[1] });
    await db.rpc("sale_confirm", { p_company: ref, p_data: sale() });
    expect(r.project_id).toBeTruthy();
    expect(await snap(co)).toEqual(await snap(ref));
  });

  test("échec en cours de route : rien n'est créé à moitié, puis la relance fonctionne", async () => {
    // le revenu est refusé par sale_confirm, après l'entrée dans la pipeline : tout est annulé
    await expect(client({ p_stage: stages[1], p_sale: sale({ revenue: { mode: "ponctuel", amount: -5, date: today() } }), p_idempotency_key: "test-k-0001" })).rejects.toThrow(/montant positif/);
    // la prochaine action est refusée, après la vente et le projet : tout est annulé aussi
    await expect(client({ p_stage: stages[1], p_sale: sale(), p_next: { task: { title: "Appeler", due_date: "" } }, p_idempotency_key: "test-k-0002" })).rejects.toThrow(/date de la prochaine action/);
    expect(await db.one(`select deal_status, stage_id from companies where id = $1`, [co])).toEqual({ deal_status: "open", stage_id: null });
    expect([await n("sales"), await n("projects"), await n("finance_missions"), await n("tasks"), await n("idempotency_keys", "key like 'test-k-%'")]).toEqual([0, 0, 0, 0, 0]);
    expect(await n("interactions", `company_id = '${co}' and kind in ('stage_change', 'deal_status')`)).toBe(0);
    const r = await client({ p_stage: stages[1], p_sale: sale(), p_idempotency_key: "test-k-0003" });
    expect(r.created.project).toBe(true);
  });

  test("fiche ancienne ou incomplète : sans étape, message clair ; sans contact, le projet est créé sans interlocuteur", async () => {
    await db.exec(`delete from people where company_id = '${co}'`);
    await expect(client({ p_sale: sale() })).rejects.toThrow(/Choisissez la pipeline et l'étape/);
    const r = await client({ p_stage: stages[0], p_sale: { revenue: { mode: "plus_tard" } } });
    expect(r.created).toEqual({ sale: true, project: true });
    expect(await n("project_members", `project_id = '${r.project_id}'`)).toBe(0);
  });

  test("fiche déjà dans une pipeline : pas de déplacement ; relances en cours : choix obligatoire puis appliqué", async () => {
    const p = await inCampaign();
    await add({ p_stage: stages[0], p_followups: "keep" });
    await expect(client({ p_sale: sale() })).rejects.toThrow(/relance\(s\) de prospection en cours/);
    expect(await n("sales")).toBe(0);
    const r = await client({ p_sale: sale(), p_followups: "stop" });
    expect(r).toMatchObject({ moved: false, stopped_followups: 1, kept_followups: 0 });
    expect(await db.one(`select status, stop_reason from campaign_participants where id = $1`, [p])).toEqual({ status: "arrete", stop_reason: "Passage en client" });
    expect(await db.one(`select stage_id from companies where id = $1`, [co])).toEqual({ stage_id: stages[0] });
  });

  test("opportunité perdue : refus ; fiche à la corbeille : introuvable ; autre compte : refusé", async () => {
    await add({ p_stage: stages[0] });
    await db.rpc("set_deal_status", { p_company: co, p_status: "lost" });
    await expect(client({ p_sale: sale() })).rejects.toThrow(/rouvrez-la/);
    await db.rpc("set_deal_status", { p_company: co, p_status: "open" });
    await db.rpc("trash_put", { p_kind: "company", p_id: co });
    await expect(client({ p_sale: sale() })).rejects.toThrow(/Fiche introuvable/);
    await expect(add({ p_stage: stages[1] })).rejects.toThrow(/Fiche introuvable/);
    await db.as("stranger");
    await expect(db.rpc("company_make_client", { p_company: co, p_stage: stages[0], p_sale: sale() })).rejects.toThrow();
    await db.as("anon");
    await expect(db.rpc("company_add_to_pipeline", { p_company: co, p_stage: stages[0] })).rejects.toThrow(/permission denied/);
  });
});
