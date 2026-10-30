"use server";

// Server actions du module Finance : validation zod, puis fonctions SQL (idempotentes,
// sous RLS). Aucun calcul monétaire ici : les montants arrivent en centimes et sont
// convertis en texte numeric pour la base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { run } from "@/lib/action";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { todayISO } from "@/lib/format";
import { centsToDb } from "@/lib/finance/money";
import {
  categorySchema,
  creditNoteSchema,
  expenseSchema,
  invoiceSchema,
  keySchema,
  missionSchema,
  openingSchema,
  paymentSchema,
  rateSchema,
  settingsSchema,
  subscriptionSchema,
  urssafDeclareSchema,
  urssafPaySchema,
  type CreditNoteInput,
  type ExpenseInput,
  type InvoiceInput,
  type MissionInput,
  type PaymentInput,
  type RateInput,
  type SettingsInput,
  type SubscriptionInput,
  type UrssafDeclareInput,
} from "@/lib/finance/schemas";

function v<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}
const optKey = (k?: string | null) => (k ? v(keySchema, k) : null);
const idv = (id: string) => v(z.uuid("Identifiant invalide"), id);

async function rpc<T = { id: string }>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}
async function q(res: PromiseLike<{ error: { message: string; code?: string } | null }>) {
  const { error } = await res;
  if (error) throw new CrmError(friendlyError(error));
}

// Missions ------------------------------------------------------------------

export async function saveMissionAction(id: string | null, input: MissionInput, key?: string) {
  return run((sb) => rpc(sb, "finance_save_mission", { p_id: id ? idv(id) : null, p_data: v(missionSchema, input), p_idempotency_key: optKey(key) }));
}

// Revenus -------------------------------------------------------------------

export async function recordInvoiceAction(input: InvoiceInput, key: string, paidNow?: { paid_on: string } | null) {
  return run(async (sb) => {
    const k = v(keySchema, key);
    const res = await rpc(sb, "finance_record_invoice", { p_data: v(invoiceSchema, input), p_idempotency_key: k });
    if (paidNow) {
      const p = v(paymentSchema, { invoice_id: res.id, paid_on: paidNow.paid_on, amount: input.amount_ht + (input.vat_amount ?? 0) });
      await rpc(sb, "finance_record_payment", {
        p_invoice: p.invoice_id, p_paid_on: p.paid_on, p_amount: centsToDb(p.amount), p_kind: "paiement", p_note: null, p_idempotency_key: `${k}-pay`,
      });
    }
    return res;
  });
}

export async function updateInvoiceAction(id: string, input: InvoiceInput) {
  return run((sb) => rpc(sb, "finance_update_invoice", { p_id: idv(id), p_data: v(invoiceSchema, input) }));
}

export async function cancelInvoiceAction(id: string, reason: string) {
  return run((sb) => rpc(sb, "finance_cancel_invoice", { p_id: idv(id), p_reason: v(z.string().trim().max(500), reason) }));
}

export async function recordCreditNoteAction(invoiceId: string, input: CreditNoteInput, key: string) {
  return run((sb) =>
    rpc(sb, "finance_record_credit_note", { p_invoice: idv(invoiceId), p_data: v(creditNoteSchema, input), p_idempotency_key: v(keySchema, key) }),
  );
}

export async function recordPaymentAction(input: PaymentInput, key: string) {
  return run((sb) => {
    const p = v(paymentSchema, input);
    return rpc(sb, "finance_record_payment", {
      p_invoice: p.invoice_id, p_paid_on: p.paid_on, p_amount: centsToDb(p.amount), p_kind: p.kind, p_note: p.note, p_idempotency_key: v(keySchema, key),
    });
  });
}

export async function cancelPaymentAction(id: string) {
  return run((sb) => rpc(sb, "finance_cancel_payment", { p_id: idv(id) }));
}

// Charges -------------------------------------------------------------------

export async function saveExpenseAction(id: string | null, input: ExpenseInput, key?: string) {
  return run((sb) => rpc(sb, "finance_save_expense", { p_id: id ? idv(id) : null, p_data: v(expenseSchema, input), p_idempotency_key: optKey(key) }));
}

