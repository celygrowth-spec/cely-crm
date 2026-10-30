// Module Finance : règles en base (PGlite + vraies migrations) et calculs de bout en bout
// à partir des vues réelles.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { buildFinanceData } from "@/lib/finance/service";
import { cashOut, contractualMrr, forecast, invoicedIn, periodCash, periodKpis, urssafRows } from "@/lib/finance/calc";
import type { FinanceData } from "@/lib/finance/types";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const one = <T = Record<string, unknown>>(sql: string, p?: unknown[]) => db.one<T>(sql, p);
async function company(name: string) {
  return (await db.rpc<{ id: string }>("create_company", { p_company: { name }, p_people: [], p_force: true })).id;
}
async function invoice(companyId: string, data: Record<string, unknown>, key?: string) {
  return (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: companyId, ...data }, p_idempotency_key: key ?? null })).id;
}
async function pay(invoiceId: string, date: string, amount: string, key?: string, kind = "paiement") {
  return db.rpc<{ id: string }>("finance_record_payment", { p_invoice: invoiceId, p_paid_on: date, p_amount: amount, p_kind: kind, p_note: null, p_idempotency_key: key ?? null });
}
const overview = (id: string) => one<{ status: string; balance: string; paid_net: string }>(`select status, balance::text, paid_net::text from finance_invoice_overview where id = $1`, [id]);

async function rows(table: string) {
  const r = await db.query<{ r: Record<string, unknown> }>(`select to_jsonb(t) as r from public.${table} t`);
  return r.rows.map((x) => x.r);
}
async function load(today: string): Promise<FinanceData> {
  const [settings, rates, opening, missions, invoices, payments, categories, expenses, subscriptions, urssaf, movements] = await Promise.all([
    rows("finance_settings"), rows("finance_rates"), rows("finance_opening_balance"), rows("finance_mission_overview"), rows("finance_invoice_overview"),
    rows("finance_payments"), rows("finance_expense_categories"), rows("finance_expenses"), rows("finance_subscriptions"), rows("finance_urssaf_periods"),
    rows("finance_cash_movements"),
  ]);
  return buildFinanceData(today, { settings, rates, opening: opening[0] ?? null, missions, invoices, payments, categories, expenses, subscriptions, urssaf, movements });
}

