// Search Console et Bing Webmaster Tools : règles pures (aucun accès réseau ni base), partagées par le serveur,
// l'interface et les tests. Aucun secret ne passe ici.

export type SeoProvider = "gsc" | "bing";
export const SEO_PROVIDERS: SeoProvider[] = ["gsc", "bing"];

/** Clé du connecteur dans l'espace Connecteurs ↔ fournisseur en base. */
export const SEO_CONNECTOR_KEY = { gsc: "search_console", bing: "bing_webmaster" } as const;
export type SeoConnectorKey = (typeof SEO_CONNECTOR_KEY)[SeoProvider];
export const providerOfKey = (key: string): SeoProvider | null =>
  key === "search_console" ? "gsc" : key === "bing_webmaster" ? "bing" : null;

/**
 * Une ligne de seo_daily. Niveaux : page et requête renseignées = croisement ; page '' = total d'une requête ;
 * requête '' = total d'une page ; les deux vides = total du site. Ne jamais additionner deux niveaux.
 */
export type SeoRow = { day: string; page: string; query: string; clicks: number; impressions: number; position: number | null };

/** Ce que l'interface reçoit pour le panneau du connecteur : aucun secret. */
export type SeoDetail = {
  provider: SeoProvider;
  /** identifiants et secret serveur présents */
  configured: boolean;
  connected: boolean;
  siteUrl: string | null;
  /** propriétés proposées au choix (Search Console) */
  sites: string[];
  historyDone: boolean;
  /** Search Console : jour jusqu'auquel l'historique est déjà importé (en remontant le temps) */
  historyReached: string | null;
  rows: number | null;
};

// ---------------------------------------------------------------------------
// Dates (jours « AAAA-MM-JJ », calcul en UTC)
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
export const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Jours de `from` à `to` inclus, dans l'ordre (vide si from > to). */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Search Console garde environ 16 mois de données. */
export const GSC_HISTORY_MONTHS = 16;
/** Les 3 derniers jours de Search Console sont provisoires : on relit toujours les 4 derniers. */
export const GSC_RECENT_DAYS = 4;

export function monthsBefore(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return dayOf(target.getTime());
}

// ---------------------------------------------------------------------------
// Curseur Search Console : reprise exacte après interruption
// ---------------------------------------------------------------------------

/**
 * floor : premier jour à importer (16 mois avant la première synchronisation) ;
 * history_until : prochain jour d'historique à importer, en remontant le temps (null = pas commencé) ;
 * recent_to : dernier jour récent déjà relu (pour rattraper un passage manqué).
 */
export type GscCursor = { floor: string | null; history_until: string | null; recent_to: string | null };

export function readGscCursor(raw: unknown): GscCursor {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { floor: isDay(c.floor) ? c.floor : null, history_until: isDay(c.history_until) ? c.history_until : null, recent_to: isDay(c.recent_to) ? c.recent_to : null };
}

/**
 * Ce qu'un passage doit lire. `today` est le jour UTC courant : Search Console compte en heure du Pacifique,
 * donc on s'arrête à la veille (jamais un jour futur pour Google).
 * - recent : jours à relire, du plus ancien au plus récent (les 4 derniers, plus les jours manqués) ;
 * - cursor : curseur initialisé si c'est le premier passage (l'historique commence juste avant la fenêtre récente).
 */
export function planGsc(raw: unknown, today: string): { end: string; recent: string[]; cursor: GscCursor } {
  const c = readGscCursor(raw);
  const end = addDays(today, -1);
  const floor = c.floor ?? monthsBefore(end, GSC_HISTORY_MONTHS);
  const usual = addDays(end, -(GSC_RECENT_DAYS - 1));
  // au dernier passage, les 3 derniers jours lus étaient encore provisoires : on repart de là
  let from = c.recent_to ? addDays(c.recent_to, -(GSC_RECENT_DAYS - 2)) : usual;
  if (from > usual) from = usual;
  if (from < floor) from = floor;
  // historique terminé : history_until est passé sous floor (jamais null une fois commencé)
  const historyUntil = c.history_until ?? addDays(from, -1);
  return { end, recent: dayRange(from, end), cursor: { floor, history_until: historyUntil, recent_to: c.recent_to } };
}

/** Prochains jours d'historique (du plus récent au plus ancien), au plus `size`. Vide = historique terminé. */
export function nextHistoryDays(c: GscCursor, size: number): string[] {
  if (!c.floor || !c.history_until) return [];
  const out: string[] = [];
  for (let d = c.history_until; d >= c.floor && out.length < size; d = addDays(d, -1)) out.push(d);
  return out;
}

// ---------------------------------------------------------------------------
// Curseur Bing : l'API rend tout l'historique disponible à chaque appel, un appel par niveau puis un par page
// ---------------------------------------------------------------------------

export type BingPhase = "totals" | "queries" | "pages" | "page_queries";
export type BingCursor = { phase: BingPhase; pages: string[]; index: number };
export const BING_MAX_PAGES = 200;

