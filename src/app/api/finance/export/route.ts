import Papa from "papaparse";
import { createSupabase } from "@/lib/supabase/server";
import { todayISO } from "@/lib/format";
import { loadFinance } from "@/lib/finance/service";
import { centsToDb } from "@/lib/finance/money";
import { urssafRows } from "@/lib/finance/calc";
import { EXPENSE_STATUS, INVOICE_STATUS, URSSAF_STATE } from "@/lib/finance/labels";

// Export CSV du module Finance : revenus, paiements, charges, périodes URSSAF.
// Montants en euros avec point décimal (« 1234.50 »), sans conversion flottante.
export async function GET(req: Request) {
  const supabase = await createSupabase();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return new Response("Non authentifié", { status: 401 });
  const { data: owner } = await supabase.from("app_owner").select("user_id").eq("user_id", auth.user.id).maybeSingle();
  if (!owner) return new Response("Accès refusé", { status: 403 });

  const type = new URL(req.url).searchParams.get("type") ?? "revenus";
  let data;
  try {
    data = await loadFinance(supabase, todayISO());
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
  const m = (c: number | null | undefined) => centsToDb(c) ?? "";
  const cat = (id: string | null) => data.categories.find((c) => c.id === id)?.name ?? "";
  let rows: Record<string, unknown>[];

  if (type === "revenus") {
    rows = data.invoices.map((i) => ({
      id: i.id,
      type: i.kind,
      client: i.company_name,
      client_id: i.company_id,
      mission: i.mission_label ?? "",
      reference: i.reference ?? "",
      date_emission: i.issue_date,
      echeance: i.due_date ?? "",
      montant_ht: m(i.amount_ht),
      taux_tva: i.vat_rate ?? "",
      tva: m(i.vat_amount),
      montant_ttc: m(i.amount_ttc),
      avoirs: m(i.credited),
      encaisse: m(i.paid_net),
      reste_du: m(i.balance),
      statut: INVOICE_STATUS[i.status],
      facture_d_origine: i.credited_invoice_id ?? "",
      annulee_le: i.cancelled_at ?? "",
      motif_annulation: i.cancel_reason ?? "",
      note: i.note ?? "",
    }));
  } else if (type === "paiements") {
    rows = data.payments.map((p) => {
      const i = data.invoices.find((x) => x.id === p.invoice_id);
      return {
        id: p.id,
        facture_id: p.invoice_id,
        client: i?.company_name ?? "",
        reference_facture: i?.reference ?? "",
        type: p.kind,
        date: p.paid_on,
        montant: m(p.amount),
        annule_le: p.cancelled_at ?? "",
        note: p.note ?? "",
      };
    });
  } else if (type === "charges") {
    rows = data.expenses.map((e) => ({
      id: e.id,
      libelle: e.label,
      fournisseur: e.supplier ?? "",
      categorie: cat(e.category_id),
      montant: m(e.amount),
      montant_ht: m(e.amount_ht),
      tva: m(e.vat_amount),
      date_prevue: e.planned_date,
      date_paiement: e.paid_on ?? "",
      statut: EXPENSE_STATUS[e.status],
      abonnement: e.subscription_id ? data.subscriptions.find((s) => s.id === e.subscription_id)?.label ?? "" : "",
      note: e.note ?? "",
    }));
  } else if (type === "urssaf") {
    rows = urssafRows(data).map((r) => ({
      debut: r.start,
      fin: r.end,
      etat: URSSAF_STATE[r.state],
      ca_encaisse_ht: m(r.estimate.base),
      cotisations_estimees: r.estimate.status === "estime" ? m(r.estimate.total) : "",
      echeance: r.deadline,
      origine_echeance: r.deadlineOrigin === "saisie" ? "saisie" : "règle officielle",
      declare_le: r.record?.declared_on ?? "",
      base_declaree: m(r.record?.declared_base),
      montant_declare: m(r.record?.declared_amount),
      estimation_a_la_declaration: m(r.record?.estimate_amount_at_declaration),
      paye_le: r.record?.paid_on ?? "",
      montant_paye: m(r.record?.paid_amount),
      reference: r.record?.reference ?? "",
      note: r.record?.note ?? "",
    }));
  } else {
    return new Response("Type inconnu", { status: 400 });
  }

  // escapeFormulae : protège contre l'injection de formules dans Excel / Sheets
  const csv = Papa.unparse(rows, { escapeFormulae: true });
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="cely-finance-${type}-${todayISO()}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
