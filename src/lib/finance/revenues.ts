// Revenus unifiés (ponctuels et mensuels) au-dessus du modèle existant : un revenu est une
// « mission » (finance_missions), le réel reste porté par les factures et les paiements.
//
// Échéances : calculées depuis la première échéance (jour habituel ; un jour absent du mois devient
// le dernier jour de ce mois, puis le jour habituel revient le mois suivant). Une échéance est une
// PRÉVISION tant qu'aucune facture ne la couvre ; dès qu'une facture (et ses règlements) la couvre,
// seule la facture compte : jamais deux fois le même revenu.
import { addFrequency, FREQ_MONTHS, monthStart } from "./dates";
import type { Invoice, Mission } from "./types";

export type RevenueKind = "ponctuel" | "mensuel";
export const revenueKind = (m: Mission): RevenueKind => (m.kind === "recurrent" ? "mensuel" : "ponctuel");

/** Date de référence des échéances : première échéance (sinon prochaine échéance pour les anciennes données). */
export const anchorDate = (m: Mission) => m.start_date ?? m.next_due_date;

/** Échéances d'une récurrence entre deux dates (incluses), fin de récurrence respectée. */
export function scheduleDates(start: string, frequency: Mission["frequency"], end: string | null, from: string, to: string, max = 400): string[] {
  const out: string[] = [];
  const f = frequency ?? "mensuel";
  for (let k = 0; k < max; k++) {
    const d = addFrequency(start, f, k);
    if (d > to || (end && d > end)) break;
    if (d >= from) out.push(d);
  }
  return out;
}

/** Aperçu des prochaines échéances (formulaire). */
export function previewDates(first: string, end: string | null, count = 6): string[] {
  return scheduleDates(first, "mensuel", end, first, "9999-12-31", count);
}

const live = (i: Invoice) => i.kind === "facture" && !i.cancelled_at;

/**
 * Facture qui couvre une échéance : rattachée explicitement (forecast_due_date), ou, pour les
 * données antérieures sans rattachement, facture de la même récurrence émise le même mois.
 */
export function coveringInvoice(m: Mission, due: string, invoices: Invoice[]): Invoice | null {
  const mine = invoices.filter((i) => i.mission_id === m.id && live(i));
  const exact = mine.find((i) => i.forecast_due_date === due);
  if (exact) return exact;
  if (m.kind !== "recurrent") return null;
  const months = FREQ_MONTHS[m.frequency ?? "mensuel"];
  return months === 1 ? mine.find((i) => !i.forecast_due_date && monthStart(i.issue_date) === monthStart(due)) ?? null : null;
}

export type DueState = "prevue" | "a_verifier" | "facturee" | "partielle" | "en_retard" | "encaissee";
export type Due = { date: string; amount: number | null; state: DueState; invoice: Invoice | null };

function dueState(date: string, inv: Invoice | null, today: string): DueState {
  if (!inv) return date < today ? "a_verifier" : "prevue";
  if (inv.status === "payee") return "encaissee";
  if (inv.status === "en_retard") return "en_retard";
  if (inv.status === "partielle") return "partielle";
  return "facturee";
}

/** Échéances d'un revenu mensuel sur une plage (passées comprises, pour l'historique). */
export function monthlyDues(m: Mission, invoices: Invoice[], from: string, to: string, today: string): Due[] {
  const a = anchorDate(m);
  if (!a || m.kind !== "recurrent") return [];
  return scheduleDates(a, m.frequency, m.end_date, from, to).map((date) => {
    const inv = coveringInvoice(m, date, invoices);
    return { date, amount: inv ? inv.amount_ht : m.amount, state: dueState(date, inv, today), invoice: inv };
  });
}

/** Date d'encaissement prévue d'un revenu ponctuel. */
export const oneOffDate = (m: Mission) => m.next_due_date ?? m.start_date;

/**
 * Montant encore à facturer d'un revenu ponctuel (null = inconnu). Calculé sur le facturé BRUT : un avoir
 * réduit ce que le client doit, pas l'engagement (C05) ; réduire le revenu est une décision explicite.
 */
export function oneOffRemaining(m: Mission): number | null {
  if (m.amount == null) return null;
  return Math.max(m.amount - (m.billed_ht ?? m.invoiced_ht), 0);
}

/** Le revenu peut-il encore produire des prévisions ? */
export const forecastable = (m: Mission) => m.status !== "termine" && m.status !== "en_pause";