export function readBingCursor(raw: unknown): BingCursor {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const phase = (["totals", "queries", "pages", "page_queries"] as const).find((p) => p === c.phase) ?? "totals";
  const pages = Array.isArray(c.pages) ? c.pages.filter((p): p is string => typeof p === "string").slice(0, BING_MAX_PAGES) : [];
  const index = typeof c.index === "number" && c.index >= 0 ? Math.floor(c.index) : 0;
  return phase === "page_queries" ? { phase, pages, index } : { phase, pages: [], index: 0 };
}

// ---------------------------------------------------------------------------
// Pages et lignes
// ---------------------------------------------------------------------------

/**
 * Adresse complète → chemin (« /services »). Sans paramètres ni ancre, sans barre finale (sauf la racine).
 * '' si l'adresse est vide ou illisible.
 */
export function normalizePage(url: string | null | undefined): string {
  const raw = (url ?? "").trim();
  if (!raw) return "";
  let path: string;
  try {
    path = new URL(raw, "https://x.invalid").pathname;
  } catch {
    return "";
  }
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  return path.slice(0, 500);
}

/**
 * Regroupe les lignes qui tombent sur la même clé après normalisation (deux adresses, un même chemin) :
 * clics et impressions additionnés, position moyenne pondérée par les impressions.
 */
export function mergeRows(rows: SeoRow[]): SeoRow[] {
  const map = new Map<string, SeoRow & { w: number; pw: number }>();
  for (const r of rows) {
    const key = `${r.day}\u0000${r.page}\u0000${r.query}`;
    const weight = Math.max(r.impressions, 1);
    const cur = map.get(key);
    if (!cur) {
      map.set(key, { ...r, w: r.position === null ? 0 : weight, pw: r.position === null ? 0 : r.position * weight });
      continue;
    }
    cur.clicks += r.clicks;
    cur.impressions += r.impressions;
    if (r.position !== null) {
      cur.w += weight;
      cur.pw += r.position * weight;
    }
  }
  return [...map.values()].map(({ w, pw, ...r }) => ({ ...r, position: w > 0 ? Math.round((pw / w) * 100) / 100 : null }));
}

const int = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Ligne de searchAnalytics.query (dimensions date, page, query) → ligne de seo_daily ; null si inexploitable. */
export function gscRow(r: { keys?: unknown[]; clicks?: number; impressions?: number; position?: number }): SeoRow | null {
  const [day, page, query] = r.keys ?? [];
  if (!isDay(day) || typeof page !== "string" || typeof query !== "string") return null;
  const position = typeof r.position === "number" && Number.isFinite(r.position) && r.position > 0 ? Math.round(r.position * 100) / 100 : null;
  const path = normalizePage(page);
  if (!path || !query) return null;
  return { day, page: path, query: query.slice(0, 500), clicks: int(r.clicks), impressions: int(r.impressions), position };
}

/**
 * Date renvoyée par l'API JSON de Bing : « /Date(1316156400000-0700)/ » (millisecondes, puis décalage local).
 * Le jour retenu est celui de l'horloge locale indiquée. null si illisible.
 */
export function bingDay(value: unknown): string | null {
  const m = typeof value === "string" ? /^\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\/$/.exec(value) : null;
  if (!m) return null;
  const offset = m[2] ? (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) * 60_000 : 0;
  const ms = Number(m[1]) + offset;
  return Number.isFinite(ms) ? dayOf(ms) : null;
}

export type BingStat = { Query?: unknown; Date?: unknown; Clicks?: unknown; Impressions?: unknown; AvgImpressionPosition?: unknown };

/**
 * Ligne QueryStats de Bing → ligne de seo_daily. `as` dit ce que contient le champ Query de la réponse :
 * une requête (GetQueryStats, GetPageQueryStats) ou l'adresse d'une page (GetPageStats).
 * Position : AvgImpressionPosition (position moyenne à l'affichage) ; absente ou négative = inconnue.
 */
export function bingRow(s: BingStat, as: "query" | "page", fixed: { page?: string } = {}): SeoRow | null {
  const day = bingDay(s.Date);
  if (!day || typeof s.Query !== "string" || !s.Query.trim()) return null;
  const pos = typeof s.AvgImpressionPosition === "number" && s.AvgImpressionPosition > 0 ? Math.round(s.AvgImpressionPosition * 100) / 100 : null;
  const page = as === "page" ? normalizePage(s.Query) : (fixed.page ?? "");
  if (as === "page" && !page) return null;
  return {
    day,
    page,
    query: as === "query" ? s.Query.trim().slice(0, 500) : "",
    clicks: int(s.Clicks), impressions: int(s.Impressions), position: pos,
  };
}

/** Même site, écrit avec ou sans barre finale, en majuscules ou non. */
export const sameSite = (a: string, b: string) => a.trim().replace(/\/+$/, "").toLowerCase() === b.trim().replace(/\/+$/, "").toLowerCase();
