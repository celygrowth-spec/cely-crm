// Lecture des données Finance (sous RLS, client authentifié) et conversion en centimes.
import type { SupabaseClient } from "@supabase/supabase-js";
import { CrmError, fetchAll, friendlyError } from "@/lib/crm/service";
import { addDays } from "./dates";
import { rateToMilli, toCents } from "./money";
import type {
  CashMovement,
  Category,
  Expense,
  FinanceData,
  Invoice,
  Mission,
  Payment,
  Rate,
  Settings,
  Subscription,
  UrssafPeriod,
} from "./types";

type Row = Record<string, unknown>;
const c = (v: unknown) => toCents(v as number | string | null);
const cc = (v: unknown) => c(v) ?? 0;

async function all(sb: SupabaseClient, table: string, order: string): Promise<Row[]> {
  const { data, error } = await fetchAll<Row>((f, t) => sb.from(table).select("*").order(order).order("id").range(f, t));
  if (error) throw new CrmError(error);
  return data;
}

export const mapMission = (r: Row): Mission => ({
  ...(r as unknown as Mission),
  amount: c(r.amount),
  invoiced_ht: cc(r.invoiced_ht),
  invoiced_ttc: cc(r.invoiced_ttc),
  received: cc(r.received),
  remaining: cc(r.remaining),
});

export const mapInvoice = (r: Row): Invoice => ({
  ...(r as unknown as Invoice),
  vat_rate: r.vat_rate == null ? null : String(r.vat_rate),
  amount_ht: cc(r.amount_ht),
  vat_amount: c(r.vat_amount),
  amount_ttc: cc(r.amount_ttc),
  paid_net: cc(r.paid_net),
  refunded: cc(r.refunded),
  credited: cc(r.credited),
  balance: cc(r.balance),
});

const mapExpense = (r: Row): Expense => ({ ...(r as unknown as Expense), amount: c(r.amount), amount_ht: c(r.amount_ht), vat_amount: c(r.vat_amount) });
const mapSub = (r: Row): Subscription => ({ ...(r as unknown as Subscription), amount: c(r.amount), amount_ht: c(r.amount_ht) });
const mapUrssaf = (r: Row): UrssafPeriod => ({
  ...(r as unknown as UrssafPeriod),
  declared_base: c(r.declared_base),
  declared_amount: c(r.declared_amount),
  estimate_base_at_declaration: c(r.estimate_base_at_declaration),
  estimate_amount_at_declaration: c(r.estimate_amount_at_declaration),
  estimate_rate_at_declaration: r.estimate_rate_at_declaration == null ? null : rateToMilli(r.estimate_rate_at_declaration as string),
  paid_amount: c(r.paid_amount),
});

/**
 * Charge toutes les données Finance (volume d'un freelance : quelques centaines de lignes).
 * Avec `sync`, crée d'abord les échéances d'abonnement jusqu'à J+31 (idempotent).
 */
export async function loadFinance(sb: SupabaseClient, today: string, opts: { sync?: boolean } = {}): Promise<FinanceData> {
  if (opts.sync) {
    const { error } = await sb.rpc("finance_generate_occurrences", { p_until: addDays(today, 31) });
    if (error) throw new CrmError(friendlyError(error));
  }
  const [settings, rates, opening, missions, invoices, payments, categories, expenses, subscriptions, urssaf, movements] = await Promise.all([
    all(sb, "finance_settings", "effective_from"),
    all(sb, "finance_rates", "effective_from"),
    sb.from("finance_opening_balance").select("*").maybeSingle(),
    all(sb, "finance_mission_overview", "created_at"),
    all(sb, "finance_invoice_overview", "issue_date"),
    all(sb, "finance_payments", "paid_on"),
    all(sb, "finance_expense_categories", "position"),
    all(sb, "finance_expenses", "planned_date"),
    all(sb, "finance_subscriptions", "next_due_date"),
    all(sb, "finance_urssaf_periods", "period_start"),
    all(sb, "finance_cash_movements", "date"),
  ]);
  if (opening.error) throw new CrmError(friendlyError(opening.error));
  return buildFinanceData(today, { settings, rates, opening: opening.data, missions, invoices, payments, categories, expenses, subscriptions, urssaf, movements });
}

export type RawFinance = {
  settings: Row[];
  rates: Row[];
  opening: Row | null;
  missions: Row[];
  invoices: Row[];
  payments: Row[];
  categories: Row[];
  expenses: Row[];
  subscriptions: Row[];
  urssaf: Row[];
  movements: Row[];
};

/** Lignes brutes de la base (vues finance_*) → données typées en centimes. */
export function buildFinanceData(today: string, raw: RawFinance): FinanceData {
  const { settings, rates, opening, missions, invoices, payments, categories, expenses, subscriptions, urssaf, movements } = raw;
  const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string));
  return {
    today,
    settings: settings.map((s) => ({ ...(s as unknown as Settings), effective_from: day(s.effective_from) })),
    rates: rates.map((r) => ({ ...(r as unknown as Rate), effective_from: day(r.effective_from), rate_milli: rateToMilli(r.rate as string) })),
    opening: opening ? { amount: cc(opening.amount), as_of: day(opening.as_of) } : null,
    missions: missions.map(mapMission),
    invoices: invoices.map(mapInvoice),
    payments: payments.map((p) => ({ ...(p as unknown as Payment), amount: cc(p.amount) })),
    categories: categories as unknown as Category[],
    expenses: expenses.map(mapExpense),
    subscriptions: subscriptions.map(mapSub),
    urssaf: urssaf.map(mapUrssaf),
    movements: movements.map((m) => ({ ...(m as unknown as CashMovement), amount: cc(m.amount), amount_ht: cc(m.amount_ht) })),
  };
}
