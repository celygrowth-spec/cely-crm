// Audit, lot 3 : états d'encaissement (C05), revenu terminé exclu (C05 b), avoir (C05 d), TVA des prévisions (K14).
import { describe, expect, test } from "vitest";
import { activeClientIds, contractualMrr, forecast, vatRateFor, withVat } from "@/lib/finance/calc";
import { oneOffRemaining, revenueStatus, revenueStatusLabel } from "@/lib/finance/revenues";
import type { FinanceData, Invoice, Mission, Settings } from "@/lib/finance/types";

const TODAY = "2026-10-30";
const SETTINGS: Settings = { id: "s1", effective_from: "2024-01-01", regime: "micro_bnc_ssi", periodicity: "monthly", acre: false, versement_liberatoire: false, vat_enabled: false, note: null };
const mission = (over: Partial<Mission> = {}): Mission => ({
  id: "m1", company_id: "c1", company_name: "Acme", label: "Audit", status: "actif", kind: "ponctuel", start_date: "2026-10-15", end_date: null,
  amount: 300000, frequency: null, next_due_date: "2026-10-15", note: null, invoiced_ht: 0, billed_ht: 0, invoiced_ttc: 0, received: 0, remaining: 0, ...over,
});
const invoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: "i1", kind: "facture", company_id: "c1", company_name: "Acme", mission_id: "m1", mission_label: "Audit", credited_invoice_id: null, reference: null,
  issue_date: "2026-10-15", due_date: null, amount_ht: 100000, vat_rate: null, vat_amount: null, amount_ttc: 100000, forecast_due_date: "2026-10-15",
  note: null, cancelled_at: null, cancel_reason: null, paid_net: 100000, refunded: 0, credited: 0, balance: 0, last_paid_on: "2026-10-16", status: "payee", created_at: "", ...over,
});
const data = (over: Partial<FinanceData>): FinanceData => ({
  today: TODAY, settings: [SETTINGS], rates: [], opening: null, missions: [], invoices: [], payments: [], categories: [], expenses: [], subscriptions: [], urssaf: [], movements: [], ...over,
});

describe("C05 — « Encaissé » seulement quand tout est facturé et réglé", () => {
  test("acompte de 1 000 € réglé sur 3 000 € : partiellement encaissé ; solde réglé : encaissé", () => {
    const m = mission({ billed_ht: 100000, invoiced_ht: 100000, received: 100000 });
    expect(revenueStatus(m, [invoice()], TODAY)).toBe("partiel");
    expect(revenueStatusLabel("partiel", "ponctuel")).toBe("Partiellement encaissé");
    expect(oneOffRemaining(m)).toBe(200000);
    const full = mission({ billed_ht: 300000, invoiced_ht: 300000, received: 300000 });
    expect(revenueStatus(full, [invoice(), invoice({ id: "i2", amount_ht: 200000, amount_ttc: 200000 })], TODAY)).toBe("encaisse");
  });
  test("mensuel : un mois réglé ne vaut pas « Encaissé » ; échéance due non facturée = en retard", () => {
    const m = mission({ kind: "recurrent", frequency: "mensuel", start_date: "2026-09-01", next_due_date: "2026-11-01", amount: 100000 });
    const sept = invoice({ forecast_due_date: "2026-09-01", issue_date: "2026-09-01" });
    expect(revenueStatus(m, [sept], TODAY)).toBe("en_retard"); // octobre non facturé
    expect(revenueStatus(m, [sept, invoice({ id: "i2", forecast_due_date: "2026-10-01", issue_date: "2026-10-01" })], TODAY)).toBe("a_jour");
    expect(revenueStatusLabel("partiel", "recurrent")).toBe("Partiellement réglé");
  });
  test("un avoir ne fait pas remonter le reste à facturer", () => {
    expect(oneOffRemaining(mission({ billed_ht: 300000, invoiced_ht: 250000 }))).toBe(0);
  });
});

describe("C05 b — un contrat terminé n'est plus compté", () => {
  test("revenu mensuel récurrent et clients actifs à la date", () => {
    const ended = mission({ id: "m2", company_id: "c2", kind: "recurrent", frequency: "mensuel", amount: 50000, end_date: "2026-09-30" });
    const live = mission({ id: "m3", company_id: "c3", kind: "recurrent", frequency: "mensuel", amount: 80000 });
    expect(contractualMrr([ended, live], TODAY)).toEqual({ cents: 80000, unknown: 0 });
    expect(activeClientIds([ended, live], TODAY)).toEqual(["c3"]);
  });
});

describe("K14 — prévisions en TTC comme les factures, base des cotisations en HT", () => {
  test("taux de la dernière facture, sinon 20 % si TVA activée", () => {
    const m = mission({ kind: "recurrent", frequency: "mensuel", start_date: "2026-11-01", next_due_date: "2026-11-01", amount: 100000 });
    expect(vatRateFor(m, { invoices: [], settings: [SETTINGS] }, TODAY)).toBe(0);
    expect(vatRateFor(m, { invoices: [], settings: [{ ...SETTINGS, vat_enabled: true }] }, TODAY)).toBe(2000);
    expect(vatRateFor(m, { invoices: [invoice({ vat_rate: "10", amount_ttc: 110000 })], settings: [SETTINGS] }, TODAY)).toBe(1000);
    expect(withVat(33333, 2000)).toBe(40000); // 6 666,6 → 6 667 centimes, comme round(…, 2) en base
    const f = forecast(data({ missions: [m], settings: [{ ...SETTINGS, vat_enabled: true }] }), 1);
    expect(f[1].inEstime).toBe(120000);
  });
});
