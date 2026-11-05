// Dates et fuseaux côté interface. Les calculs de créneaux sont faits en base (Postgres gère les
// changements d'heure) ; ici, uniquement de l'affichage et du regroupement par jour local.

export const DEFAULT_TZ = "Europe/Paris";

/** Fuseau du navigateur, ou le fuseau par défaut s'il est inconnu. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Jour local AAAA-MM-JJ d'un instant dans un fuseau. */
export function dayKey(iso: string | Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso)).replace(":", " h ");
}

export function formatTimeShort(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function formatLongDate(iso: string, tz: string): string {
  const s = new Intl.DateTimeFormat("fr-FR", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** « lundi 7 décembre 2026 de 09:00 à 09:30 » */
export function formatRange(start: string, end: string, tz: string): string {
  return `${formatLongDate(start, tz)}, ${formatTimeShort(start, tz)} – ${formatTimeShort(end, tz)}`;
}

/** Libellé court d'un fuseau : « Europe/Paris (UTC+1) » à la date donnée. */
export function timeZoneLabel(tz: string, at: Date = new Date()): string {
  try {
    const off = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    return `${tz.replace(/_/g, " ")}${off ? ` (${off.replace("GMT", "UTC")})` : ""}`;
  } catch {
    return tz;
  }
}

/** Jour calendaire (AAAA-MM-JJ) décalé de n jours. */
export function addDaysKey(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Jour de la semaine ISO (1 = lundi … 7 = dimanche) d'un jour calendaire. */
export function isoWeekday(day: string): number {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w === 0 ? 7 : w;
}

/** Cases d'un mois pour un calendrier commençant le lundi (null = case vide). */
export function monthGrid(month: string): (string | null)[] {
  const first = `${month}-01`;
  const lead = isoWeekday(first) - 1;
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells: (string | null)[] = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function addMonthsKey(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

export function monthLabel(month: string): string {
  const s = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-15T12:00:00Z`));
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Instant UTC correspondant à une heure locale d'un fuseau (« 2026-03-29 », « 09:00 », Europe/Paris).
 * Heure inexistante (passage à l'heure d'été) : décalée après le saut, comme Postgres.
 */
export function zonedToUtc(day: string, time: string, tz: string): Date {
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (t: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(t));
    const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t;
  };
  const o1 = offsetAt(guess);
  const o2 = offsetAt(guess - o1);
  // l'un des deux décalages donne l'heure demandée ; sinon elle n'existe pas (saut) : on avance
  for (const o of [o1, o2]) if (offsetAt(guess - o) === o) return new Date(guess - o);
  return new Date(guess - Math.min(o1, o2));
}

/** Liste de fuseaux proposés au visiteur (le sien est ajouté s'il manque). */
export const COMMON_TIME_ZONES = [
  "Europe/Paris", "Europe/London", "Europe/Brussels", "Europe/Zurich", "Europe/Madrid", "Europe/Berlin", "Europe/Lisbon",
  "Africa/Casablanca", "Africa/Abidjan", "Africa/Dakar", "Indian/Reunion", "America/Martinique", "America/Guadeloupe",
  "America/Montreal", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo",
  "Asia/Dubai", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "Pacific/Noumea", "Pacific/Tahiti", "UTC",
];
