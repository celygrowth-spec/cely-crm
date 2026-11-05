// Rappels : variables, rendu des modèles, libellés de délais. Pur (serveur et navigateur).
import { formatLongDate, formatTimeShort, timeZoneLabel } from "./time";

export type OffsetUnit = "days" | "hours" | "minutes";

export type ReminderRule = {
  id?: string;
  enabled: boolean;
  offset_value: number;
  offset_unit: OffsetUnit;
  subject: string;
  body: string;
};

export type Reminder = {
  id: string;
  booking_id: string;
  reminder_key: string;
  rule_id: string | null;
  origin: "rule" | "custom";
  customized: boolean;
  booking_version: number;
  offset_value: number;
  offset_unit: OffsetUnit;
  offset_minutes: number;
  send_at: string;
  subject: string;
  body: string;
  status: "scheduled" | "sent" | "failed" | "cancelled" | "superseded";
  status_reason: string | null;
  revision: number;
  dedup_key: string;
  sent_at: string | null;
};

export const UNIT_LABELS: Record<OffsetUnit, [string, string]> = {
  days: ["jour", "jours"],
  hours: ["heure", "heures"],
  minutes: ["minute", "minutes"],
};
export const UNIT_MINUTES: Record<OffsetUnit, number> = { days: 1440, hours: 60, minutes: 1 };

export function offsetLabel(value: number, unit: OffsetUnit): string {
  return `${value} ${UNIT_LABELS[unit][value > 1 ? 1 : 0]} avant`;
}

export const VARIABLES = [
  { key: "prenom", label: "Prénom" },
  { key: "nom", label: "Nom" },
  { key: "entreprise", label: "Entreprise" },
  { key: "type", label: "Type de rendez-vous" },
  { key: "date", label: "Date" },
  { key: "heure", label: "Heure" },
  { key: "fuseau", label: "Fuseau horaire" },
  { key: "duree", label: "Durée" },
  { key: "lien_reunion", label: "Lien de réunion" },
  { key: "lien_annulation", label: "Lien d'annulation" },
  { key: "lien_report", label: "Lien de report" },
] as const;
export type VariableKey = (typeof VARIABLES)[number]["key"];
export type Variables = Record<VariableKey, string>;

const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Remplace {{variable}} ; une variable inconnue est laissée telle quelle et signalée. */
export function renderTemplate(tpl: string, vars: Variables): { text: string; unknown: string[] } {
  const unknown = new Set<string>();
  const text = tpl.replace(VAR_RE, (m, k: string) => {
    if (k in vars) return vars[k as VariableKey];
    unknown.add(k);
    return m;
  });
  return { text, unknown: [...unknown] };
}

export function unknownVariables(tpl: string): string[] {
  return [...tpl.matchAll(VAR_RE)].map((m) => m[1]).filter((k) => !VARIABLES.some((v) => v.key === k));
}

export function durationText(min: number) {
  if (min < 60) return `${min} minutes`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m}` : `${h} heure${h > 1 ? "s" : ""}`;
}

/** Variables d'un rendez-vous, dans le fuseau du contact. Les liens privés sont fournis par le serveur. */
export function buildVariables(b: {
  first_name: string;
  last_name: string;
  company_name?: string | null;
  event: { name: string; duration_min: number };
  starts_at: string;
  invitee_timezone: string;
  meeting_url?: string | null;
}, links: { cancel: string; reschedule: string }): Variables {
  const tz = b.invitee_timezone;
  return {
    prenom: b.first_name,
    nom: b.last_name,
    entreprise: b.company_name ?? "",
    type: b.event.name,
    date: formatLongDate(b.starts_at, tz),
    heure: formatTimeShort(b.starts_at, tz),
    fuseau: timeZoneLabel(tz, new Date(b.starts_at)),
    duree: durationText(b.event.duration_min),
    lien_reunion: b.meeting_url ?? "",
    lien_annulation: links.cancel,
    lien_report: links.reschedule,
  };
}

/** Exemple proposé : 2 jours, 24 heures et 1 heure avant (délais exacts). */
export const EXAMPLE_RULES: ReminderRule[] = [
  {
    enabled: true, offset_value: 2, offset_unit: "days",
    subject: "Rappel : {{type}} le {{date}}",
    body: "Bonjour {{prenom}},\n\nPetit rappel de notre rendez-vous « {{type}} » le {{date}} à {{heure}} ({{fuseau}}), d'une durée de {{duree}}.\n\nBesoin de changer ? Reporter : {{lien_report}}\nAnnuler : {{lien_annulation}}\n\nÀ bientôt,\nCely Growth",
  },
  {
    enabled: true, offset_value: 24, offset_unit: "hours",
    subject: "Demain : {{type}} à {{heure}}",
    body: "Bonjour {{prenom}},\n\nNous avons rendez-vous demain à {{heure}} ({{fuseau}}).\n{{lien_reunion}}\n\nReporter : {{lien_report}}\nAnnuler : {{lien_annulation}}\n\nCely Growth",
  },
  {
    enabled: true, offset_value: 1, offset_unit: "hours",
    subject: "Dans 1 heure : {{type}}",
    body: "Bonjour {{prenom}},\n\nOn se retrouve dans une heure, à {{heure}}.\nLien de la réunion : {{lien_reunion}}\n\nÀ tout de suite,\nCely Growth",
  },
];
