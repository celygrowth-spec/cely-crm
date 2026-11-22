// Dates du CMS : toujours saisies et affichées à l'heure de Paris (heure d'été comprise), stockées en UTC.
import { dayKey, formatTimeShort, zonedToUtc } from "@/lib/appointments/time";

export const CMS_TZ = "Europe/Paris";

/** Valeur d'un champ datetime-local (« 2026-12-01T09:30 ») à l'heure de Paris. */
export function toParisInput(iso: string | null): string {
  if (!iso) return "";
  return `${dayKey(iso, CMS_TZ)}T${formatTimeShort(iso, CMS_TZ)}`;
}

/** Instant UTC (ISO) d'une saisie datetime-local faite à l'heure de Paris ; null si invalide. */
export function fromParisInput(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);
  if (!m) return null;
  return zonedToUtc(m[1], m[2], CMS_TZ).toISOString();
}

/** « 1 déc. 2026 à 09:30 » (heure de Paris). */
export function formatParis(iso: string | null): string {
  if (!iso) return "—";
  const d = new Intl.DateTimeFormat("fr-FR", { timeZone: CMS_TZ, day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
  return `${d} à ${formatTimeShort(iso, CMS_TZ)}`;
}

export const parisDay = (iso: string | Date) => dayKey(iso, CMS_TZ);
