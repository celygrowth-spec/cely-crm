// Finance — revenus unifiés : ponctuel / mensuel, échéances, encaissement, arrêt, et cohérence des
// chiffres de l'accueil avec les lignes de détail (aucun double comptage). Vraies migrations (PGlite).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { buildFinanceData } from "@/lib/finance/service";
import { forecast, homeKpis, openInvoicesAt, realSeries, receivableAging } from "@/lib/finance/calc";
import { forecastDues, monthlyDues, previewDates, revenueStatus } from "@/lib/finance/revenues";
import type { FinanceData } from "@/lib/finance/types";

let db: Db;
let client: string;
beforeEach(async () => {
  db = await createDb();
  client = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Client A" }, p_people: [], p_force: true })).id;
});

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
const add = (data: Record<string, unknown>, key: string | null = null) =>
  db.rpc<{ id: string; invoice_id: string | null }>("finance_add_revenue", { p_data: { company_id: client, label: "Accompagnement", ...data }, p_idempotency_key: key });
const settle = (mission: string, data: Record<string, unknown>, key: string | null = null) =>
  db.rpc<{ id: string }>("finance_settle_due", { p_mission: mission, p_data: data, p_idempotency_key: key });
const pay = (invoice: string, date: string, amount: string) =>
  db.rpc("finance_record_payment", { p_invoice: invoice, p_paid_on: date, p_amount: amount, p_kind: "paiement", p_note: null, p_idempotency_key: null });
const eur = (n: number) => n / 100;

