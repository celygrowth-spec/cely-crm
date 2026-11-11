// Audit, lot 3 : C04 (relations financières), C05 (indicateurs), Q06 (acompte puis solde), Q07 (montant confirmé).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let co: string;
let other: string;
const paris = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(d);
const today = () => paris(new Date());
const monthsAgo = (n: number) => { const d = new Date(); d.setUTCDate(15); d.setUTCMonth(d.getUTCMonth() - n); return paris(d); };
const n = async (t: string, w = "true") => (await db.one<{ n: number }>(`select count(*)::int n from ${t} where ${w}`)).n;
const company = async (name: string) => (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name }, p_people: [] })).id!;
const revenue = async (data: Record<string, unknown>, c = co) =>
  (await db.rpc<{ id: string }>("finance_add_revenue", { p_data: { company_id: c, label: "Prestation", ...data } })).id;
const state = async (m: string) => (await db.one<{ s: string }>(`select public.finance_revenue_state($1) s`, [m])).s;
const settle = (m: string, data: Record<string, unknown>) => db.rpc<{ id: string }>("finance_settle_due", { p_mission: m, p_data: data });

beforeEach(async () => {
  db = await createDb();
  co = await company("Studio");
  other = await company("Autre client");
});

describe("C04 — un revenu, ses factures et sa vente restent chez le même client", () => {
  test("revenu lié à une vente : pas de changement de client ; facture vers le revenu d'un autre client : refus", async () => {
    const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
    const st = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [p])).id;
    await db.rpc("move_company", { p_company: co, p_stage: st });
    const sale = await db.rpc<{ mission_id: string }>("sale_confirm", { p_company: co, p_data: { revenue: { mode: "ponctuel", amount: 3000, date: today() } } });
    await expect(db.rpc("finance_save_mission", { p_id: sale.mission_id, p_data: { company_id: other, label: "x" } })).rejects.toThrow(/lié à une vente/);

    const theirs = await revenue({ kind: "ponctuel", amount: 500, date: today() }, other);
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, mission_id: sale.mission_id, issue_date: today(), amount_ht: 1000 } })).id;
    await expect(db.rpc("finance_update_invoice", { p_id: inv, p_data: { mission_id: theirs } })).rejects.toThrow(/autre client/);
    await expect(db.rpc("finance_record_invoice", { p_data: { company_id: co, mission_id: theirs, issue_date: today(), amount_ht: 10 } })).rejects.toThrow(/autre client/);
    // même par une écriture directe (Claude, script) : refus à la validation
    await expect(db.exec(`update finance_invoices set mission_id = '${theirs}' where id = '${inv}'`)).rejects.toThrow(/autre client/);
  });

  test("modification partielle : un champ absent ne délie pas la facture ; null retire le lien explicitement", async () => {
    const m = await revenue({ kind: "ponctuel", amount: 3000, date: today() });
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, mission_id: m, issue_date: today(), amount_ht: 1000 } })).id;
    await db.rpc("finance_update_invoice", { p_id: inv, p_data: { reference: "F-12" } });
    expect(await db.one(`select mission_id, reference, amount_ht::text from finance_invoices where id = $1`, [inv])).toEqual({ mission_id: m, reference: "F-12", amount_ht: "1000.00" });
    await db.rpc("finance_update_invoice", { p_id: inv, p_data: { mission_id: null } });
    expect(await db.one(`select mission_id, forecast_due_date from finance_invoices where id = $1`, [inv])).toEqual({ mission_id: null, forecast_due_date: null });
  });

  test("facture d'un mensuel : rattachée à l'échéance la plus proche non facturée, jamais à une échéance déjà couverte", async () => {
    const start = monthsAgo(2);
    const m = await revenue({ kind: "mensuel", amount: 1000, date: start });
    const dues = (await db.query<{ d: string }>(`select public.finance_due_date($1::date, 'mensuel', k)::text d from generate_series(0, 2) k`, [start])).rows.map((r) => r.d);
    await settle(m, { due_date: dues[1], amount: 1000 });
    // facture saisie à la main le jour de l'échéance 2 (déjà couverte) : va sur l'échéance libre la plus proche
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, mission_id: m, issue_date: dues[1], amount_ht: 1000 } })).id;
    const cover = (await db.one<{ d: string }>(`select forecast_due_date::text d from finance_invoices where id = $1`, [inv])).d;
    expect([dues[0], dues[2]]).toContain(cover);
    await expect(db.rpc("finance_record_invoice", { p_data: { company_id: co, mission_id: m, issue_date: today(), amount_ht: 1000, forecast_due_date: dues[1] } }))
      .rejects.toThrow(/déjà facturée/);
  });

  test("référence de facture en double pour un client : refus", async () => {
    await db.rpc("finance_record_invoice", { p_data: { company_id: co, issue_date: today(), amount_ht: 100, reference: "F-1" } });
    await expect(db.rpc("finance_record_invoice", { p_data: { company_id: co, issue_date: today(), amount_ht: 100, reference: "f-1" } })).rejects.toThrow(/déjà enregistrée/);
  });
});