/**
 * Prévisions (entrées non encore facturées) d'un revenu entre deux dates :
 * - mensuel : échéances non couvertes par une facture ;
 * - ponctuel : le montant restant à facturer, à la date prévue.
 * Les échéances passées non rattachées ne sont pas projetées (elles sont « à vérifier » dans le détail).
 */
export function forecastDues(m: Mission, invoices: Invoice[], from: string, to: string): { date: string; amount: number | null }[] {
  if (!forecastable(m)) return [];
  if (m.kind === "recurrent") {
    const a = anchorDate(m);
    if (!a) return [];
    return scheduleDates(a, m.frequency, m.end_date, from, to)
      .filter((d) => !coveringInvoice(m, d, invoices))
      .map((date) => ({ date, amount: m.amount }));
  }
  const d = oneOffDate(m);
  if (!d || d < from || d > to) return [];
  const rest = oneOffRemaining(m);
  return rest === 0 ? [] : [{ date: d, amount: rest }];
}

/** Prochaine échéance non couverte (pour rattacher une facture saisie à la main). */
export function nextOpenDue(m: Mission, invoices: Invoice[], today: string): string | null {
  if (m.kind !== "recurrent") {
    const d = oneOffDate(m);
    return d && !invoices.some((i) => i.mission_id === m.id && live(i) && i.forecast_due_date === d) ? d : null;
  }
  const a = anchorDate(m);
  if (!a) return null;
  // la plus ancienne échéance non couverte, depuis 12 mois au plus
  const from = addFrequency(today, "annuel", -1);
  return scheduleDates(a, m.frequency, m.end_date, from, addFrequency(today, "annuel", 2)).find((d) => !coveringInvoice(m, d, invoices)) ?? null;
}

/**
 * État d'encaissement d'un revenu : MÊME règle que la base (finance_revenue_state), lue aussi par Ventes.
 * - ponctuel : Prévu · Date passée (rien facturé) · À encaisser · En retard · Partiellement encaissé ·
 *   Encaissé (seulement quand tout le montant prévu est facturé ET réglé) ;
 * - mensuel : Prévu (aucune échéance due) · À jour · Partiellement réglé · En retard (facture en retard ou
 *   échéance passée non facturée) · Terminé (date de fin passée).
 */
export type RevenueStatus = "prevu" | "a_verifier" | "a_encaisser" | "en_retard" | "partiel" | "encaisse" | "a_jour" | "termine";
export function revenueStatus(m: Mission, invoices: Invoice[], today: string): RevenueStatus {
  const mine = invoices.filter((i) => i.mission_id === m.id && live(i));
  if (mine.some((i) => i.status === "en_retard")) return "en_retard";
  const open = mine.some((i) => i.status === "partielle" || i.status === "a_encaisser");
  if (m.kind === "recurrent") {
    if (m.status === "termine" || (m.end_date && m.end_date < today)) return "termine";
    const a = anchorDate(m);
    const due = a ? scheduleDates(a, m.frequency, m.end_date, a, today).filter((d) => d < today) : [];
    if (due.some((d) => !coveringInvoice(m, d, invoices))) return "en_retard";
    if (open) return "partiel";
    return due.length ? "a_jour" : "prevu";
  }
  const billed = m.billed_ht ?? m.invoiced_ht;
  if (billed > 0 && (m.amount == null || billed >= m.amount) && m.remaining <= 0) return "encaisse";
  if (m.received > 0) return "partiel";
  if (open) return "a_encaisser";
  const d = oneOffDate(m);
  return d && d < today ? "a_verifier" : "prevu";
}

export const REVENUE_STATUS: Record<RevenueStatus, string> = {
  prevu: "Prévu",
  a_verifier: "Date passée",
  a_encaisser: "À encaisser",
  en_retard: "En retard",
  partiel: "Partiellement encaissé",
  encaisse: "Encaissé",
  a_jour: "À jour",
  termine: "Terminé",
};
/** Libellé selon le type : un mensuel est « Partiellement réglé ». */
export const revenueStatusLabel = (s: RevenueStatus, kind: "ponctuel" | "recurrent" | "mensuel" | null | undefined) =>
  s === "partiel" && (kind === "recurrent" || kind === "mensuel") ? "Partiellement réglé" : REVENUE_STATUS[s];

export const DUE_STATE: Record<DueState, string> = {
  prevue: "Prévue",
  a_verifier: "Non encaissée",
  facturee: "Facturée",
  partielle: "Partielle",
  en_retard: "En retard",
  encaissee: "Encaissée",
};
