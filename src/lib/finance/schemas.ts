// Validation serveur des écritures Finance. Les montants arrivent en centimes entiers.
import { z } from "zod";
import { centsToDb } from "./money";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide").refine((s) => !Number.isNaN(Date.parse(s)), "Date invalide");
const optDate = date.nullable().optional().or(z.literal("").transform(() => null));
const optText = (max: number) =>
  z.string().trim().max(max, `${max} caractères maximum`).nullable().optional().transform((v) => (v ? v : null));
const cents = z.number({ error: "Montant invalide" }).int("Montant invalide").min(0, "Montant négatif").max(9_999_999_999, "Montant trop élevé");
const positive = cents.refine((v) => v > 0, "Le montant doit être positif");
const optCents = cents.nullable().optional();
const id = z.uuid("Identifiant invalide");
const optId = id.nullable().optional().or(z.literal("").transform(() => null));
export const keySchema = z.string().min(8).max(200);
export const FREQUENCIES = ["mensuel", "trimestriel", "annuel"] as const;

export const missionSchema = z
  .object({
    company_id: id,
    label: z.string().trim().min(1, "Le nom de la mission est obligatoire").max(200),
    status: z.enum(["a_demarrer", "actif", "en_pause", "termine"]),
    kind: z.enum(["ponctuel", "recurrent"]),
    start_date: optDate,
    end_date: optDate,
    amount: optCents,
    frequency: z.enum(FREQUENCIES).nullable().optional(),
    next_due_date: optDate,
    note: optText(2000),
  })
  .refine((m) => m.kind === "ponctuel" || !!m.frequency, { message: "Choisissez la fréquence de facturation" })
  .refine((m) => !m.start_date || !m.end_date || m.end_date >= m.start_date, { message: "La date de fin précède la date de début" })
  .transform((m) => ({ ...m, frequency: m.kind === "recurrent" ? m.frequency : null, amount: centsToDb(m.amount) }));
export type MissionInput = z.input<typeof missionSchema>;

export const invoiceSchema = z
  .object({
    company_id: id,
    mission_id: optId,
    reference: optText(100),
    issue_date: date,
    due_date: optDate,
    amount_ht: positive,
    vat_rate: z.string().regex(/^\d{1,2}([.,]\d{1,2})?$/, "Taux de TVA invalide").nullable().optional().or(z.literal("").transform(() => null)),
    vat_amount: optCents,
    note: optText(2000),
    forecast_due_date: optDate,
  })
  .refine((i) => !i.due_date || i.due_date >= i.issue_date, { message: "L'échéance précède la date d'émission" })
  .transform((i) => ({
    ...i,
    vat_rate: i.vat_rate ? i.vat_rate.replace(",", ".") : null,
    amount_ht: centsToDb(i.amount_ht),
    vat_amount: centsToDb(i.vat_amount ?? null),
    amount_ttc: centsToDb(i.amount_ht + (i.vat_amount ?? 0)),
  }));
export type InvoiceInput = z.input<typeof invoiceSchema>;

export const creditNoteSchema = z
  .object({ issue_date: date, amount_ht: positive, vat_amount: optCents, reference: optText(100), note: optText(2000) })
  .transform((a) => ({
    ...a,
    amount_ht: centsToDb(a.amount_ht),
    vat_amount: centsToDb(a.vat_amount ?? null),
    amount_ttc: centsToDb(a.amount_ht + (a.vat_amount ?? 0)),
  }));
export type CreditNoteInput = z.input<typeof creditNoteSchema>;

export const paymentSchema = z.object({
  invoice_id: id,
  paid_on: date,
  amount: positive,
  kind: z.enum(["paiement", "remboursement"]).default("paiement"),
  note: optText(1000),
});
export type PaymentInput = z.input<typeof paymentSchema>;

export const expenseSchema = z
  .object({
    label: z.string().trim().min(1, "Le libellé est obligatoire").max(200),
    supplier: optText(200),
    category_id: optId,
    amount: optCents,
    amount_ht: optCents,
    vat_amount: optCents,
    planned_date: date,
    paid_on: optDate,
    status: z.enum(["a_payer", "paye", "annule"]),
    note: optText(2000),
  })
  .refine((e) => e.status !== "paye" || e.amount != null, { message: "Indiquez le montant payé" })
  .transform((e) => ({ ...e, amount: centsToDb(e.amount ?? null), amount_ht: centsToDb(e.amount_ht ?? null), vat_amount: centsToDb(e.vat_amount ?? null) }));
export type ExpenseInput = z.input<typeof expenseSchema>;

export const subscriptionSchema = z
  .object({
    label: z.string().trim().min(1, "Le libellé est obligatoire").max(200),
    supplier: optText(200),
    category_id: optId,
    amount: optCents,
    amount_ht: optCents,
    frequency: z.enum(FREQUENCIES),
    start_date: optDate,
    next_due_date: date,
    renewal_date: optDate,
    end_date: optDate,
    status: z.enum(["actif", "resilie"]),
    note: optText(2000),
  })
  .transform((s) => ({ ...s, amount: centsToDb(s.amount ?? null), amount_ht: centsToDb(s.amount_ht ?? null) }));
export type SubscriptionInput = z.input<typeof subscriptionSchema>;

export const urssafDeclareSchema = z.object({
  start: date,
  end: date,
  declared_on: date,
  base: optCents,
  amount: cents,
  estimate: z.object({ base: optCents, amount: optCents, rate: z.string().nullable().optional() }).optional(),
  reference: optText(100),
  note: optText(2000),
  paid_on: optDate,
  paid_amount: optCents,
});
export type UrssafDeclareInput = z.input<typeof urssafDeclareSchema>;

export const urssafPaySchema = z.object({ id, paid_on: date, amount: cents, reference: optText(100) });

export const settingsSchema = z.object({
  effective_from: date,
  regime: z.enum(["micro_bnc_ssi", "micro_bnc_cipav", "micro_bic_services", "micro_bic_vente", "manual"]),
  periodicity: z.enum(["monthly", "quarterly"]),
  acre: z.boolean(),
  versement_liberatoire: z.boolean(),
  vat_enabled: z.boolean(),
  note: optText(2000),
});
export type SettingsInput = z.input<typeof settingsSchema>;

export const rateSchema = z.object({
  regime: z.enum(["micro_bnc_ssi", "micro_bnc_cipav", "micro_bic_services", "micro_bic_vente"]),
  kind: z.enum(["social", "cfp"]),
  rate: z.string().trim().regex(/^\d{1,2}([.,]\d{1,3})?$/, "Taux invalide (ex. 25,6)").transform((s) => s.replace(",", ".")),
  effective_from: date,
  source_url: z.url("Adresse de la source invalide").max(500),
  note: optText(1000),
});
export type RateInput = z.input<typeof rateSchema>;

export const openingSchema = z.object({ amount: z.number().int().min(-9_999_999_999).max(9_999_999_999), as_of: date });

export const categorySchema = z.object({ name: z.string().trim().min(1, "Le nom est obligatoire").max(80), ebitda_included: z.boolean() });