describe("factures et paiements", () => {
  test("facture partiellement payée : statut, reste dû, puis soldée", async () => {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-09-01", due_date: "2099-01-01", amount_ht: "1000.00" });
    expect(await overview(inv)).toMatchObject({ status: "a_encaisser", balance: "1000.00" });
    await pay(inv, "2026-09-10", "400.00");
    expect(await overview(inv)).toMatchObject({ status: "partielle", balance: "600.00", paid_net: "400.00" });
    await expect(pay(inv, "2026-09-11", "600.01")).rejects.toThrow(/dépasse le reste/);
    await pay(inv, "2026-09-12", "600.00");
    expect(await overview(inv)).toMatchObject({ status: "payee", balance: "0.00" });
  });

  test("facture échue non soldée : en retard", async () => {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-01-01", due_date: "2026-01-31", amount_ht: "500" });
    expect((await overview(inv)).status).toBe("en_retard");
  });

  test("double clic : la même clé d'idempotence n'enregistre qu'un seul paiement", async () => {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-09-01", amount_ht: "1000" }, "invoice-key-1");
    const again = await invoice(c, { issue_date: "2026-09-01", amount_ht: "1000" }, "invoice-key-1");
    expect(again).toBe(inv);
    const a = await pay(inv, "2026-09-10", "300", "payment-key-1");
    const b = await pay(inv, "2026-09-10", "300", "payment-key-1");
    expect(b.id).toBe(a.id);
    expect((await one<{ n: number }>(`select count(*)::int as n from finance_payments`)).n).toBe(1);
  });

  test("paiement reçu le mois suivant l'émission : facturé en septembre, encaissé en octobre", async () => {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-09-25", due_date: "2026-10-25", amount_ht: "2000" });
    await pay(inv, "2026-10-05", "2000");
    const d = await load("2026-10-30");
    expect(invoicedIn(d.invoices, "2026-09-01", "2026-09-30").ht).toBe(200000);
    expect(periodKpis(d, "2026-09-01", "2026-09-30").received).toBe(0);
    expect(periodKpis(d, "2026-10-01", "2026-10-31").received).toBe(200000);
    expect(invoicedIn(d.invoices, "2026-10-01", "2026-10-31").ht).toBe(0);
    // la base URSSAF suit l'encaissement, pas la facturation
    const r = urssafRows(d);
    expect(r.find((x) => x.start === "2026-09-01")!.estimate.base).toBe(0);
    expect(r.find((x) => x.start === "2026-10-01")!.estimate.base).toBe(200000);
  });

  test("avoir et annulation : les totaux restent justes, rien n'est supprimé", async () => {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-09-01", amount_ht: "1000" });
    await db.rpc("finance_record_credit_note", { p_invoice: inv, p_data: { amount_ht: "200", issue_date: "2026-09-15" }, p_idempotency_key: null });
    expect(await overview(inv)).toMatchObject({ balance: "800.00" });
    await expect(db.rpc("finance_record_credit_note", { p_invoice: inv, p_data: { amount_ht: "900" }, p_idempotency_key: null })).rejects.toThrow(/dépasserait/);
    const other = await invoice(c, { issue_date: "2026-09-02", amount_ht: "300" });
    await db.rpc("finance_cancel_invoice", { p_id: other, p_reason: "doublon" });
    const d = await load("2026-10-30");
    expect(invoicedIn(d.invoices, "2026-09-01", "2026-09-30").ht).toBe(80000);
    // la suppression d'une facture est interdite par RLS
    await db.query(`delete from finance_invoices where id = $1`, [other]);
    expect((await one<{ n: number }>(`select count(*)::int as n from finance_invoices`)).n).toBe(3);
    // facture payée : annulation refusée (avoir ou remboursement à la place)
    await pay(inv, "2026-09-20", "100");
    await expect(db.rpc("finance_cancel_invoice", { p_id: inv, p_reason: "" })).rejects.toThrow(/avoir/);
  });

  test("remboursement : réduit l'encaissé et la base URSSAF", async () => {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-09-01", amount_ht: "1000" });
    await pay(inv, "2026-09-05", "1000");
    await pay(inv, "2026-09-20", "250", undefined, "remboursement");
    const d = await load("2026-10-30");
    expect(periodKpis(d, "2026-09-01", "2026-09-30").received).toBe(75000);
    expect(urssafRows(d).find((x) => x.start === "2026-09-01")!.estimate.base).toBe(75000);
  });
});

