// Ventes : règles pures, partagées par la page Ventes, la fiche et Projets (aucune dépendance au navigateur).
// La source de vérité reste companies.deal_status ; une ligne vient de la vue sales_overview.
import { eur, toCents } from "@/lib/finance/money";

export type SaleStage = "devis_contrat" | "onboarding" | "en_mission" | "termine";
export type Billing = "a_renseigner" | "prevu" | "facture" | "encaisse";
/** État de préparation de l'onboarding : une seule source, project_onboarding_status (Ventes et Projets). */
export type PrepStatus = "preparing" | "to_complete" | "ready";

/** Une ligne par cycle de vente (gagné ou terminé), par fiche perdue, ou par ancien dossier gagné sans vente. */
export type SaleRow = {
  row_id: string;
  company_id: string;
  company_deal_status: "open" | "won" | "lost";
  cycle: number | null;
  project_removed_at: string | null;
  prep_status: PrepStatus | null;
  prep_missing: number | null;
  name: string;
  deal_status: "won" | "lost";
  deal_closed_at: string | null;
  closed_on: string | null;
  lost_reason: string | null;
  deal_amount: number | string | null;
  archived_at: string | null;
  pipeline_name: string | null;
  stage_name: string | null;
  primary_person_name: string | null;
  sale_id: string | null;
  sale_state: "won" | "reopened" | "lost" | "completed" | null;
  signed_on: string | null;
  revenue_mode: "mensuel" | "ponctuel" | "plus_tard" | null;
  documents_ready: boolean | null;
  prep_error: string | null;
  mission_id: string | null;
  mission_kind: "ponctuel" | "recurrent" | null;
  mission_amount: number | string | null;
  mission_start: string | null;
  mission_end: string | null;
  mission_status: string | null;
  invoiced_ttc: number | string | null;
  received: number | string | null;
  remaining: number | string | null;
  project_id: string | null;
  project_name: string | null;
  project_status: string | null;
  candidate_mission_id: string | null;
  candidate_project_id: string | null;
  billing: Billing;
  stage: SaleStage | null;
};

export const STAGES: { key: Exclude<SaleStage, "termine">; label: string; hint: string; action: string }[] = [
  { key: "devis_contrat", label: "Devis / Contrat", hint: "Documents ou formalités à finaliser", action: "Finaliser le dossier" },
  { key: "onboarding", label: "Onboarding", hint: "Démarrage à préparer", action: "Ouvrir l'onboarding" },
  { key: "en_mission", label: "En mission", hint: "Prestation démarrée", action: "Ouvrir le projet" },
];
export const STAGE_LABELS: Record<SaleStage, string> = { devis_contrat: "Devis / Contrat", onboarding: "Onboarding", en_mission: "En mission", termine: "Terminée" };

export const BILLING_LABELS: Record<Billing, string> = { a_renseigner: "Facturation à renseigner", prevu: "Prévu", facture: "Facturé", encaisse: "Encaissé" };
export const BILLING_TONES: Record<Billing, "warning" | "neutral" | "violet" | "success"> = { a_renseigner: "warning", prevu: "neutral", facture: "violet", encaisse: "success" };

/** Montant sur une ligne : « 1 000 € / mois », « 2 500 € ponctuels », ou null s'il n'est pas connu. */
export function amountLine(r: Pick<SaleRow, "mission_amount" | "mission_kind" | "deal_amount">): string | null {
  const m = toCents(r.mission_amount);
  if (m != null && r.mission_kind === "recurrent") return `${eur(m, { round: m % 100 === 0 })} / mois`;
  if (m != null) return `${eur(m, { round: m % 100 === 0 })} ponctuels`;
  const d = toCents(r.deal_amount);
  return d != null ? eur(d, { round: d % 100 === 0 }) : null;
}

// ---------------------------------------------------------------------------
// Période : la même pour les trois chiffres et les listes Gagnées / Perdues
// ---------------------------------------------------------------------------

export type Period = "mois" | "trimestre" | "annee" | "12mois" | "tout";
export const PERIODS: { key: Period; label: string }[] = [
  { key: "mois", label: "Ce mois-ci" },
  { key: "trimestre", label: "3 derniers mois" },
  { key: "annee", label: "Cette année" },
  { key: "12mois", label: "12 derniers mois" },
  { key: "tout", label: "Depuis le début" },
];
export const DEFAULT_PERIOD: Period = "annee";
export const isPeriod = (v: unknown): v is Period => PERIODS.some((p) => p.key === v);

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Premier jour inclus de la période (null : pas de limite). `today` au format AAAA-MM-JJ (heure de Paris). */
export function periodStart(p: Period, today: string): string | null {
  const [y, m] = today.split("-").map(Number);
  if (p === "mois") return `${today.slice(0, 7)}-01`;
  if (p === "annee") return `${y}-01-01`;
  if (p === "trimestre") return iso(new Date(Date.UTC(y, m - 3, 1)));
  if (p === "12mois") return iso(new Date(Date.UTC(y - 1, m - 1, Number(today.slice(8)) + 1)));
  return null;
}

export const inPeriod = (r: Pick<SaleRow, "closed_on">, p: Period, today: string) => {
  const start = periodStart(p, today);
  return !start || (!!r.closed_on && r.closed_on >= start && r.closed_on <= today);
};

/** Gagnées, perdues et taux de réussite = gagnées ÷ (gagnées + perdues), sur les clôtures de la période. */
export function metrics(rows: SaleRow[], p: Period, today: string) {
  const shown = rows.filter((r) => inPeriod(r, p, today));
  const won = shown.filter((r) => r.deal_status === "won").length;
  const lost = shown.filter((r) => r.deal_status === "lost").length;
  return { won, lost, rate: won + lost ? Math.round((won / (won + lost)) * 100) : null };
}

/** Tableau après-vente : ventes gagnées en cours de suivi, indépendant de la période. */
export function board(rows: SaleRow[]) {
  const active = rows.filter((r) => r.deal_status === "won" && r.stage && r.stage !== "termine");
  return STAGES.map((s) => ({ ...s, rows: active.filter((r) => r.stage === s.key).sort(byClosedDesc) }));
}

export const byClosedDesc = (a: SaleRow, b: SaleRow) => (b.closed_on ?? "").localeCompare(a.closed_on ?? "");

/** Éléments obligatoires encore manquants pour l'onboarding. */
export const missingCount = (r: Pick<SaleRow, "prep_status" | "prep_missing">) => (r.prep_status === "to_complete" ? r.prep_missing ?? 0 : 0);

/** Ancien dossier gagné sans suivi : à compléter (aucun projet ni revenu créé automatiquement). */
export const needsCompletion = (r: Pick<SaleRow, "deal_status" | "sale_id">) => r.deal_status === "won" && !r.sale_id;
