// Calculs Finance en centimes : montants, dates, URSSAF, prévisions, EBITDA, simulation.
import { describe, expect, test } from "vitest";
import { applyRate, centsToDb, mulDiv, parseEuroInput, rateToMilli, sumKnown, toCents } from "@/lib/finance/money";
import { addFrequency, addMonths, officialDeadline, previousPeriod, resolvePeriod } from "@/lib/finance/dates";
import { ebitda, estimateContributions, forecast, simulate, urssafRows } from "@/lib/finance/calc";
import type { CashMovement, FinanceData, Rate, Settings } from "@/lib/finance/types";

const SETTINGS: Settings = { id: "s1", effective_from: "2024-01-01", regime: "micro_bnc_ssi", periodicity: "monthly", acre: false, versement_liberatoire: false, vat_enabled: false, note: null };
const RATES: Rate[] = [
  { id: "r1", regime: "micro_bnc_ssi", kind: "social", rate_milli: 24600, effective_from: "2025-01-01", origin: "official", source_url: null, verified_on: null, note: null },
  { id: "r2", regime: "micro_bnc_ssi", kind: "social", rate_milli: 25600, effective_from: "2026-01-01", origin: "official", source_url: null, verified_on: null, note: null },
  { id: "r3", regime: "micro_bnc_ssi", kind: "cfp", rate_milli: 200, effective_from: "2025-01-01", origin: "official", source_url: null, verified_on: null, note: null },
];
const mv = (date: string, amount: number, source: CashMovement["source"] = "paiement_client"): CashMovement => ({
  id: `${date}-${amount}-${source}`, date, amount, amount_ht: amount, source, direction: source === "paiement_client" ? "in" : "out",
  company_id: null, category_id: null, invoice_id: null, expense_id: null, urssaf_period_id: null, label: "",
});
function data(over: Partial<FinanceData> = {}): FinanceData {
  return { today: "2026-10-30", settings: [SETTINGS], rates: RATES, opening: null, missions: [], invoices: [], payments: [], categories: [], expenses: [], subscriptions: [], urssaf: [], movements: [], ...over };
}

describe("montants en centimes", () => {
  test("lecture et écriture sans flottant", () => {
    expect(toCents("1234.56")).toBe(123456);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents("10")).toBe(1000);
    expect(toCents(null)).toBeNull();
    expect(centsToDb(123456)).toBe("1234.56");
    expect(centsToDb(-5)).toBe("-0.05");
    expect(parseEuroInput("1 234,5 €")).toBe(123450);
    expect(parseEuroInput("")).toBeNull();
    expect(parseEuroInput("12,345")).toBeNaN();
  });
  test("taux et arrondis au centime", () => {
    expect(rateToMilli("25.600")).toBe(25600);
    expect(rateToMilli(0.2)).toBe(200);
    expect(applyRate(400000, 25600)).toBe(102400);
    expect(applyRate(333, 25600)).toBe(85); // 85,248 → 85
    expect(mulDiv(100, 1, 3)).toBe(33);
    expect(mulDiv(24000, 1, 12)).toBe(2000);
  });
  test("un montant inconnu n'est pas un zéro", () => {
    expect(sumKnown([100, null, 50])).toEqual({ cents: 150, unknown: 1 });
  });
});

describe("dates et périodes", () => {
  test("ajout de mois en fin de mois, fréquences", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addFrequency("2026-03-15", "annuel")).toBe("2027-03-15");
    expect(addFrequency("2026-11-30", "trimestriel")).toBe("2027-02-28");
  });
  test("échéance officielle : fin du mois suivant la période", () => {
    expect(officialDeadline("2026-02-28")).toBe("2026-03-31");
    expect(officialDeadline("2026-09-30")).toBe("2026-10-31");
    expect(officialDeadline("2026-12-31")).toBe("2027-01-31");
  });
  test("sélecteur : mois, trimestre, année, personnalisée et période précédente", () => {
    expect(resolvePeriod("trimestre", "2026-10-30")).toMatchObject({ from: "2026-10-01", to: "2026-12-31", label: "T4 2026" });
    expect(resolvePeriod("annee", "2026-10-30")).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(previousPeriod(resolvePeriod("mois", "2026-03-15"))).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(previousPeriod(resolvePeriod("perso", "x", "2026-10-11", "2026-10-20"))).toMatchObject({ from: "2026-10-01", to: "2026-10-10" });
    expect(resolvePeriod("perso", "2026-10-30", "2026-10-20", "2026-10-01").kind).toBe("mois");
  });
});