describe("missions", () => {
  test("client avec plusieurs missions : totaux par mission et revenu récurrent contractuel", async () => {
    const c = await company("Acme");
    const m1 = (await db.rpc<{ id: string }>("finance_save_mission", { p_id: null, p_data: { company_id: c, label: "Retainer", kind: "recurrent", frequency: "mensuel", amount: "1500", next_due_date: "2026-10-01" } })).id;
    const m2 = (await db.rpc<{ id: string }>("finance_save_mission", { p_id: null, p_data: { company_id: c, label: "Audit", kind: "ponctuel", amount: "3000", next_due_date: "2026-11-15" } })).id;
    await db.rpc<{ id: string }>("finance_save_mission", { p_id: null, p_data: { company_id: c, label: "Atelier annuel", kind: "recurrent", frequency: "annuel", amount: "1200", status: "actif" } });
    const i1 = await invoice(c, { mission_id: m1, issue_date: "2026-10-01", amount_ht: "1500", forecast_due_date: "2026-10-01" });
    await pay(i1, "2026-10-10", "1500");
    await invoice(c, { mission_id: m2, issue_date: "2026-10-20", amount_ht: "1000" });
    const ms = await db.query<{ label: string; invoiced_ht: string; received: string; remaining: string; next_due_date: string | null }>(
      `select label, invoiced_ht::text, received::text, remaining::text, next_due_date::text from finance_mission_overview order by label`,
    );
    expect(ms.rows).toEqual([
      { label: "Atelier annuel", invoiced_ht: "0.00", received: "0.00", remaining: "0.00", next_due_date: null },
      { label: "Audit", invoiced_ht: "1000.00", received: "0.00", remaining: "1000.00", next_due_date: "2026-11-15" },
      // la facture couvrant l'échéance a avancé la prochaine échéance (prévision seulement)
      { label: "Retainer", invoiced_ht: "1500.00", received: "1500.00", remaining: "0.00", next_due_date: "2026-11-01" },
    ]);
    const d = await load("2026-10-30");
    expect(contractualMrr(d.missions)).toEqual({ cents: 150000 + 10000, unknown: 0 });
    expect(periodKpis(d, "2026-10-01", "2026-10-31").activeClients).toBe(1);
    // une mission d'un autre client est refusée
    const other = await company("Beta");
    await expect(invoice(other, { mission_id: m1, issue_date: "2026-10-01", amount_ht: "10" })).rejects.toThrow(/ne correspond pas/);
  });

  test("une mission récurrente génère des échéances prévisionnelles, jamais d'encaissement", async () => {
    const c = await company("Acme");
    await db.rpc("finance_save_mission", { p_id: null, p_data: { company_id: c, label: "Retainer", kind: "recurrent", frequency: "mensuel", amount: "1000", next_due_date: "2026-11-05" } });
    const d = await load("2026-10-30");
    const f = forecast(d, 3);
    expect(f.map((m) => m.inEstime)).toEqual([0, 100000, 100000, 100000]);
    expect(f.every((m) => m.inRealise === 0)).toBe(true);
    expect(periodCash(d, "2026-01-01", "2027-12-31").inflow).toBe(0);
  });

  test("fusion de fiches CRM : missions et factures suivent la fiche conservée", async () => {
    const a = await company("Acme");
    const b = await company("Acme SAS");
    await db.rpc("finance_save_mission", { p_id: null, p_data: { company_id: b, label: "Mission", kind: "ponctuel" } });
    await invoice(b, { issue_date: "2026-10-01", amount_ht: "100" });
    await db.rpc("merge_companies", { p_keep: a, p_merge: b });
    expect((await one<{ n: number }>(`select count(*)::int as n from finance_invoices where company_id = $1`, [a])).n).toBe(1);
    expect((await one<{ n: number }>(`select count(*)::int as n from finance_missions where company_id = $1`, [a])).n).toBe(1);
  });
});

describe("charges et abonnements", () => {
  const sub = (data: Record<string, unknown>) => db.rpc<{ id: string }>("finance_save_subscription", { p_id: null, p_data: data, p_idempotency_key: null });

  test("abonnement annuel : une seule échéance par an, idempotent, coût mensuel = 1/12", async () => {
    await sub({ label: "Nom de domaine + hébergement", amount: "240", frequency: "annuel", next_due_date: "2026-03-15" });
    await db.rpc("finance_generate_occurrences", { p_until: "2027-04-01" });
    await db.rpc("finance_generate_occurrences", { p_until: "2027-04-01" });
    const occ = await db.query<{ planned_date: string; status: string }>(`select planned_date::text, status from finance_expenses order by planned_date`);
    expect(occ.rows).toEqual([{ planned_date: "2026-03-15", status: "a_payer" }, { planned_date: "2027-03-15", status: "a_payer" }]);
    expect((await one<{ d: string }>(`select next_due_date::text as d from finance_subscriptions`)).d).toBe("2028-03-15");
    const d = await load("2026-10-30");
    const { subscriptionTotals } = await import("@/lib/finance/calc");
    expect(subscriptionTotals(d.subscriptions, d.today)).toMatchObject({ count: 1, monthly: { cents: 2000, unknown: 0 }, annual: { cents: 24000, unknown: 0 } });
  });

  test("charge récurrente impayée : jamais comptée payée sans validation, ni l'abonnement ni l'échéance en double", async () => {
    await sub({ label: "Notion", amount: "10", frequency: "mensuel", next_due_date: "2026-10-01" });
    await db.rpc("finance_generate_occurrences", { p_until: "2026-10-31" });
    let d = await load("2026-10-30");
    expect(cashOut(d, "2026-10-01", "2026-10-31").expenses).toBe(0);
    expect(periodKpis(d, "2026-10-01", "2026-10-31").overdueExpenses).toEqual({ cents: 1000, unknown: 0 });
    // la prévision compte l'échéance impayée une fois (prévue) et les suivantes (estimées), jamais le modèle en plus
    const f = forecast(d, 2);
    expect(f.map((m) => [m.outPrevu, m.outEstime])).toEqual([[1000, 0], [0, 1000], [0, 1000]]);
    const occ = await one<{ id: string }>(`select id from finance_expenses`);
    await db.rpc("finance_pay_expense", { p_id: occ.id, p_paid_on: "2026-10-03", p_amount: null, p_idempotency_key: "pay-expense-1" });
    await db.rpc("finance_pay_expense", { p_id: occ.id, p_paid_on: "2026-10-03", p_amount: null, p_idempotency_key: "pay-expense-1" });
    d = await load("2026-10-30");
    expect(cashOut(d, "2026-10-01", "2026-10-31").expenses).toBe(1000);
  });

  test("montant inconnu : signalé comme incomplet, jamais compté zéro", async () => {
    await db.rpc("finance_save_expense", { p_id: null, p_data: { label: "Électricité", planned_date: "2026-11-10", status: "a_payer" }, p_idempotency_key: null });
    const d = await load("2026-10-30");
    expect(periodKpis(d, "2026-10-01", "2026-10-31").upcoming).toEqual({ cents: 0, unknown: 1 });
    await expect(db.rpc("finance_save_expense", { p_id: null, p_data: { label: "X", planned_date: "2026-11-10", status: "paye" }, p_idempotency_key: null })).rejects.toThrow(/montant/);
  });

  test("résiliation : plus aucune échéance après la date de fin", async () => {
    await sub({ label: "Outil", amount: "30", frequency: "mensuel", next_due_date: "2026-09-01", end_date: "2026-10-15" });
    await db.rpc("finance_generate_occurrences", { p_until: "2027-01-31" });
    expect((await one<{ n: number }>(`select count(*)::int as n from finance_expenses`)).n).toBe(2);
  });
});