describe("C05 / Q06 — encaissé, acompte puis solde, avoirs et remboursements", () => {
  test("ponctuel 3 000 € : acompte réglé = partiel ; solde en un clic ; encaissé seulement quand tout est réglé", async () => {
    const m = await revenue({ kind: "ponctuel", amount: 3000, date: today() });
    expect(await state(m)).toBe("prevu");
    const a = await settle(m, { due_date: today(), amount: 1000, paid_on: today() });
    expect(await state(m)).toBe("partiel");
    expect(a.id).toBeTruthy();
    await expect(settle(m, { due_date: today(), amount: 2500 })).rejects.toThrow(/Il reste 2000/);
    const solde = await settle(m, { due_date: today(), amount: 2000 });
    expect(await state(m)).toBe("partiel");
    await db.rpc("finance_record_payment", { p_invoice: solde.id, p_paid_on: today(), p_amount: 2000 });
    expect(await state(m)).toBe("encaisse");
    // Ventes affiche le même état
    expect(await db.one(`select billed_ht::text, received::text from finance_mission_overview where id = $1`, [m])).toEqual({ billed_ht: "3000.00", received: "3000.00" });
  });

  test("mensuel : à jour, en retard si une échéance due n'est pas facturée, terminé après la date de fin", async () => {
    const start = monthsAgo(1);
    const m = await revenue({ kind: "mensuel", amount: 1000, date: start });
    expect(await state(m)).toBe("en_retard");
    await settle(m, { due_date: start, amount: 1000, paid_on: start });
    expect(await state(m)).toBe("a_jour");
    await db.rpc("finance_stop_revenue", { p_mission: m, p_end: start });
    expect(await state(m)).toBe("termine");
  });

  test("annuler un paiement déjà remboursé : refus (jamais d'encaissé négatif)", async () => {
    const m = await revenue({ kind: "ponctuel", amount: 1000, date: today(), received: { paid_on: today() } });
    const pay = (await db.one<{ id: string; invoice_id: string }>(`select p.id, p.invoice_id from finance_payments p join finance_invoices i on i.id = p.invoice_id where i.mission_id = $1`, [m]));
    await db.rpc("finance_record_payment", { p_invoice: pay.invoice_id, p_paid_on: today(), p_amount: 1000, p_kind: "remboursement" });
    await expect(db.rpc("finance_cancel_payment", { p_id: pay.id })).rejects.toThrow(/annulez d'abord le remboursement/);
    expect(await db.one(`select paid_net::text from finance_invoice_overview where id = $1`, [pay.invoice_id])).toEqual({ paid_net: "0.00" });
  });

  test("un avoir ne fait pas remonter le reste à facturer ; réduire le revenu est une décision explicite", async () => {
    const m = await revenue({ kind: "ponctuel", amount: 3000, date: today() });
    const inv = await settle(m, { due_date: today(), amount: 3000 });
    await db.rpc("finance_record_credit_note", { p_invoice: inv.id, p_data: { amount_ht: 500 } });
    expect(await db.one(`select billed_ht::text, invoiced_ht::text, amount::text from finance_mission_overview where id = $1`, [m]))
      .toEqual({ billed_ht: "3000.00", invoiced_ht: "2500.00", amount: "3000.00" });
    await db.rpc("finance_record_credit_note", { p_invoice: inv.id, p_data: { amount_ht: 500, reduce_revenue: true } });
    expect(await db.one(`select amount::text from finance_missions where id = $1`, [m])).toEqual({ amount: "2500.00" });
  });
});

describe("Q06 / Q07 — vente mensuelle : facture rattachée à une échéance, montant « / mois » sur la fiche", () => {
  test("Gagné mensuel à 1 000 € sur une fiche estimée à 12 000 € : montant confirmé, estimation dans l'historique", async () => {
    const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
    const st = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [p])).id;
    await db.rpc("move_company", { p_company: co, p_stage: st });
    await db.exec(`update companies set amount = 12000 where id = '${co}'`);
    const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: co, issue_date: today(), amount_ht: 1000 } })).id;
    const sale = await db.rpc<{ mission_id: string; sale_id: string }>("sale_confirm", { p_company: co,
      p_data: { revenue: { mode: "mensuel", amount: 1000, date: today() }, link_invoice_id: inv } });
    expect(await db.one(`select forecast_due_date::text d from finance_invoices where id = $1`, [inv])).toEqual({ d: today() });
    expect(await db.one(`select amount::text, amount_recurring from companies where id = $1`, [co])).toEqual({ amount: "1000.00", amount_recurring: true });
    expect(await n("interactions", `company_id = '${co}' and content like 'Montant confirmé : 1 000 € / mois (estimé avant clôture : 12 000 €)'`)).toBe(1);
    // le revenu évolue : la fiche suit
    await db.rpc("finance_update_revenue", { p_mission: sale.mission_id, p_data: { amount: 1200, date: today() } });
    expect(await db.one(`select amount::text, amount_recurring from companies where id = $1`, [co])).toEqual({ amount: "1200.00", amount_recurring: true });
    expect(await db.one(`select billing, amount_recurring from sales_overview where sale_id = $1`, [sale.sale_id])).toEqual({ billing: "partiel", amount_recurring: true });
    // nouvelle opportunité : on repart d'une estimation
    await db.rpc("deal_new_opportunity", { p_company: co, p_stage: st });
    expect(await db.one(`select amount, amount_recurring from companies where id = $1`, [co])).toEqual({ amount: null, amount_recurring: false });
  });
});
