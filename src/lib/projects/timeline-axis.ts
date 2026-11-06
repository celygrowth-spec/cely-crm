// Échelle de la frise d'un projet : jours entiers (une phase occupe ses jours de début à fin inclus),
// repères de mois et de jours (10 · 20 · 30) qui n'existent que s'ils existent dans le calendrier et
// tombent dans la période visible. La densité dépend de la durée ; l'affichage selon la largeur d'écran
// est géré par des classes (base / sm / lg).

const DAY = 86_400_000;
/** Jour civil (YYYY-MM-DD) → nombre de jours depuis l'époque, sans fuseau. */
export const dayNum = (d: string) => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / DAY);
const fromDayNum = (n: number) => new Date(n * DAY);

export type Scale = { first: number; days: number; at: (d: string, edge?: "start" | "end" | "mid") => number };

/** Période couverte par les dates connues ; null s'il n'y a pas au moins deux dates. */
export function makeScale(dates: (string | null | undefined)[]): Scale | null {
  const ds = dates.filter((d): d is string => !!d).map((d) => dayNum(d.slice(0, 10)));
  if (ds.length < 2) return null;
  const first = Math.min(...ds);
  const days = Math.max(...ds) - first + 1; // dernier jour inclus
  const at = (d: string, edge: "start" | "end" | "mid" = "start") => {
    const x = dayNum(d.slice(0, 10)) - first + (edge === "end" ? 1 : edge === "mid" ? 0.5 : 0);
    return (x / days) * 100;
  };
  return { first, days, at };
}

/** Visibilité d'un repère selon la largeur : partout, à partir de sm, à partir de lg, ou jamais. */
export type TickReach = "all" | "sm" | "lg" | "none";
export type Tick = { key: string; left: number; label: string; kind: "month" | "day"; reach: TickReach; year?: number };

const MONTH = new Intl.DateTimeFormat("fr-FR", { month: "short", timeZone: "UTC" });

const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export function axisTicks(scale: Scale): Tick[] {
  const { first, days } = scale;
  const ticks: Tick[] = [];
  const pct = (n: number) => ((n - first) / days) * 100;
  // densité des jours : courte période → partout ; moyenne → tablette et plus ; longue → grand écran
  const dayReach: TickReach = days <= 75 ? "all" : days <= 200 ? "sm" : days <= 400 ? "lg" : "none";
  const monthEvery = days > 730 ? 3 : 1;
  const months: number[] = [];
  const crossesYear = fromDayNum(first).getUTCFullYear() !== fromDayNum(first + days - 1).getUTCFullYear();
  for (let n = first; n < first + days; n++) {
    const d = fromDayNum(n);
    const day = d.getUTCDate();
    if (day === 1) months.push(n);
    else if (n !== first) continue;
    // période commencée en cours de mois : le mois en cours est indiqué au début, sauf s'il chevaucherait le suivant
    let startReach: TickReach = "all";
    if (day !== 1) {
      const gap = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / DAY - first) / days;
      if (gap < 0.12) continue;
      if (gap < 0.25) startReach = "sm"; // sur mobile, trop proche du mois suivant
    }
    const m = d.getUTCMonth();
    const reach: TickReach = monthEvery > 1 && m % monthEvery !== 0 ? "none" : days > 400 && m % 3 !== 0 ? "sm" : startReach;
    const year = crossesYear && (m === 0 || n === first) ? d.getUTCFullYear() : undefined;
    ticks.push({ key: `m${n}`, left: pct(n), label: capitalize(MONTH.format(d).replace(".", "")), kind: "month", reach, year });
  }
  if (dayReach !== "none") {
    const gap = Math.max(2, Math.round(days * 0.035)); // pas de numéro collé à un repère de mois
    for (let n = first; n < first + days; n++) {
      const day = fromDayNum(n).getUTCDate();
      if (day !== 10 && day !== 20 && day !== 30) continue; // le 30 n'existe pas en février : il n'est jamais généré
      if (months.some((m) => Math.abs(m - n) < gap) || (n - first < gap && fromDayNum(first).getUTCDate() !== 1)) continue;
      ticks.push({ key: `d${n}`, left: pct(n), label: String(day), kind: "day", reach: dayReach });
    }
  }
  return ticks.sort((a, b) => a.left - b.left);
}

export const REACH_CLASS: Record<TickReach, string> = { all: "", sm: "hidden sm:block", lg: "hidden lg:block", none: "hidden" };
