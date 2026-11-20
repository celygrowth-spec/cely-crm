import "server-only";
// Bing Webmaster Tools, en LECTURE SEULE : uniquement des appels GET de consultation.
// Documentation : learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi
//
// Ce que l'API donne réellement (aucune méthode n'accepte de dates : chaque appel rend tout l'historique que Bing
// conserve, une ligne par date) :
//   GetRankAndTrafficStats(siteUrl)     : clics et impressions du site par jour, sans position (mis à jour chaque jour) ;
//   GetQueryStats(siteUrl)              : requêtes principales, par date (mis à jour chaque semaine) ;
//   GetPageStats(siteUrl)               : pages principales, par date (mis à jour chaque semaine) ;
//   GetPageQueryStats(siteUrl, page)    : requêtes d'UNE page, par date (mis à jour chaque semaine) → un appel par page.
// Limites, à connaître en lisant les chiffres :
//   - pas de croisement page × requête en un seul appel : il n'est lu que pour les pages principales (200 au plus) ;
//   - seules les requêtes et pages « principales » sont rendues, pas la longue traîne ;
//   - la documentation ne précise ni la profondeur de l'historique ni le pas des dates des statistiques
//     hebdomadaires : les lignes sont rangées telles que Bing les date ;
//   - les quatre niveaux (site, requête, page, page × requête) ne s'additionnent pas entre eux.
//
// La clé API voyage dans l'adresse : l'adresse n'est donc jamais journalisée ni recopiée dans une erreur.
import { bingRow, mergeRows, bingDay, type BingStat, type SeoRow } from "./rules";

const API = "https://ssl.bing.com/webmaster/api.svc/json";
const TIMEOUT_MS = 15_000;

/** kind : auth = clé refusée (à remplacer) ; throttle ; network ; other. */
export class BingError extends Error {
  constructor(message: string, readonly kind: "auth" | "throttle" | "network" | "other") {
    super(message);
  }
}

// ApiErrorCode : 3 InvalidApiKey, 4 ThrottleUser, 5 ThrottleHost, 6 UserBlocked, 10 UserNotFound, 13 NotAllowed, 14 NotAuthorized
const AUTH_CODES = new Set([3, 6, 10, 13, 14]);
const THROTTLE_CODES = new Set([4, 5]);

async function get<T>(method: string, apiKey: string, params: Record<string, string> = {}, fetcher: typeof fetch = fetch): Promise<T> {
  // L'API JSON (enveloppe « d ») attend les paramètres texte autres que siteUrl encodés en JSON, comme dans les
  // exemples officiels (page=%22http…%22).
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) q.set(k, k === "siteUrl" ? v : JSON.stringify(v));
  q.set("apikey", apiKey);
  let res: Response;
  try {
    res = await fetcher(`${API}/${method}?${q.toString()}`, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store", redirect: "error" });
  } catch {
    // ni l'erreur d'origine ni l'adresse ne sont reprises : elles contiennent la clé
    throw new BingError("Bing n'a pas répondu.", "network");
  }
  const body = (await res.json().catch(() => null)) as { d?: unknown; ErrorCode?: number } | null;
  const code = typeof body?.ErrorCode === "number" ? body.ErrorCode : null;
  if (res.status === 401 || res.status === 403 || (code !== null && AUTH_CODES.has(code))) {
    throw new BingError("Clé API refusée par Bing : générez-en une nouvelle dans Bing Webmaster Tools, puis reconnectez.", "auth");
  }
  if (res.status === 429 || (code !== null && THROTTLE_CODES.has(code))) throw new BingError("Bing limite les appels pour le moment : nouvel essai au prochain passage.", "throttle");
  if (!res.ok || !body || code) throw new BingError(`Bing a refusé la lecture (${method}, code ${code ?? res.status}).`, "other");
  return body.d as T;
}

/** Sites vérifiés du compte de la clé. */
export async function listSites(apiKey: string, fetcher?: typeof fetch): Promise<string[]> {
  const d = await get<{ Url?: string; IsVerified?: boolean }[] | null>("GetUserSites", apiKey, {}, fetcher);
  return (d ?? []).filter((s) => s.Url && s.IsVerified !== false).map((s) => s.Url as string);
}

/** Total du site par jour (page '' et requête ''), sans position. */
export async function siteTotals(apiKey: string, siteUrl: string, fetcher?: typeof fetch): Promise<SeoRow[]> {
  const d = await get<{ Date?: unknown; Clicks?: number; Impressions?: number }[] | null>("GetRankAndTrafficStats", apiKey, { siteUrl }, fetcher);
  const rows: SeoRow[] = [];
  for (const s of d ?? []) {
    const day = bingDay(s.Date);
    if (day) rows.push({ day, page: "", query: "", clicks: Math.max(0, Math.round(Number(s.Clicks) || 0)), impressions: Math.max(0, Math.round(Number(s.Impressions) || 0)), position: null });
  }
  return mergeRows(rows);
}

/** Requêtes principales par date (page ''). */
export async function queryStats(apiKey: string, siteUrl: string, fetcher?: typeof fetch): Promise<SeoRow[]> {
  const d = await get<BingStat[] | null>("GetQueryStats", apiKey, { siteUrl }, fetcher);
  return mergeRows((d ?? []).map((s) => bingRow(s, "query")).filter((r): r is SeoRow => !!r));
}

/** Pages principales par date (requête ''), et leurs adresses complètes, les plus vues d'abord. */
export async function pageStats(apiKey: string, siteUrl: string, fetcher?: typeof fetch): Promise<{ rows: SeoRow[]; urls: string[] }> {
  const d = (await get<BingStat[] | null>("GetPageStats", apiKey, { siteUrl }, fetcher)) ?? [];
  const seen = new Map<string, number>();
  for (const s of d) if (typeof s.Query === "string" && /^https?:\/\//i.test(s.Query)) seen.set(s.Query, (seen.get(s.Query) ?? 0) + (Number(s.Impressions) || 0));
  const urls = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
  return { rows: mergeRows(d.map((s) => bingRow(s, "page")).filter((r): r is SeoRow => !!r)), urls };
}

/** Requêtes d'une page, par date (croisement page × requête). */
export async function pageQueryStats(apiKey: string, siteUrl: string, pageUrl: string, fetcher?: typeof fetch): Promise<SeoRow[]> {
  const d = await get<BingStat[] | null>("GetPageQueryStats", apiKey, { siteUrl, page: pageUrl }, fetcher);
  const page = bingRow({ Query: pageUrl, Date: "/Date(0)/" }, "page")?.page ?? "";
  if (!page) return [];
  return mergeRows((d ?? []).map((s) => bingRow(s, "query", { page })).filter((r): r is SeoRow => !!r));
}
