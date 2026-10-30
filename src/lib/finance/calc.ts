// Calculs du module Finance, centralisés et sans effet de bord (aucune écriture).
// Tous les montants sont en centimes entiers ; un montant inconnu n'est jamais compté zéro :
// il est signalé par un compteur « unknown ».
import {
  addDays,
  addFrequency,
  addMonths,
  declarationPeriod,
  FREQ_MONTHS,
  inRange,
  monthEnd,
  monthsBetween,
  monthStart,
  officialDeadline,
  type Periodicity,
} from "./dates";
import { applyRate, mulDiv, sum, sumKnown, type KnownSum } from "./money";
import type { Expense, FinanceData, Invoice, Mission, Rate, Regime, Settings, Subscription, UrssafPeriod } from "./types";

// ---------------------------------------------------------------------------
// Réglages et taux en vigueur à une date
// ---------------------------------------------------------------------------

export function settingsAt(settings: Settings[], date: string): Settings | null {
  const sorted = [...settings].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let cur: Settings | null = null;
  for (const s of sorted) if (s.effective_from <= date) cur = s;
  return cur ?? sorted[0] ?? null;
}

export function rateAt(rates: Rate[], regime: Regime, kind: Rate["kind"], date: string): Rate | null {
  if (regime === "manual") return null;
  let cur: Rate | null = null;
  for (const r of rates) {
    if (r.regime === regime && r.kind === kind && r.effective_from <= date && (!cur || r.effective_from > cur.effective_from)) cur = r;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Revenus
// ---------------------------------------------------------------------------

const live = (i: Invoice) => !i.cancelled_at;

/** Facturé sur la période (date d'émission), avoirs déduits. */
export function invoicedIn(invoices: Invoice[], from: string, to: string): { ht: number; ttc: number; count: number } {
  let ht = 0;
  let ttc = 0;
  let count = 0;
  for (const i of invoices) {
    if (!live(i) || !inRange(i.issue_date, from, to)) continue;
    const s = i.kind === "avoir" ? -1 : 1;
    ht += s * i.amount_ht;
    ttc += s * i.amount_ttc;
    if (i.kind === "facture") count++;
  }
  return { ht, ttc, count };
}

export const isOpen = (i: Invoice) => i.kind === "facture" && (i.status === "a_encaisser" || i.status === "partielle" || i.status === "en_retard");

/** Ce que les clients doivent encore, à ce jour. */
export function receivables(invoices: Invoice[]) {
  const open = invoices.filter(isOpen);
  const late = open.filter((i) => i.status === "en_retard");
  return { pending: sum(open.map((i) => i.balance)), late: sum(late.map((i) => i.balance)), openCount: open.length, lateCount: late.length, lateInvoices: late };
}

// ---------------------------------------------------------------------------
// Trésorerie réelle (à partir des seuls mouvements réels)
// ---------------------------------------------------------------------------

export function cashIn(data: FinanceData, from: string, to: string) {
  let received = 0;
  let refunded = 0;
  for (const m of data.movements) {
    if (!inRange(m.date, from, to)) continue;
    if (m.source === "paiement_client") received += m.amount;
    if (m.source === "remboursement_client") refunded += m.amount;
  }
  return { received, refunded, net: received - refunded };
}

export function cashOut(data: FinanceData, from: string, to: string) {
  let expenses = 0;
  let urssaf = 0;
  let refunds = 0;
  for (const m of data.movements) {
    if (!inRange(m.date, from, to) || m.direction !== "out") continue;
    if (m.source === "charge") expenses += m.amount;
    else if (m.source === "urssaf") urssaf += m.amount;
    else refunds += m.amount;
  }
  return { expenses, urssaf, refunds, total: expenses + urssaf + refunds };
}

/** Trésorerie de la période = encaissements réels − décaissements réels. */
export function periodCash(data: FinanceData, from: string, to: string) {
  let inflow = 0;
  let outflow = 0;
  for (const m of data.movements) {
    if (!inRange(m.date, from, to)) continue;
    if (m.direction === "in") inflow += m.amount;
    else outflow += m.amount;
  }
  return { inflow, outflow, net: inflow - outflow };
}

/**
 * Solde de trésorerie estimé à une date : uniquement si un solde d'ouverture est saisi
 * (sinon null, jamais un solde inventé).
 */
export function estimatedBalanceAt(data: FinanceData, date: string): number | null {
  if (!data.opening || data.opening.as_of > date) return null;
  const c = periodCash(data, addDays(data.opening.as_of, 1), date);
  return data.opening.amount + c.net;
}

export function monthlyCashSeries(data: FinanceData, from: string, to: string) {
  return monthsBetween(from, to).map((m) => {
    const c = periodCash(data, m, monthEnd(m));
    return { month: m, in: c.inflow, out: c.outflow, net: c.net };
  });
}

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

export const expenseDate = (e: Expense) => e.paid_on ?? e.planned_date;

export function upcomingExpenses(expenses: Expense[], today: string, days = 30) {
  const until = addDays(today, days);
  const soon = expenses.filter((e) => e.status === "a_payer" && e.planned_date >= today && e.planned_date <= until);
  const overdue = expenses.filter((e) => e.status === "a_payer" && e.planned_date < today);
  return { soon, overdue, soonTotal: sumKnown(soon.map((e) => e.amount)), overdueTotal: sumKnown(overdue.map((e) => e.amount)) };
}

export const URSSAF_BUCKET = "__urssaf__";
export const NO_CATEGORY = "__none__";

/** Décaissements payés par catégorie ; les cotisations URSSAF forment un groupe à part (comptées une seule fois). */
export function paidByCategory(data: FinanceData, from: string, to: string) {
  const map = new Map<string, number>();
  for (const m of data.movements) {
    if (!inRange(m.date, from, to) || m.direction !== "out") continue;
    if (m.source === "charge") map.set(m.category_id ?? NO_CATEGORY, (map.get(m.category_id ?? NO_CATEGORY) ?? 0) + m.amount);
    if (m.source === "urssaf") map.set(URSSAF_BUCKET, (map.get(URSSAF_BUCKET) ?? 0) + m.amount);
  }
  const name = (id: string) =>
    id === URSSAF_BUCKET ? "Cotisations URSSAF" : id === NO_CATEGORY ? "Sans catégorie" : data.categories.find((c) => c.id === id)?.name ?? "Catégorie supprimée";
  return [...map.entries()].map(([id, cents]) => ({ id, name: name(id), cents })).sort((a, b) => b.cents - a.cents);
}

export const monthlyEquivalent = (amount: number, f: Subscription["frequency"]) => mulDiv(amount, 1, FREQ_MONTHS[f]);
export const annualEquivalent = (amount: number, f: Subscription["frequency"]) => mulDiv(amount, 12, FREQ_MONTHS[f]);

export const subscriptionActive = (s: Subscription, today: string) => s.status === "actif" && (!s.end_date || s.end_date >= today);

export function subscriptionTotals(subs: Subscription[], today: string) {
  const active = subs.filter((s) => subscriptionActive(s, today));
  return {
    count: active.length,
    monthly: sumKnown(active.map((s) => (s.amount == null ? null : monthlyEquivalent(s.amount, s.frequency)))),
    annual: sumKnown(active.map((s) => (s.amount == null ? null : annualEquivalent(s.amount, s.frequency)))),
  };
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

/** Revenu mensuel récurrent contractuel : missions récurrentes actives, ramenées au mois (HT). */
export function contractualMrr(missions: Mission[]): KnownSum {
  return sumKnown(
    missions
      .filter((m) => m.status === "actif" && m.kind === "recurrent" && m.frequency)
      .map((m) => (m.amount == null ? null : mulDiv(m.amount, 1, FREQ_MONTHS[m.frequency!]))),
  );
}

export function activeClientIds(missions: Mission[]): string[] {
  return [...new Set(missions.filter((m) => m.status === "actif").map((m) => m.company_id))];
}

/** Échéances prévisionnelles d'une mission entre deux dates (jamais des encaissements). */
export function missionDueDates(m: Mission, from: string, to: string): string[] {
  if (!m.next_due_date || m.status === "termine" || m.status === "en_pause") return [];
  if (m.kind === "ponctuel") return inRange(m.next_due_date, from, to) ? [m.next_due_date] : [];
  const out: string[] = [];
  for (let k = 0, d = m.next_due_date; d <= to && k < 400; k++, d = addFrequency(m.next_due_date, m.frequency!, k)) {
    if (m.end_date && d > m.end_date) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Montant restant à facturer prévu à une échéance de mission. */
function missionDueAmount(m: Mission): number | null {
  if (m.amount == null) return null;
  if (m.kind === "recurrent") return m.amount;
  return Math.max(m.amount - m.invoiced_ht, 0);
}

// ---------------------------------------------------------------------------
// URSSAF
// ---------------------------------------------------------------------------

export type UrssafEstimate =
  | { status: "manuel"; base: number; reason: string }
  | { status: "non_calcule"; base: number; reason: string }
  | { status: "taux_manquant"; base: number; reason: string }
  | {
      status: "estime";
      base: number;
      social: number;
      cfp: number;
      total: number;
      socialRate: Rate;
      cfpRate: Rate | null;
      warnings: string[];
    };

/** Base micro-entrepreneur : chiffre d'affaires HT encaissé sur la période (remboursements déduits). */
export function urssafBase(data: FinanceData, start: string, end: string): number {
  let base = 0;
  for (const m of data.movements) {
    if (!inRange(m.date, start, end)) continue;
    if (m.source === "paiement_client") base += m.amount_ht;
    if (m.source === "remboursement_client") base -= m.amount_ht;
  }
  return Math.max(base, 0);
}

export function estimateContributions(settings: Settings | null, rates: Rate[], base: number, start: string): UrssafEstimate {
  if (!settings || settings.regime === "manual") {
    return { status: "manuel", base, reason: "Suivi manuel : saisissez l'estimation, la déclaration et le paiement." };
  }
  if (settings.acre) {
    return { status: "non_calcule", base, reason: "ACRE : taux réduit non calculé par l'application. Reportez le montant indiqué par l'Urssaf." };
  }
  const social = rateAt(rates, settings.regime, "social", start);
  if (!social) {
    return { status: "taux_manquant", base, reason: "Aucun taux vérifié pour ce régime à cette date : ajoutez-le dans les réglages Finance." };
  }
  const cfp = rateAt(rates, settings.regime, "cfp", start);
  const warnings: string[] = [];
  if (!cfp) warnings.push("Contribution à la formation professionnelle non incluse (taux non renseigné).");
  if (settings.versement_liberatoire) warnings.push("Versement libératoire de l'impôt sur le revenu non inclus.");
  const s = applyRate(base, social.rate_milli);
  const c = cfp ? applyRate(base, cfp.rate_milli) : 0;
  return { status: "estime", base, social: s, cfp: c, total: s + c, socialRate: social, cfpRate: cfp, warnings };
}

export type UrssafState = "a_preparer" | "a_declarer" | "declare" | "paye";

export type UrssafRow = {
  start: string;
  end: string;
  record: UrssafPeriod | null;
  estimate: UrssafEstimate;
  deadline: string;
  deadlineOrigin: "regle_officielle" | "saisie";
  state: UrssafState;
  /** montant restant à provisionner (déclaré non payé, sinon estimé) ; null si non estimable */
  toProvision: number | null;
  discrepancy: { base: number | null; amount: number | null } | null;
};

function nextPeriods(from: string, to: string, settings: Settings[]): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let d = from;
  while (d <= to && out.length < 400) {
    const s = settingsAt(settings, d);
    const p = declarationPeriod(d, (s?.periodicity ?? "monthly") as Periodicity);
    out.push(p);
    d = addDays(p.end, 1);
  }
  return out;
}

/** Périodes URSSAF de la première activité jusqu'à la période en cours, avec les trois suivis. */
export function urssafRows(data: FinanceData): UrssafRow[] {
  const firsts = [
    ...data.movements.filter((m) => m.source === "paiement_client").map((m) => m.date),
    ...data.invoices.filter((i) => !i.cancelled_at).map((i) => i.issue_date),
    ...data.urssaf.map((u) => u.period_start),
  ].sort();
  const first = firsts[0] ?? data.today;
  const generated = nextPeriods(monthStart(first), data.today, data.settings);
  const keys = new Map<string, { start: string; end: string }>();
  for (const p of generated) keys.set(`${p.start}|${p.end}`, p);
  for (const u of data.urssaf) keys.set(`${u.period_start}|${u.period_end}`, { start: u.period_start, end: u.period_end });

  return [...keys.values()]
    .sort((a, b) => b.start.localeCompare(a.start))
    .map(({ start, end }) => {
      const record = data.urssaf.find((u) => u.period_start === start && u.period_end === end) ?? null;
      const base = urssafBase(data, start, end);
      const estimate = estimateContributions(settingsAt(data.settings, start), data.rates, base, start);
      const state: UrssafState = record?.paid_on
        ? "paye"
        : record?.declared_on
          ? record.declared_amount === 0
            ? "paye"
            : "declare"
          : end < data.today
            ? "a_declarer"
            : "a_preparer";
      const estTotal = estimate.status === "estime" ? estimate.total : null;
      const toProvision =
        state === "paye" ? 0 : state === "declare" ? record!.declared_amount : estTotal ?? (base === 0 ? 0 : null);
      const discrepancy =
        record?.declared_on && record.declared_base != null
          ? {
              base: record.declared_base !== base ? record.declared_base - base : null,
              amount:
                estimate.status === "estime" && record.declared_amount != null && record.declared_amount !== estimate.total
                  ? record.declared_amount - estimate.total
                  : null,
            }
          : null;
      return {
        start,
        end,
        record,
        estimate,
        deadline: record?.deadline ?? officialDeadline(end),
        deadlineOrigin: record?.deadline && record.deadline_origin === "saisie" ? "saisie" : "regle_officielle",
        state,
        toProvision,
        discrepancy: discrepancy && (discrepancy.base !== null || discrepancy.amount !== null) ? discrepancy : null,
      };
    });
}

export function urssafSummary(rows: UrssafRow[]) {
  const count = (s: UrssafState) => rows.filter((r) => r.state === s).length;
  return {
    a_preparer: count("a_preparer"),
    a_declarer: count("a_declarer"),
    declare: count("declare"),
    paye: count("paye"),
    toProvision: sumKnown(rows.map((r) => r.toProvision)),
  };
}

// ---------------------------------------------------------------------------
// Indicateurs de la vue d'ensemble
// ---------------------------------------------------------------------------

export function periodKpis(data: FinanceData, from: string, to: string) {
  const inv = invoicedIn(data.invoices, from, to);
  const cin = cashIn(data, from, to);
  const cout = cashOut(data, from, to);
  const rec = receivables(data.invoices);
  const up = upcomingExpenses(data.expenses, data.today);
  const rows = urssafRows(data);
  return {
    invoiced: inv,
    received: cin.net,
    pending: rec.pending,
    late: rec.late,
    openCount: rec.openCount,
    lateCount: rec.lateCount,
    expensesPaid: cout.expenses,
    urssafPaid: cout.urssaf,
    upcoming: up.soonTotal,
    overdueExpenses: up.overdueTotal,
    cash: periodCash(data, from, to),
    estimatedBalance: estimatedBalanceAt(data, to < data.today ? to : data.today),
    toProvision: urssafSummary(rows).toProvision,
    activeClients: activeClientIds(data.missions).length,
    mrr: contractualMrr(data.missions),
  };
}

/** Une période a-t-elle des données ? (pour n'afficher une comparaison que si elle a un sens) */
export function hasActivity(data: FinanceData, from: string, to: string): boolean {
  return data.movements.some((m) => inRange(m.date, from, to)) || data.invoices.some((i) => inRange(i.issue_date, from, to));
}

export function upcomingDeadlines(data: FinanceData, days = 45) {
  const until = addDays(data.today, days);
  type D = { date: string; kind: "charge" | "urssaf" | "client"; label: string; amount: number | null; late: boolean; href: string };
  const out: D[] = [];
  for (const e of data.expenses) {
    if (e.status === "a_payer" && e.planned_date <= until) {
      out.push({ date: e.planned_date, kind: "charge", label: e.label, amount: e.amount, late: e.planned_date < data.today, href: "/finance/charges?statut=a_payer" });
    }
  }
  for (const r of urssafRows(data)) {
    if ((r.state === "a_declarer" || r.state === "declare" || r.state === "a_preparer") && r.deadline <= until && r.end < data.today) {
      out.push({
        date: r.deadline,
        kind: "urssaf",
        label: r.state === "declare" ? `Paiement URSSAF (${r.start.slice(0, 7)})` : `Déclaration URSSAF (${r.start.slice(0, 7)})`,
        amount: r.toProvision,
        late: r.deadline < data.today,
        href: "/finance/urssaf",
      });
    }
  }
  for (const i of data.invoices) {
    if (isOpen(i) && i.due_date && i.due_date <= until) {
      out.push({ date: i.due_date, kind: "client", label: `${i.company_name}${i.reference ? ` · ${i.reference}` : ""}`, amount: i.balance, late: i.due_date < data.today, href: `/finance/revenus?facture=${i.id}` });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------
// Prévisions : réalisé / prévu / estimé
// ---------------------------------------------------------------------------

export type ForecastMonth = {
  month: string;
  inRealise: number;
  inPrevu: number;
  inEstime: number;
  outRealise: number;
  outPrevu: number;
  outEstime: number;
  contributions: number; // part estimée des cotisations (incluse dans outEstime / outPrevu)
  unknown: number;
  net: number;
  balance: number | null; // solde estimé fin de mois (si solde d'ouverture)
};

/**
 * Prévision mois par mois, du mois en cours à `months` mois après.
 * - réalisé : mouvements réels du mois en cours jusqu'à aujourd'hui ;
 * - prévu : factures émises non payées, charges planifiées, cotisations déclarées non payées ;
 * - estimé : échéances des missions actives, abonnements à venir, cotisations estimées.
 * Les opportunités du pipeline ne sont jamais comptées.
 */
export function forecast(data: FinanceData, months = 6): ForecastMonth[] {
  const cur = monthStart(data.today);
  const list = [cur, ...Array.from({ length: months }, (_, k) => addMonths(cur, k + 1))];
  const last = monthEnd(list[list.length - 1]);
  const row = new Map<string, ForecastMonth>(
    list.map((m) => [m, { month: m, inRealise: 0, inPrevu: 0, inEstime: 0, outRealise: 0, outPrevu: 0, outEstime: 0, contributions: 0, unknown: 0, net: 0, balance: null }]),
  );
  const slot = (d: string) => row.get(d < cur ? cur : monthStart(d));
  // encaissements HT prévus par mois (base des cotisations futures)
  const baseIn = new Map<string, number>();
  const addBase = (d: string, v: number) => baseIn.set(monthStart(d), (baseIn.get(monthStart(d)) ?? 0) + v);

  for (const m of data.movements) {
    if (!inRange(m.date, cur, data.today)) continue;
    const r = row.get(cur)!;
    if (m.direction === "in") r.inRealise += m.amount;
    else r.outRealise += m.amount;
  }
  for (const i of data.invoices) {
    if (!isOpen(i)) continue;
    const d = i.due_date ?? i.issue_date;
    if (d > last) continue;
    slot(d)!.inPrevu += i.balance;
    addBase(d < cur ? cur : d, i.amount_ttc ? mulDiv(i.balance, i.amount_ht, i.amount_ttc) : i.balance);
  }
  for (const m of data.missions) {
    for (const d of missionDueDates(m, cur, last)) {
      const a = missionDueAmount(m);
      if (a == null) slot(d)!.unknown++;
      else {
        slot(d)!.inEstime += a;
        addBase(d, a);
      }
    }
  }
  for (const e of data.expenses) {
    if (e.status !== "a_payer" || e.planned_date > last) continue;
    if (e.amount == null) slot(e.planned_date)!.unknown++;
    else slot(e.planned_date)!.outPrevu += e.amount;
  }
  for (const s of data.subscriptions) {
    if (s.status !== "actif") continue;
    for (let k = 0, d = s.next_due_date; d <= last && k < 400; k++, d = addFrequency(s.next_due_date, s.frequency, k)) {
      if (s.end_date && d > s.end_date) break;
      if (d < cur) continue;
      if (s.amount == null) slot(d)!.unknown++;
      else slot(d)!.outEstime += s.amount;
    }
  }
  // cotisations : périodes passées/en cours selon le suivi URSSAF, périodes futures sur les encaissements prévus
  const rows = urssafRows(data);
  for (const r of rows) {
    if (r.state === "paye" || r.deadline > last) continue;
    const target = slot(r.deadline)!;
    if (r.state === "declare") target.outPrevu += r.record!.declared_amount ?? 0;
    else if (r.estimate.status === "estime") {
      // période en cours : encaissements déjà reçus + prévus jusqu'à la fin de période
      let extra = 0;
      if (r.end >= data.today) for (const m of monthsBetween(r.start, r.end)) extra += baseIn.get(m) ?? 0;
      const est = estimateContributions(settingsAt(data.settings, r.start), data.rates, r.estimate.base + extra, r.start);
      const v = est.status === "estime" ? est.total : 0;
      target.outEstime += v;
      target.contributions += v;
    } else if (r.estimate.base > 0) target.unknown++;
  }
  const known = new Set(rows.map((r) => r.start));
  for (const p of nextPeriods(addDays(monthEnd(data.today), 1), last, data.settings)) {
    if (known.has(p.start)) continue;
    const dl = officialDeadline(p.end);
    if (dl > last) continue;
    let base = 0;
    for (const m of monthsBetween(p.start, p.end)) base += baseIn.get(m) ?? 0;
    const est = estimateContributions(settingsAt(data.settings, p.start), data.rates, base, p.start);
    if (est.status === "estime") {
      slot(dl)!.outEstime += est.total;
      slot(dl)!.contributions += est.total;
    } else if (base > 0) slot(dl)!.unknown++;
  }

  let balance = estimatedBalanceAt(data, data.today);
  return list.map((m) => {
    const r = row.get(m)!;
    r.net = r.inRealise + r.inPrevu + r.inEstime - (r.outRealise + r.outPrevu + r.outEstime);
    if (balance !== null) {
      // le réalisé du mois en cours est déjà dans le solde à aujourd'hui
      balance += r.net - (m === cur ? r.inRealise - r.outRealise : 0);
      r.balance = balance;
    }
    return r;
  });
}

// ---------------------------------------------------------------------------
// EBITDA indicatif
// ---------------------------------------------------------------------------

export function ebitda(data: FinanceData, from: string, to: string, opts: { includeUrssaf: boolean }) {
  const income = invoicedIn(data.invoices, from, to).ht;
  const byCat = new Map<string, { cents: number; unknown: number; count: number }>();
  for (const e of data.expenses) {
    if (e.status === "annule" || !inRange(expenseDate(e), from, to)) continue;
    const k = e.category_id ?? NO_CATEGORY;
    const cur = byCat.get(k) ?? { cents: 0, unknown: 0, count: 0 };
    const v = e.amount_ht ?? e.amount;
    if (v == null) cur.unknown++;
    else cur.cents += v;
    cur.count++;
    byCat.set(k, cur);
  }
  const included: { id: string; name: string; cents: number; unknown: number }[] = [];
  const excluded: { id: string; name: string; cents: number; unknown: number }[] = [];
  for (const [id, v] of byCat) {
    const cat = data.categories.find((c) => c.id === id);
    const item = { id, name: cat?.name ?? "Sans catégorie", cents: v.cents, unknown: v.unknown };
    if (!cat || cat.ebitda_included) included.push(item);
    else excluded.push(item);
  }
  // cotisations URSSAF des périodes qui commencent dans l'intervalle : déclaré sinon estimé
  let urssaf = 0;
  let urssafUnknown = 0;
  if (opts.includeUrssaf) {
    for (const r of urssafRows(data)) {
      if (!inRange(r.start, from, to)) continue;
      const v = r.record?.declared_amount ?? (r.estimate.status === "estime" ? r.estimate.total : null);
      if (v == null) {
        if (r.estimate.base > 0) urssafUnknown++;
      } else urssaf += v;
    }
  }
  const opex = sum(included.map((i) => i.cents));
  return {
    income,
    included: included.sort((a, b) => b.cents - a.cents),
    excluded: excluded.sort((a, b) => b.cents - a.cents),
    opex,
    urssaf,
    unknown: sum(included.map((i) => i.unknown)) + urssafUnknown,
    value: income - opex - urssaf,
  };
}

// ---------------------------------------------------------------------------
// Simulation (ne lit que les calculs, n'écrit jamais)
// ---------------------------------------------------------------------------

export type SimulationInput = {
  extraRecurring: number; // centimes HT par mois
  revenueChangePct: number; // entier, -100 à +500
  newMonthlyExpense: number; // centimes par mois
  endSubscriptionId: string | null;
};

/** Moyenne mensuelle des mois M+1 à M+3 de la prévision, puis effet des hypothèses. */
export function simulate(data: FinanceData, input: SimulationInput) {
  const f = forecast(data, 3).slice(1);
  const n = f.length || 1;
  const avg = (pick: (m: ForecastMonth) => number) => mulDiv(sum(f.map(pick)), 1, n);
  const baseIn = avg((m) => m.inPrevu + m.inEstime);
  const baseContrib = avg((m) => m.contributions);
  const baseOut = avg((m) => m.outPrevu + m.outEstime) - baseContrib;

  const s = settingsAt(data.settings, data.today);
  const est = s ? estimateContributions(s, data.rates, 100000, data.today) : null;
  // taux effectif (millièmes de %) appliqué aux variations de recettes ; 0 si non estimable
  const contribMilli = est && est.status === "estime" ? est.socialRate.rate_milli + (est.cfpRate?.rate_milli ?? 0) : 0;

  const changed = baseIn + mulDiv(baseIn, Math.trunc(input.revenueChangePct), 100);
  const simIn = changed + input.extraRecurring;
  const sub = input.endSubscriptionId ? data.subscriptions.find((x) => x.id === input.endSubscriptionId) : null;
  const saved = sub?.amount != null ? monthlyEquivalent(sub.amount, sub.frequency) : 0;
  const simOut = baseOut + input.newMonthlyExpense - saved;
  const simContrib = baseContrib + applyRate(simIn - baseIn, contribMilli);

  const view = (inc: number, out: number, contrib: number) => ({
    in: inc,
    out,
    contributions: contrib,
    net: inc - out - contrib,
    marginPct: inc > 0 ? Math.round(((inc - out - contrib) * 1000) / inc) / 10 : null,
  });
  return {
    before: view(baseIn, baseOut, baseContrib),
    after: view(simIn, simOut, simContrib),
    contributionRateMilli: contribMilli,
    savedSubscription: saved,
    months: n,
  };
}
