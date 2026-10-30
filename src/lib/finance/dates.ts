// Dates au format AAAA-MM-JJ (jour calendaire à Paris), sans fuseau ni heure.

export type Frequency = "mensuel" | "trimestriel" | "annuel";
export const FREQ_MONTHS: Record<Frequency, number> = { mensuel: 1, trimestriel: 3, annuel: 12 };

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return [y, m, d];
}
const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Ajoute n mois ; le jour est ramené au dernier jour du mois si besoin (comme Postgres). */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = parts(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return ymd(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso.slice(0, 10) + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Même règle que public.finance_add_frequency : date de départ + k × fréquence. */
export function addFrequency(iso: string, f: Frequency, steps = 1): string {
  return addMonths(iso, FREQ_MONTHS[f] * steps);
}

export const monthStart = (iso: string) => iso.slice(0, 8) + "01";
export function monthEnd(iso: string): string {
  const [y, m] = parts(iso);
  return ymd(y, m, daysInMonth(y, m));
}
export function quarterStart(iso: string): string {
  const [y, m] = parts(iso);
  return ymd(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
}
export const quarterEnd = (iso: string) => monthEnd(addMonths(quarterStart(iso), 2));

export const inRange = (d: string | null | undefined, from: string, to: string) => !!d && d >= from && d <= to;

/** Nombre de jours inclusifs. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
}

/** Mois (AAAA-MM-01) couverts par [from, to]. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = monthStart(from); m <= to && out.length < 240; m = addMonths(m, 1)) out.push(m);
  return out;
}

const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" });
const monthLongFmt = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
export const monthLabel = (iso: string) => monthFmt.format(new Date(monthStart(iso) + "T12:00:00Z"));
export const monthLongLabel = (iso: string) => monthLongFmt.format(new Date(monthStart(iso) + "T12:00:00Z"));

// ---------------------------------------------------------------------------
// Sélecteur de période
// ---------------------------------------------------------------------------

export type PeriodKind = "mois" | "trimestre" | "annee" | "perso";
export type Period = { kind: PeriodKind; from: string; to: string; label: string };

export function resolvePeriod(kind: string | undefined, ref: string, from?: string, to?: string): Period {
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  if (kind === "perso" && isDate(from) && isDate(to) && from! <= to!) {
    return { kind: "perso", from: from!, to: to!, label: `Du ${from} au ${to}` };
  }
  if (kind === "trimestre") {
    const f = quarterStart(ref);
    const q = Math.floor((parts(f)[1] - 1) / 3) + 1;
    return { kind, from: f, to: quarterEnd(ref), label: `T${q} ${parts(f)[0]}` };
  }
  if (kind === "annee") {
    const y = parts(ref)[0];
    return { kind, from: ymd(y, 1, 1), to: ymd(y, 12, 31), label: `Année ${y}` };
  }
  return { kind: "mois", from: monthStart(ref), to: monthEnd(ref), label: monthLongLabel(ref) };
}

/** Période précédente de même nature (même durée pour une période personnalisée). */
export function previousPeriod(p: Period): Period {
  if (p.kind === "mois") return resolvePeriod("mois", addMonths(p.from, -1));
  if (p.kind === "trimestre") return resolvePeriod("trimestre", addMonths(p.from, -3));
  if (p.kind === "annee") return resolvePeriod("annee", addMonths(p.from, -12));
  const len = dayCount(p.from, p.to);
  const to = addDays(p.from, -1);
  return resolvePeriod("perso", to, addDays(to, -(len - 1)), to);
}

// ---------------------------------------------------------------------------
// Périodes de déclaration URSSAF
// ---------------------------------------------------------------------------

export type Periodicity = "monthly" | "quarterly";

export function declarationPeriod(date: string, p: Periodicity): { start: string; end: string } {
  return p === "monthly" ? { start: monthStart(date), end: monthEnd(date) } : { start: quarterStart(date), end: quarterEnd(date) };
}

/**
 * Échéance officielle de déclaration et de paiement d'un auto-entrepreneur : dernier jour
 * du mois qui suit la période déclarée (mois ou trimestre).
 * Source : https://www.autoentrepreneur.urssaf.fr/portail/accueil/une-question/toutes-les-fiches-pratiques/declarer-et-payer-mes-cotisation.html
 * (tableau des échéances, ex. « Du 1er au 28 février → 31 mars »), vérifiée le 2026-10-30.
 * L'Urssaf peut déplacer une échéance (week-end, incident) : l'utilisateur peut la remplacer.
 */
export function officialDeadline(periodEnd: string): string {
  return monthEnd(addMonths(monthStart(periodEnd), 1));
}
