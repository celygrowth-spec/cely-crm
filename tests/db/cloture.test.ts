// Clôturer une opportunité (fiche et Kanban partagent set_deal_status) : vraies migrations, PGlite.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let id: string;
let stages: string[];
let pipeline: string;

type Row = { deal_status: string; stage_id: string | null; pipeline_id: string; amount: string | null; lost_reason: string | null; deal_closed_at: string | null; paris_day: string | null };
const row = () => db.one<Row>(`select deal_status, stage_id, pipeline_id, amount::text, lost_reason, deal_closed_at::text,
  to_char(deal_closed_at at time zone 'Europe/Paris', 'YYYY-MM-DD') paris_day from companies where id = $1`, [id]);
const events = async () => (await db.query<{ content: string; meta: Record<string, unknown> }>(
  `select content, meta from interactions where company_id = $1 and kind = 'deal_status' order by created_at, id`, [id])).rows;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const daysAgo = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() - n * 86400000));

beforeEach(async () => {
  db = await createDb();
  id = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Studio Démo" }, p_people: [{ first_name: "Claire" }] })).id!;
  pipeline = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
  stages = [];
  for (const [i, s] of ["Qualifié", "Proposition", "Négociation"].entries()) {
    stages.push((await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, $2, $3) returning id`, [pipeline, s, i])).id);
  }
  await db.rpc("move_company", { p_company: id, p_stage: stages[1] });
  await db.exec(`update companies set amount = 4500 where id = '${id}'`);
});

describe("gagné", () => {
  test("date de signature par défaut aujourd'hui, montant existant conservé, étape inchangée, trace datée", async () => {
    const r = await db.rpc<{ status: string; deal_status: string }>("set_deal_status", { p_company: id, p_status: "won" });
    expect(r).toMatchObject({ status: "ok", deal_status: "won" });
    const c = await row();
    expect(c).toMatchObject({ deal_status: "won", stage_id: stages[1], pipeline_id: pipeline, amount: "4500.00", paris_day: today() });
    const [e] = await events();
    expect(e.content).toBe(`Opportunité gagnée : signée le ${today().split("-").reverse().join("/")} · 4500 €`);
    expect(e.meta).toMatchObject({ from: "open", to: "won", amount: 4500, stage: "Proposition", pipeline: "Vente" });
  });

  test("date passée et montant saisis : enregistrés tels quels, à midi heure de Paris (jamais un autre jour)", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "won", p_closed_on: daysAgo(3), p_amount: 12000 });
    const c = await row();
    expect(c.paris_day).toBe(daysAgo(3));
    expect(c.amount).toBe("12000.00");
    expect((await events())[0].content).toContain("· 12000 €");
  });

  test("date future, montant négatif : refusés sans rien changer", async () => {
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date(Date.now() + 2 * 86400000));
    await expect(db.rpc("set_deal_status", { p_company: id, p_status: "won", p_closed_on: tomorrow })).rejects.toThrow(/futur/);
    await expect(db.rpc("set_deal_status", { p_company: id, p_status: "won", p_amount: -5 })).rejects.toThrow(/Montant/);
    expect((await row()).deal_status).toBe("open");
    expect(await events()).toHaveLength(0);
  });

  test("double clic : la seconde demande ne change rien et ne trace rien", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "won" });
    expect(await db.rpc("set_deal_status", { p_company: id, p_status: "won" })).toMatchObject({ status: "unchanged" });
    expect(await events()).toHaveLength(1);
  });

  test("une opportunité clôturée doit être rouverte avant de changer d'issue", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "won" });
    await expect(db.rpc("set_deal_status", { p_company: id, p_status: "lost" })).rejects.toThrow(/rouvrez/);
  });

  test("hors pipeline : refus clair", async () => {
    await db.rpc("move_company", { p_company: id, p_stage: null });
    await expect(db.rpc("set_deal_status", { p_company: id, p_status: "won" })).rejects.toThrow(/pipeline/);
  });
});

describe("perdu", () => {
  test("motif facultatif enregistré et tracé ; sans motif, la trace reste propre", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "lost", p_lost_reason: "  Budget  " });
    expect(await row()).toMatchObject({ deal_status: "lost", lost_reason: "Budget", stage_id: stages[1] });
    expect((await events())[0].content).toBe("Opportunité perdue : Budget");
    await db.rpc("set_deal_status", { p_company: id, p_status: "open" });
    await db.rpc("set_deal_status", { p_company: id, p_status: "lost" });
    expect((await events())[2].content).toBe("Opportunité perdue");
  });
});

describe("rouvrir", () => {
  test("retour à la dernière étape, date effacée, historique conservé", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "won", p_amount: 8000 });
    const r = await db.rpc<{ stage_id: string }>("set_deal_status", { p_company: id, p_status: "open" });
    expect(r.stage_id).toBe(stages[1]);
    expect(await row()).toMatchObject({ deal_status: "open", stage_id: stages[1], deal_closed_at: null, amount: "8000.00" });
    const e = await events();
    expect(e).toHaveLength(2);
    expect(e[1].content).toBe("Opportunité rouverte : était gagnée · retour à l'étape Vente › Proposition");
  });

  test("sans étape enregistrée : première étape du pipeline", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "lost" });
    await db.exec(`update companies set stage_id = null where id = '${id}'`);
    await db.rpc("set_deal_status", { p_company: id, p_status: "open" });
    expect((await row()).stage_id).toBe(stages[0]);
  });

  test("un projet lié est signalé dans la trace et conservé", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "won" });
    await db.exec(`insert into projects (company_id, name) values ('${id}', 'Refonte du site')`);
    const r = await db.rpc<{ projects: string }>("set_deal_status", { p_company: id, p_status: "open" });
    expect(r.projects).toBe("Refonte du site");
    expect((await events())[1].content).toContain("projet conservé : Refonte du site");
    expect((await db.one<{ n: number }>(`select count(*)::int n from projects where company_id = $1`, [id])).n).toBe(1);
  });

  test("déplacer une fiche clôturée la rouvre aussi (même donnée pour le Kanban)", async () => {
    await db.rpc("set_deal_status", { p_company: id, p_status: "lost" });
    await db.rpc("move_company", { p_company: id, p_stage: stages[2] });
    expect(await row()).toMatchObject({ deal_status: "open", stage_id: stages[2], deal_closed_at: null });
  });
});

test("droits : réservé au propriétaire", async () => {
  await db.as("stranger");
  await expect(db.rpc("set_deal_status", { p_company: id, p_status: "won" })).rejects.toThrow();
  await db.as("anon");
  await expect(db.rpc("set_deal_status", { p_company: id, p_status: "won" })).rejects.toThrow();
});
