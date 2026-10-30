// Montants en centimes entiers : aucune opération en virgule flottante sur des euros.
// La base stocke des numeric(12,2) ; PostgREST les renvoie en nombre JSON ou en texte.

/** Convertit une valeur numeric (nombre ou texte « 1234.5 ») en centimes, sans calcul flottant. */
export function toCents(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const s = typeof v === "number" ? v.toFixed(2) : String(v).trim();
  const m = s.match(/^(-)?(\d+)(?:\.(\d{1,}))?$/);
  if (!m) throw new Error(`Montant illisible : ${s}`);
  const frac = (m[3] ?? "").padEnd(2, "0");
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  // arrondi au centime le plus proche si la base renvoie plus de deux décimales
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1;
  return m[1] ? -cents : cents;
}

/** Centimes → texte numeric pour la base (« 1234.56 »). */
export function centsToDb(c: number | null | undefined): string | null {
  if (c === null || c === undefined) return null;
  if (!Number.isInteger(c)) throw new Error("Montant non entier en centimes");
  const neg = c < 0;
  const a = Math.abs(c);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/**
 * Lit une saisie française (« 1 234,56 », « 1234.5 », « 12 € ») en centimes.
 * Renvoie null si vide, NaN si illisible.
 */
export function parseEuroInput(input: string): number | null {
  const s = input.replace(/[\s  €]/g, "").replace(",", ".");
  if (!s) return null;
  const m = s.match(/^(\d+)(?:\.(\d{0,2}))?$/);
  if (!m) return NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

/** Centimes → saisie éditable (« 1234,56 »). */
export function centsToInput(c: number | null | undefined): string {
  if (c === null || c === undefined) return "";
  return (centsToDb(c) ?? "").replace(".", ",").replace(/,00$/, "");
}

const fmt = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt0 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/** Affichage en euros. Le passage en nombre n'a lieu qu'ici, pour l'affichage. */
export function eur(c: number | null | undefined, opts: { round?: boolean } = {}): string {
  if (c === null || c === undefined) return "Inconnu";
  return (opts.round ? fmt0 : fmt).format(c / 100);
}

export function sum(values: (number | null | undefined)[]): number {
  let t = 0;
  for (const v of values) if (v) t += v;
  return t;
}

/** Somme avec suivi des montants inconnus : un montant manquant n'est jamais compté comme zéro. */
export type KnownSum = { cents: number; unknown: number };
export function sumKnown(values: (number | null | undefined)[]): KnownSum {
  let cents = 0;
  let unknown = 0;
  for (const v of values) {
    if (v === null || v === undefined) unknown++;
    else cents += v;
  }
  return { cents, unknown };
}

/** a × num / den arrondi au centime (demi vers le haut), en entiers. */
export function mulDiv(a: number, num: number, den: number): number {
  if (den === 0) return 0;
  const sign = Math.sign(a) * Math.sign(num) * Math.sign(den);
  const q = BigInt(Math.abs(a)) * BigInt(Math.abs(num));
  const d = BigInt(Math.abs(den));
  const two = BigInt(2);
  const r = (q * two + d) / (two * d);
  return sign * Number(r);
}

/** Taux « 25.6 » / « 25.600 » → millièmes de pourcent (25600). */
export function rateToMilli(rate: number | string): number {
  const s = typeof rate === "number" ? rate.toFixed(3) : String(rate).trim();
  const m = s.match(/^(\d+)(?:\.(\d{0,3}))?\d*$/);
  if (!m) throw new Error(`Taux illisible : ${s}`);
  return Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
}

/** Montant × taux (en millièmes de pourcent), arrondi au centime. */
export function applyRate(cents: number, rateMilli: number): number {
  return mulDiv(cents, rateMilli, 100000);
}

export function formatRate(milli: number | null | undefined): string {
  if (milli === null || milli === undefined) return "—";
  return `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(milli / 1000)} %`;
}

/** Millièmes de pourcent → texte numeric (25600 → « 25.600 »). */
export function milliToRate(milli: number): string {
  return `${Math.floor(milli / 1000)}.${String(milli % 1000).padStart(3, "0")}`;
}
