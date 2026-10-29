// Libellés français et formats d'affichage.
import type { Channel, InteractionKind, ParticipantStatus, ProspectStatus } from "@/lib/crm/types";

export const TZ = "Europe/Paris";

export const PROSPECT_STATUS_LABELS: Record<ProspectStatus, string> = {
  nouveau: "Nouveau",
  contacte: "Contacté",
  en_discussion: "En discussion",
  qualifie: "Qualifié",
  pas_interesse: "Pas intéressé",
};

export const PARTICIPANT_STATUS_LABELS: Record<ParticipantStatus, string> = {
  a_contacter: "À contacter",
  en_cours: "En cours",
  a_repondu: "A répondu",
  termine: "Terminé",
  arrete: "Arrêté",
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  linkedin: "LinkedIn",
  email: "Email",
  phone: "Téléphone",
  other: "Autre",
};

export const KIND_LABELS: Record<InteractionKind, string> = {
  note: "Note interne",
  message_out: "Message envoyé",
  message_in: "Message reçu",
  call: "Appel",
  meeting: "Rendez-vous",
  stage_change: "Pipeline",
  deal_status: "Statut commercial",
  prospecting: "Prospection",
  task_done: "Tâche terminée",
  merge: "Fusion",
  system: "Système",
};

export const DEAL_STATUS_LABELS = { open: "Ouvert", won: "Gagné", lost: "Perdu" } as const;

/** Date du jour à Paris, au format AAAA-MM-JJ. */
export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = iso.length === 10 ? new Date(iso + "T12:00:00Z") : new Date(iso);
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" }).format(d);
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function relativeDay(iso?: string | null): string {
  if (!iso) return "—";
  const day = iso.slice(0, 10);
  const today = todayISO();
  const diff = Math.round((Date.parse(day) - Date.parse(today)) / 86400000);
  if (diff === 0) return "Aujourd'hui";
  if (diff === -1) return "Hier";
  if (diff === 1) return "Demain";
  if (diff < 0 && diff > -7) return `Il y a ${-diff} j`;
  if (diff > 0 && diff < 7) return `Dans ${diff} j`;
  return formatDate(day);
}

export function formatAmount(v?: number | null): string {
  if (v == null) return "";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(v);
}

export function personName(p?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null): string {
  if (!p) return "";
  const n = `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
  return n || p.email || "Sans nom";
}

/** Valeur pour un <input type="datetime-local"> en heure de Paris. */
export function nowLocalInput(): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  return parts.replace(" ", "T");
}

/** Convertit une saisie datetime-local (heure de Paris) en ISO avec décalage. */
export function localInputToISO(v: string): string {
  const [date, time = "12:00"] = v.split("T");
  const guess = new Date(`${date}T${time}:00Z`);
  const offsetMin = tzOffsetMinutes(guess);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${date}T${time}:00${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

function tzOffsetMinutes(d: Date): number {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).format(d);
  const m = s.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}