describe("URSSAF", () => {
  async function setup() {
    const c = await company("Acme");
    const inv = await invoice(c, { issue_date: "2026-09-01", amount_ht: "4000" });
    await pay(inv, "2026-09-15", "4000");
  }

  test("déclarée mais non payée : à payer, à provisionner au montant déclaré", async () => {
    await setup();
    let d = await load("2026-10-10");
    let sept = urssafRows(d).find((r) => r.start === "2026-09-01")!;
    expect(sept.state).toBe("a_declarer");
    expect(sept.deadline).toBe("2026-10-31");
    // 4 000 € × (25,6 % + 0,2 %) = 1 032 €
    expect(sept.estimate).toMatchObject({ status: "estime", base: 400000, social: 102400, cfp: 800, total: 103200 });
    await db.rpc("finance_urssaf_declare", { p_start: "2026-09-01", p_end: "2026-09-30", p_declared_on: "2026-10-12", p_base: "4000", p_amount: "1032", p_estimate: { base: "4000", amount: "1032", rate: "25.800" }, p_idempotency_key: "declare-sept" });
    d = await load("2026-10-20");
    sept = urssafRows(d).find((r) => r.start === "2026-09-01")!;
    expect(sept.state).toBe("declare");
    expect(sept.toProvision).toBe(103200);
    expect(cashOut(d, "2026-01-01", "2026-12-31").urssaf).toBe(0);
    // paiement impossible sans déclaration, possible ensuite
    await expect(db.rpc("finance_urssaf_pay", { p_id: "00000000-0000-0000-0000-00000000abcd", p_paid_on: "2026-10-25", p_amount: "1" })).rejects.toThrow(/non déclarée/);
  });

  test("changement de taux : la déclaration enregistrée reste figée, l'écart est signalé", async () => {
    await setup();
    const p = await db.rpc<{ id: string }>("finance_urssaf_declare", { p_start: "2026-09-01", p_end: "2026-09-30", p_declared_on: "2026-10-12", p_base: "4000", p_amount: "1032", p_estimate: { base: "4000", amount: "1032", rate: "25.800" } });
    // un nouveau taux à effet rétroactif (saisie utilisateur) et un paiement oublié qui change la base
    await db.query(`insert into finance_rates (regime, kind, rate, effective_from, origin, source_url) values ('micro_bnc_ssi', 'social', 30, '2026-09-01', 'user', 'https://www.urssaf.fr/x')`);
    const row = await one<{ declared_amount: string; declared_base: string; estimate_amount_at_declaration: string }>(
      `select declared_amount::text, declared_base::text, estimate_amount_at_declaration::text from finance_urssaf_periods where id = $1`, [p.id]);
    expect(row).toEqual({ declared_amount: "1032.00", declared_base: "4000.00", estimate_amount_at_declaration: "1032.00" });
    const d = await load("2026-10-20");
    const sept = urssafRows(d).find((r) => r.start === "2026-09-01")!;
    expect(sept.record!.declared_amount).toBe(103200);
    expect(sept.toProvision).toBe(103200);
    expect(sept.discrepancy).toEqual({ base: null, amount: 103200 - (120000 + 800) });
    // les périodes de 2025 gardent le taux 2025
    const { estimateContributions, settingsAt } = await import("@/lib/finance/calc");
    const e25 = estimateContributions(settingsAt(d.settings, "2025-06-01"), d.rates, 100000, "2025-06-01");
    expect(e25.status === "estime" && e25.socialRate.rate_milli).toBe(24600);
  });

  test("pas de double comptage : une cotisation payée sort une seule fois, même saisie aussi en charge visible", async () => {
    await setup();
    const p = await db.rpc<{ id: string }>("finance_urssaf_declare", { p_start: "2026-09-01", p_end: "2026-09-30", p_declared_on: "2026-10-12", p_base: "4000", p_amount: "1032" });
    await db.rpc("finance_urssaf_pay", { p_id: p.id, p_paid_on: "2026-10-28", p_amount: "1032", p_idempotency_key: "urssaf-pay-1" });
    await db.rpc("finance_urssaf_pay", { p_id: p.id, p_paid_on: "2026-10-28", p_amount: "1032", p_idempotency_key: "urssaf-pay-1" });
    const out = await db.query(`select * from finance_cash_movements where direction = 'out'`);
    expect(out.rows).toHaveLength(1);
    const d = await load("2026-10-30");
    const c = cashOut(d, "2026-10-01", "2026-10-31");
    expect(c).toMatchObject({ urssaf: 103200, expenses: 0, total: 103200 });
    expect(urssafRows(d).find((r) => r.start === "2026-09-01")!.state).toBe("paye");
    // les cotisations payées n'entrent pas dans « à provisionner », et les charges ne réduisent pas la base
    await db.rpc("finance_save_expense", { p_id: null, p_data: { label: "Logiciel", amount: "500", planned_date: "2026-09-10", status: "paye", paid_on: "2026-09-10" } });
    const d2 = await load("2026-10-30");
    expect(urssafRows(d2).find((r) => r.start === "2026-09-01")!.estimate.base).toBe(400000);
  });

  test("périodes passées : « déjà déclaré » et « déjà payé » en une fois, correction possible", async () => {
    const p = await db.rpc<{ id: string }>("finance_urssaf_declare", { p_start: "2026-01-01", p_end: "2026-01-31", p_declared_on: "2026-02-20", p_base: "3000", p_amount: "774" });
    await db.rpc("finance_urssaf_pay", { p_id: p.id, p_paid_on: "2026-02-20", p_amount: "774" });
    await db.rpc("finance_urssaf_reset", { p_id: p.id, p_what: "payment" });
    expect((await one<{ paid_on: string | null }>(`select paid_on from finance_urssaf_periods`)).paid_on).toBeNull();
  });

  test("régime manuel : aucune estimation présentée comme exacte", async () => {
    await setup();
    await db.rpc("finance_save_settings", { p_data: { effective_from: "2026-09-01", regime: "manual", periodicity: "monthly" } });
    const d = await load("2026-10-10");
    const rows = urssafRows(d);
    expect(rows.find((r) => r.start === "2026-09-01")!.estimate.status).toBe("manuel");
    expect(rows.find((r) => r.start === "2026-09-01")!.toProvision).toBeNull();
  });
});

describe("sécurité", () => {
  test("RLS : un compte non propriétaire ne voit ni n'écrit rien", async () => {
    const c = await company("Acme");
    await invoice(c, { issue_date: "2026-09-01", amount_ht: "100" });
    await db.as("stranger");
    expect((await db.query(`select * from finance_invoice_overview`)).rows).toHaveLength(0);
    expect((await db.query(`select * from finance_rates`)).rows).toHaveLength(0);
    await expect(db.rpc("finance_save_expense", { p_id: null, p_data: { label: "x", planned_date: "2026-01-01" } })).rejects.toThrow(/Accès refusé/);
    await db.as("anon");
    await expect(db.query(`select * from finance_expenses`)).rejects.toThrow();
  });
});