export async function payExpenseAction(id: string, paidOn: string, amount: number | null, key: string) {
  return run((sb) =>
    rpc(sb, "finance_pay_expense", {
      p_id: idv(id),
      p_paid_on: v(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide"), paidOn),
      p_amount: amount == null ? null : centsToDb(v(z.number().int().min(0), amount)),
      p_idempotency_key: v(keySchema, key),
    }),
  );
}

export async function setExpenseStatusAction(id: string, status: "a_payer" | "annule") {
  return run((sb) => rpc(sb, "finance_set_expense_status", { p_id: idv(id), p_status: v(z.enum(["a_payer", "annule"]), status) }));
}

export async function deleteExpenseAction(id: string) {
  // seules les charges ponctuelles non payées peuvent être supprimées (erreur de saisie)
  return run(async (sb) => {
    const { data, error } = await sb.from("finance_expenses").delete().eq("id", idv(id)).neq("status", "paye").is("subscription_id", null).select("id");
    if (error) throw new CrmError(friendlyError(error));
    if (!data?.length) throw new CrmError("Suppression impossible : une charge payée ou issue d'un abonnement s'annule au lieu d'être supprimée.");
  });
}

export async function saveSubscriptionAction(id: string | null, input: SubscriptionInput, key?: string) {
  return run((sb) =>
    rpc(sb, "finance_save_subscription", { p_id: id ? idv(id) : null, p_data: v(subscriptionSchema, input), p_idempotency_key: optKey(key) }),
  );
}

// URSSAF --------------------------------------------------------------------

export async function urssafDeclareAction(input: UrssafDeclareInput, key: string) {
  return run(async (sb) => {
    const d = v(urssafDeclareSchema, input);
    const k = v(keySchema, key);
    const res = await rpc(sb, "finance_urssaf_declare", {
      p_start: d.start,
      p_end: d.end,
      p_declared_on: d.declared_on,
      p_base: centsToDb(d.base ?? null),
      p_amount: centsToDb(d.amount),
      p_estimate: d.estimate
        ? { base: centsToDb(d.estimate.base ?? null), amount: centsToDb(d.estimate.amount ?? null), rate: d.estimate.rate ?? null }
        : {},
      p_deadline: null,
      p_deadline_origin: null,
      p_reference: d.reference,
      p_note: d.note,
      p_idempotency_key: k,
    });
    if (d.paid_on) {
      await rpc(sb, "finance_urssaf_pay", {
        p_id: res.id, p_paid_on: d.paid_on, p_amount: centsToDb(d.paid_amount ?? d.amount), p_reference: d.reference, p_idempotency_key: `${k}-pay`,
      });
    }
    return res;
  });
}

export async function urssafPayAction(input: z.input<typeof urssafPaySchema>, key: string) {
  return run((sb) => {
    const p = v(urssafPaySchema, input);
    return rpc(sb, "finance_urssaf_pay", {
      p_id: p.id, p_paid_on: p.paid_on, p_amount: centsToDb(p.amount), p_reference: p.reference, p_idempotency_key: v(keySchema, key),
    });
  });
}

export async function urssafSetDeadlineAction(start: string, end: string, deadline: string | null) {
  const d = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date invalide");
  return run((sb) => rpc(sb, "finance_urssaf_set_deadline", { p_start: v(d, start), p_end: v(d, end), p_deadline: deadline ? v(d, deadline) : null }));
}

export async function urssafResetAction(id: string, what: "payment" | "declaration") {
  return run((sb) => rpc(sb, "finance_urssaf_reset", { p_id: idv(id), p_what: v(z.enum(["payment", "declaration"]), what) }));
}

// Réglages ------------------------------------------------------------------

export async function saveSettingsAction(input: SettingsInput) {
  return run((sb) => rpc(sb, "finance_save_settings", { p_data: v(settingsSchema, input) }));
}

export async function addRateAction(input: RateInput) {
  return run(async (sb) => {
    const r = v(rateSchema, input);
    await q(sb.from("finance_rates").insert({ ...r, origin: "user", verified_on: todayISO() }));
  });
}

export async function deleteRateAction(id: string) {
  // les taux officiels fournis avec l'application restent (historique) ; seuls ceux saisis se suppriment
  return run((sb) => q(sb.from("finance_rates").delete().eq("id", idv(id)).eq("origin", "user")));
}

export async function saveOpeningBalanceAction(input: { amount: number; as_of: string } | null) {
  return run(async (sb) => {
    if (!input) return q(sb.from("finance_opening_balance").delete().eq("id", true));
    const o = v(openingSchema, input);
    await q(sb.from("finance_opening_balance").upsert({ id: true, amount: centsToDb(o.amount), as_of: o.as_of, updated_at: new Date().toISOString() }));
  });
}

export async function saveCategoryAction(id: string | null, input: { name: string; ebitda_included: boolean }) {
  return run(async (sb) => {
    const c = v(categorySchema, input);
    if (id) await q(sb.from("finance_expense_categories").update(c).eq("id", idv(id)));
    else await q(sb.from("finance_expense_categories").insert({ ...c, position: 100 }));
  });
}