describe("URSSAF", () => {
  test("taux selon la date de la période ; ACRE et régime manuel non estimés", () => {
    const e25 = estimateContributions(SETTINGS, RATES, 100000, "2025-12-01");
    const e26 = estimateContributions(SETTINGS, RATES, 100000, "2026-01-01");
    expect(e25).toMatchObject({ status: "estime", total: 24800 });
    expect(e26).toMatchObject({ status: "estime", total: 25800 });
    expect(estimateContributions(SETTINGS, RATES, 100000, "2024-06-01").status).toBe("taux_manquant");
    expect(estimateContributions({ ...SETTINGS, acre: true }, RATES, 100000, "2026-01-01").status).toBe("non_calcule");
    expect(estimateContributions({ ...SETTINGS, regime: "manual" }, RATES, 100000, "2026-01-01").status).toBe("manuel");
    const vl = estimateContributions({ ...SETTINGS, versement_liberatoire: true }, RATES, 100000, "2026-01-01");
    expect(vl.status === "estime" && vl.warnings[0]).toMatch(/libératoire/);
  });
  test("périodicité trimestrielle à partir d'une date d'effet", () => {
    const d = data({
      settings: [SETTINGS, { ...SETTINGS, id: "s2", effective_from: "2026-07-01", periodicity: "quarterly" }],
      movements: [mv("2026-05-10", 100000), mv("2026-08-10", 200000)],
    });
    const rows = urssafRows(d).map((r) => [r.start, r.end, r.state, r.estimate.base]);
    expect(rows).toEqual([
      ["2026-10-01", "2026-12-31", "a_preparer", 0],
      ["2026-07-01", "2026-09-30", "a_declarer", 200000],
      ["2026-06-01", "2026-06-30", "a_declarer", 0],
      ["2026-05-01", "2026-05-31", "a_declarer", 100000],
    ]);
  });
});

describe("prévisions, EBITDA et simulation", () => {
  const mission = {
    id: "m1", company_id: "c1", company_name: "Acme", label: "Retainer", status: "actif" as const, kind: "recurrent" as const, start_date: null, end_date: "2027-01-31",
    amount: 200000, frequency: "mensuel" as const, next_due_date: "2026-11-01", note: null, invoiced_ht: 0, invoiced_ttc: 0, received: 0, remaining: 0,
  };
  test("cotisations estimées sur les encaissements prévus, payées le mois suivant", () => {
    const f = forecast(data({ missions: [mission] }), 4);
    expect(f.map((m) => m.inEstime)).toEqual([0, 200000, 200000, 200000, 0]);
    // novembre encaissé → cotisations fin décembre (25,8 % de 2 000 €)
    expect(f.map((m) => m.contributions)).toEqual([0, 0, 51600, 51600, 51600]);
    expect(f.every((m) => m.balance === null)).toBe(true);
    const withOpening = forecast(data({ missions: [mission], opening: { amount: 100000, as_of: "2026-10-01" } }), 1);
    expect(withOpening[1].balance).toBe(100000 + 200000);
  });
  test("EBITDA : catégories exclues et cotisations optionnelles", () => {
    const d = data({
      categories: [{ id: "k1", name: "Logiciels", position: 1, ebitda_included: true }, { id: "k2", name: "Intérêts", position: 2, ebitda_included: false }],
      invoices: [{ id: "i1", kind: "facture", company_id: "c1", company_name: "Acme", mission_id: null, mission_label: null, credited_invoice_id: null, reference: null, issue_date: "2026-09-05", due_date: null, amount_ht: 500000, vat_rate: null, vat_amount: null, amount_ttc: 500000, forecast_due_date: null, note: null, cancelled_at: null, cancel_reason: null, paid_net: 500000, refunded: 0, credited: 0, balance: 0, last_paid_on: "2026-09-10", status: "payee", created_at: "" }],
      movements: [mv("2026-09-10", 500000)],
      expenses: [
        { id: "e1", label: "Notion", supplier: null, category_id: "k1", amount: 10000, amount_ht: null, vat_amount: null, planned_date: "2026-09-02", paid_on: "2026-09-02", status: "paye", subscription_id: null, note: null },
        { id: "e2", label: "Prêt", supplier: null, category_id: "k2", amount: 5000, amount_ht: null, vat_amount: null, planned_date: "2026-09-02", paid_on: "2026-09-02", status: "paye", subscription_id: null, note: null },
        { id: "e3", label: "Annulée", supplier: null, category_id: "k1", amount: 99999, amount_ht: null, vat_amount: null, planned_date: "2026-09-03", paid_on: null, status: "annule", subscription_id: null, note: null },
      ],
    });
    const a = ebitda(d, "2026-09-01", "2026-09-30", { includeUrssaf: false });
    expect(a).toMatchObject({ income: 500000, opex: 10000, urssaf: 0, value: 490000 });
    expect(a.excluded.map((x) => x.name)).toEqual(["Intérêts"]);
    const b = ebitda(d, "2026-09-01", "2026-09-30", { includeUrssaf: true });
    expect(b.urssaf).toBe(129000);
    expect(b.value).toBe(500000 - 10000 - 129000);
  });
  test("simulation : nouveau client récurrent et nouvelle charge, sans rien écrire", () => {
    const d = data({ missions: [mission] });
    const before = JSON.stringify(d);
    const r = simulate(d, { extraRecurring: 100000, revenueChangePct: 0, newMonthlyExpense: 20000, endSubscriptionId: null });
    expect(r.after.in - r.before.in).toBe(100000);
    expect(r.after.out - r.before.out).toBe(20000);
    expect(r.after.contributions - r.before.contributions).toBe(25800);
    expect(r.after.net - r.before.net).toBe(100000 - 20000 - 25800);
    expect(JSON.stringify(d)).toBe(before);
  });
});
