// Proposition : devis et signature. Règles pures, partagées par le navigateur, le serveur et les tests.
import { DISCOVERY_OFFER } from "@/content/generators/proposition";
import type { Answers, PersonValue, QuoteLine } from "@/lib/generators/rules";

export type QuoteStatus = "to_send" | "requested" | "created" | "sent" | "signed" | "error" | "to_retry" | "cancelled";
export type Quote = { id: string; status: QuoteStatus; number: string | null; url: string | null; signed_on: string | null; error: string | null; total_ht_cents: number; requested_at: string | null; updated_at: string };
/** Devis et signature d'une version de proposition. */
export type ProposalVersion = { version_id: string; signed_at: string | null; signed_via: "make" | "manual" | null; quote: Quote };
export type ProposalExtras = {
  versions: Record<string, ProposalVersion>;
  makeReady: boolean;
  /** version signée du dossier ; `older` : une version plus récente existe, mais c'est la signée qui fait foi */
  signed: { version_id: string; version: number; older: boolean } | null;
  /** état commercial de la fiche, et raison si le passage en client attend ma confirmation */
  client: { status: "open" | "won" | "lost"; to_confirm: string | null };
};

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  to_send: "À créer", requested: "Demandé à Make", created: "Créé", sent: "Envoyé", signed: "Signé", error: "Erreur", to_retry: "À relancer", cancelled: "Annulé",
};
export const QUOTE_STATUS_TONES: Record<QuoteStatus, "neutral" | "violet" | "warning" | "success" | "danger"> = {
  to_send: "neutral", requested: "violet", created: "success", sent: "success", signed: "success", error: "danger", to_retry: "warning", cancelled: "neutral",
};
/** Le devis peut être (re)lancé vers Make : jamais créé, échec, erreur de Make, ou dix minutes sans retour. */
export const quoteRetryable = (q: Pick<Quote, "status" | "requested_at">, now = Date.now()) =>
  q.status === "to_send" || q.status === "to_retry" || q.status === "error" || (q.status === "requested" && !!q.requested_at && now - Date.parse(q.requested_at) > 10 * 60_000);

const text = (a: Answers, k: string) => { const v = a[k]?.value; return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : ""; };
export const toCents = (euros: number) => Math.round(euros * 100);

export type QuotePayload = {
  proposal: { id: string };
  client: { company_name: string; siret: string; vat_number: string; billing_address: { line1: string; postal_code: string; city: string; country: string } };
  signatory: { first_name: string; last_name: string; title: string; email: string };
  quote: {
    currency: "EUR"; offer: string; start_date: string; duration_months: number | null; payment_terms: string; special_conditions: string;
    lines: { label: string; description: string; quantity: number; unit: string; unit_price_cents: number; vat_rate: number; recurrence: "monthly" | "one_off" }[];
    total_ht_cents: number;
  };
};

/** Ce qui part à Make pour créer le devis : uniquement les réponses marquées « make », montants compris. Rien d'estimé. */
export function quotePayload(dossierId: string, a: Answers): QuotePayload {
  const lines = (Array.isArray(a.lignes_devis?.value) ? (a.lignes_devis!.value as QuoteLine[]) : []).map((l) => ({
    label: l.label.trim(), description: l.description?.trim() ?? "", quantity: l.quantity, unit: l.unit.trim(), unit_price_cents: toCents(l.unit_price), vat_rate: l.vat_rate, recurrence: l.recurrence,
  }));
  const s = (a.signataire?.value ?? {}) as Partial<PersonValue>;
  const duration = a.duree_mois?.value;
  return {
    proposal: { id: dossierId },
    client: {
      company_name: text(a, "raison_sociale"), siret: text(a, "siret"), vat_number: text(a, "tva_intracom"),
      billing_address: { line1: text(a, "adresse_facturation"), postal_code: text(a, "code_postal"), city: text(a, "ville"), country: text(a, "pays").toUpperCase() },
    },
    signatory: { first_name: s.first_name?.trim() ?? "", last_name: s.last_name?.trim() ?? "", title: s.title?.trim() ?? "", email: s.email?.trim() ?? "" },
    quote: {
      currency: "EUR", offer: text(a, "offre"), start_date: text(a, "date_demarrage"), duration_months: typeof duration === "number" ? duration : null,
      payment_terms: text(a, "conditions_paiement"), special_conditions: text(a, "conditions_particulieres"),
      lines, total_ht_cents: lines.reduce((n, l) => n + Math.round(l.quantity * l.unit_price_cents), 0),
    },
  };
}

/** La proposition contient l'offre découverte (sert à cocher « Offre découverte » chez le client quand la case existera). */
export const hasDiscoveryOffer = (a: Answers) => a.offre?.value === DISCOVERY_OFFER;

export const eurCents = (cents: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(cents / 100);

/** Email d'envoi proposé (relu et modifiable dans le composeur avant tout envoi). */
export function sendEmailDraft(company: string, firstName: string | null, quote: Pick<Quote, "url" | "number"> | null) {
  const hello = firstName?.trim() ? `Bonjour ${firstName.trim()},` : "Bonjour,";
  const devis = quote?.url ? `\n\nLe devis${quote.number ? ` ${quote.number}` : ""} correspondant est disponible ici : ${quote.url}` : "";
  return {
    subject: `Proposition · ${company}`,
    text: `${hello}\n\nComme convenu, vous trouverez en pièce jointe notre proposition.${devis}\n\nJe reste disponible pour en parler.\n\nBien à vous,`,
  };
}