describe("échéances", () => {
  test("jour habituel ; 31 → dernier jour du mois, puis retour au 31", () => {
    expect(previewDates("2026-11-10", null, 3)).toEqual(["2026-11-10", "2026-12-10", "2027-01-10"]);
    expect(previewDates("2027-01-31", null, 4)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
    expect(previewDates("2027-01-31", "2027-03-15", 6)).toEqual(["2027-01-31", "2027-02-28"]);
  });

  test("la base calcule les mêmes échéances (31 janvier)", async () => {
    const d = await db.query<{ d: string }>(`select public.finance_due_date('2027-01-31', 'mensuel', k)::text d from generate_series(0, 3) k`);
    expect(d.rows.map((r) => r.d)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });
});

describe("revenus", () => {
  test("1. ponctuel : créé, puis encaissé depuis sa ligne ; déjà reçu à la création", async () => {
    const { id } = await add({ kind: "ponctuel", amount: "1200", date: "2026-11-20" }, "revenu-key-000000000001");
    expect((await add({ kind: "ponctuel", amount: "1200", date: "2026-11-20" }, "revenu-key-000000000001")).id).toBe(id); // double clic
    let data = await load("2026-11-06");
    const m = data.missions.find((x) => x.id === id)!;
    expect(revenueStatus(m, data.invoices, data.today)).toBe("prevu");
    expect(forecastDues(m, data.invoices, "2026-11-01", "2026-11-30")).toEqual([{ date: "2026-11-20", amount: 120000 }]);
    await settle(id, { due_date: "2026-11-20", amount: "1200", paid_on: "2026-11-21" });
    data = await load("2026-11-30");
    expect(revenueStatus(data.missions.find((x) => x.id === id)!, data.invoices, data.today)).toBe("encaisse");
    expect(forecastDues(data.missions.find((x) => x.id === id)!, data.invoices, "2026-11-01", "2026-12-31")).toEqual([]);
    expect(eur(homeKpis(data, "2026-11-01", "2026-11-30").received)).toBe(1200);
    // déjà reçu au moment de la saisie : facture + règlement rattachés en une fois
    const r = await add({ kind: "ponctuel", amount: "300", date: "2026-11-05", received: { paid_on: "2026-11-04" } });
    expect(r.invoice_id).toBeTruthy();
    data = await load("2026-11-30");
    expect(eur(homeKpis(data, "2026-11-01", "2026-11-30").received)).toBe(1500);
  });

  test("2. mensuel sans fin : apparaît dans les prévisions des mois suivants", async () => {
    const { id } = await add({ kind: "mensuel", amount: "400", date: "2026-11-10" });
    const data = await load("2026-11-06");
    const f = forecast(data, 6);
    expect(f.map((x) => eur(x.inEstime))).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(revenueStatus(data.missions.find((x) => x.id === id)!, data.invoices, data.today)).toBe("prevu"); // première échéance à venir
  });

  test("3. date de fin : les échéances s'arrêtent ; arrêter puis modifier pour la suite garde l'historique", async () => {
    const { id } = await add({ kind: "mensuel", amount: "400", date: "2026-11-10", end_date: "2027-01-31" });
    let data = await load("2026-11-06");
    expect(forecast(data, 6).map((x) => eur(x.inEstime))).toEqual([400, 400, 400, 0, 0, 0, 0]);
    // novembre encaissé, puis passage à 500 € pour la suite
    await settle(id, { due_date: "2026-11-10", amount: "400", paid_on: "2026-11-10" });
    await db.rpc("finance_update_revenue", { p_mission: id, p_data: { amount: "500", end_date: null } });
    data = await load("2026-11-12");
    const m = data.missions.find((x) => x.id === id)!;
    const dues = monthlyDues(m, data.invoices, "2026-11-01", "2027-01-31", data.today);
    expect(dues.map((d) => [d.date, eur(d.amount!), d.state])).toEqual([
      ["2026-11-10", 400, "encaissee"], ["2026-12-10", 500, "prevue"], ["2027-01-10", 500, "prevue"],
    ]);
    // arrêt au 31 décembre : janvier disparaît, novembre reste encaissé
    await db.rpc("finance_stop_revenue", { p_mission: id, p_end: "2026-12-31" });
    data = await load("2026-11-12");
    expect(forecast(data, 3).map((x) => eur(x.inEstime))).toEqual([0, 500, 0, 0]);
    expect(eur(homeKpis(data, "2026-11-01", "2026-11-30").received)).toBe(400);
    await expect(db.rpc("finance_update_revenue", { p_mission: id, p_data: { amount: "500", date: "2026-11-15" } })).rejects.toThrow(/déjà facturées/);
  });

  test("4. paiement reçu le mois suivant : compté dans le mois de réception", async () => {
    const { id } = await add({ kind: "mensuel", amount: "400", date: "2026-11-10" });
    await settle(id, { due_date: "2026-11-10", amount: "400", paid_on: "2026-12-03" });
    const data = await load("2026-12-05");
    expect(eur(homeKpis(data, "2026-11-01", "2026-11-30").received)).toBe(0);
    expect(eur(homeKpis(data, "2026-12-01", "2026-12-31").received)).toBe(400);
    // à la fin de novembre, la facture était encore due
    expect(eur(homeKpis(data, "2026-11-01", "2026-11-30").outstanding)).toBe(400);
    expect(eur(homeKpis(data, "2026-12-01", "2026-12-31").outstanding)).toBe(0);
    expect(realSeries(data, "2026-11-01", "2026-12-31").map((r) => eur(r.in))).toEqual([0, 400]);
  });

  test("5. paiement partiel : le reste dû diminue, et le retard est signalé", async () => {
    const { id } = await add({ kind: "ponctuel", amount: "1000", date: "2026-10-15" });
    const inv = (await settle(id, { due_date: "2026-10-15", amount: "1000", paid_on: "2026-10-20", paid_amount: "300" })).id;
    let data = await load("2026-11-06");
    let k = homeKpis(data, "2026-11-01", "2026-11-30");
    expect([eur(k.outstanding), eur(k.late), k.lateCount]).toEqual([700, 700, 1]);
    expect(revenueStatus(data.missions.find((x) => x.id === id)!, data.invoices, data.today)).toBe("en_retard");
    expect(receivableAging(data)[0]).toMatchObject({ key: "retard", total: 70000, ids: [inv] });
    await pay(inv, "2026-11-08", "700");
    data = await load("2026-11-10");
    k = homeKpis(data, "2026-11-01", "2026-11-30");
    expect([eur(k.received), eur(k.outstanding)]).toEqual([700, 0]);
  });

  test("6. échéance + facture + règlement : comptés une seule fois", async () => {
    const { id } = await add({ kind: "mensuel", amount: "400", date: "2026-11-10" });
    let data = await load("2026-11-06");
    const before = forecast(data, 1)[0];
    expect(eur(before.inEstime + before.inPrevu)).toBe(400);
    // facture seule : la prévision devient une facture à encaisser (pas 800)
    const inv = (await settle(id, { due_date: "2026-11-10", amount: "400" })).id;
    data = await load("2026-11-06");
    const mid = forecast(data, 1)[0];
    expect([eur(mid.inEstime), eur(mid.inPrevu)]).toEqual([0, 400]);
    expect(eur(homeKpis(data, "2026-11-01", "2026-11-30").outstanding)).toBe(400);
    // une seconde facture sur la même échéance est refusée
    await expect(settle(id, { due_date: "2026-11-10", amount: "400" })).rejects.toThrow(/déjà une facture/);
    await expect(settle(id, { due_date: "2026-11-11", amount: "400" })).rejects.toThrow(/pas une échéance/);
    // règlement : encaissé 400, plus rien à encaisser ni de prévision pour novembre
    await pay(inv, "2026-11-10", "400");
    data = await load("2026-11-12");
    const after = forecast(data, 1)[0];
    expect([eur(after.inRealise), eur(after.inPrevu), eur(after.inEstime)]).toEqual([400, 0, 0]);
    const k = homeKpis(data, "2026-11-01", "2026-11-30");
    expect([eur(k.received), eur(k.outstanding)]).toEqual([400, 0]);
    // facture saisie à la main sur l'ancien parcours (même mois, sans rattachement) : couvre aussi l'échéance de décembre
    await db.rpc("finance_record_invoice", { p_data: { company_id: client, mission_id: id, issue_date: "2026-12-02", amount_ht: "400" }, p_idempotency_key: null });
    data = await load("2026-11-12");
    expect(forecast(data, 1).map((x) => eur(x.inEstime))).toEqual([0, 0]);
  });

  test("7. données existantes : anciennes missions et factures lisibles, cartes = lignes de détail", async () => {
    // ancien parcours : mission récurrente (next_due_date seulement), facture et paiement sans rattachement
    const legacy = (await db.rpc<{ id: string }>("finance_save_mission", { p_id: null, p_data: { company_id: client, label: "Ancien contrat", kind: "recurrent", frequency: "mensuel", amount: "250", next_due_date: "2026-11-05" }, p_idempotency_key: null })).id;
    const old = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: client, issue_date: "2026-10-01", due_date: "2026-10-31", amount_ht: "800" }, p_idempotency_key: null })).id;
    await pay(old, "2026-11-03", "500");
    await db.query(`insert into finance_expenses (label, amount, planned_date, paid_on, status) values ('Logiciel', 30, '2026-11-02', '2026-11-02', 'paye')`);
    const data = await load("2026-11-06");
    const m = data.missions.find((x) => x.id === legacy)!;
    expect(monthlyDues(m, data.invoices, "2026-11-01", "2027-01-31", data.today).map((d) => d.date)).toEqual(["2026-11-05", "2026-12-05", "2027-01-05"]);
    const k = homeKpis(data, "2026-11-01", "2026-11-30");
    // cartes = somme des lignes de détail
    const detailIn = data.movements.filter((x) => x.source === "paiement_client" && x.date >= "2026-11-01" && x.date <= "2026-11-30").reduce((a, x) => a + x.amount, 0);
    const detailOut = data.movements.filter((x) => (x.source === "charge" || x.source === "urssaf") && x.date >= "2026-11-01" && x.date <= "2026-11-30").reduce((a, x) => a + x.amount, 0);
    expect(k.received).toBe(detailIn);
    expect(k.spent).toBe(detailOut);
    expect(k.outstanding).toBe(openInvoicesAt(data, "2026-11-30").rows.reduce((a, r) => a + r.balance, 0));
    expect([eur(k.received), eur(k.outstanding), eur(k.late), eur(k.spent)]).toEqual([500, 300, 300, 30]);
  });
});
