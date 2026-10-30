// Types du module Finance. Tous les montants sont en centimes entiers (null = inconnu).
import type { Frequency, Periodicity } from "./dates";

export type Regime = "micro_bnc_ssi" | "micro_bnc_cipav" | "micro_bic_services" | "micro_bic_vente" | "manual";

export type Settings = {
  id: string;
  effective_from: string;
  regime: Regime;
  periodicity: Periodicity;
  acre: boolean;
  versement_liberatoire: boolean;
  vat_enabled: boolean;
  note: string | null;
};

export type Rate = {
  id: string;
  regime: Exclude<Regime, "manual">;
  kind: "social" | "cfp";
  rate_milli: number; // 25600 = 25,6 %
  effective_from: string;
  origin: "official" | "user";
  source_url: string | null;
  verified_on: string | null;
  note: string | null;
};

export type MissionStatus = "a_demarrer" | "actif" | "en_pause" | "termine";
export type Mission = {
  id: string;
  company_id: string;
  company_name: string;
  label: string;
  status: MissionStatus;
  kind: "ponctuel" | "recurrent";
  start_date: string | null;
  end_date: string | null;
  amount: number | null; // HT
  frequency: Frequency | null;
  next_due_date: string | null;
  note: string | null;
  invoiced_ht: number;
  invoiced_ttc: number;
  received: number;
  remaining: number;
};

export type InvoiceStatus = "a_encaisser" | "partielle" | "payee" | "en_retard" | "annulee" | "avoir";
export type Invoice = {
  id: string;
  kind: "facture" | "avoir";
  company_id: string;
  company_name: string;
  mission_id: string | null;
  mission_label: string | null;
  credited_invoice_id: string | null;
  reference: string | null;
  issue_date: string;
  due_date: string | null;
  amount_ht: number;
  vat_rate: string | null;
  vat_amount: number | null;
  amount_ttc: number;
  forecast_due_date: string | null;
  note: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  paid_net: number;
  refunded: number;
  credited: number;
  balance: number;
  last_paid_on: string | null;
  status: InvoiceStatus;
  created_at: string;
};

export type Payment = {
  id: string;
  invoice_id: string;
  kind: "paiement" | "remboursement";
  paid_on: string;
  amount: number;
  note: string | null;
  cancelled_at: string | null;
};

export type Category = { id: string; name: string; position: number; ebitda_included: boolean };

export type ExpenseStatus = "a_payer" | "paye" | "annule";
export type Expense = {
  id: string;
  label: string;
  supplier: string | null;
  category_id: string | null;
  amount: number | null; // TTC décaissé
  amount_ht: number | null;
  vat_amount: number | null;
  planned_date: string;
  paid_on: string | null;
  status: ExpenseStatus;
  subscription_id: string | null;
  note: string | null;
};

export type Subscription = {
  id: string;
  label: string;
  supplier: string | null;
  category_id: string | null;
  amount: number | null;
  amount_ht: number | null;
  frequency: Frequency;
  start_date: string;
  next_due_date: string;
  renewal_date: string | null;
  end_date: string | null;
  status: "actif" | "resilie";
  note: string | null;
};

export type UrssafPeriod = {
  id: string;
  period_start: string;
  period_end: string;
  deadline: string | null;
  deadline_origin: "regle_officielle" | "saisie" | null;
  declared_on: string | null;
  declared_base: number | null;
  declared_amount: number | null;
  estimate_base_at_declaration: number | null;
  estimate_amount_at_declaration: number | null;
  estimate_rate_at_declaration: number | null; // millièmes de %
  paid_on: string | null;
  paid_amount: number | null;
  reference: string | null;
  note: string | null;
};

export type CashMovement = {
  id: string;
  date: string;
  direction: "in" | "out";
  source: "paiement_client" | "remboursement_client" | "charge" | "urssaf";
  amount: number;
  amount_ht: number;
  company_id: string | null;
  category_id: string | null;
  invoice_id: string | null;
  expense_id: string | null;
  urssaf_period_id: string | null;
  label: string;
};

export type OpeningBalance = { amount: number; as_of: string } | null;

export type FinanceData = {
  today: string;
  settings: Settings[];
  rates: Rate[];
  opening: OpeningBalance;
  missions: Mission[];
  invoices: Invoice[];
  payments: Payment[];
  categories: Category[];
  expenses: Expense[];
  subscriptions: Subscription[];
  urssaf: UrssafPeriod[];
  movements: CashMovement[];
};
