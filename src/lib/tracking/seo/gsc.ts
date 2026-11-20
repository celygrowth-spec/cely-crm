import "server-only";
// Google Search Console, en LECTURE SEULE (fetch, sans SDK). Une seule portée demandée : webmasters.readonly.
// Appels utilisés (documentation : developers.google.com/webmaster-tools/v1) :
//   GET  /webmasters/v3/sites                              : propriétés du compte ;
//   POST /webmasters/v3/sites/{siteUrl}/searchAnalytics/query : clics, impressions, position (c'est une requête de
//        lecture malgré le verbe POST ; rien n'est jamais écrit dans Search Console).
// Aucun jeton n'est journalisé ni renvoyé : les messages d'erreur sont écrits ici.
import { googleConfig } from "@/lib/appointments/config";
import { gscRow, type SeoRow } from "./rules";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const API = "https://www.googleapis.com/webmasters/v3";
const TIMEOUT_MS = 12_000;
const ROW_LIMIT = 25_000;

/** kind : reauth = accès expiré ou révoqué ; forbidden = propriété inaccessible ; quota ; network ; other. */
export class GscError extends Error {
  constructor(message: string, readonly kind: "reauth" | "forbidden" | "quota" | "network" | "config" | "other") {
    super(message);
  }
}

/** Client OAuth dédié s'il existe, sinon celui de Google Agenda (ou le client Google générique). */
export function gscConfig(): { clientId: string; clientSecret: string; dedicated: boolean } | null {
  const id = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_ID;
  const secret = process.env.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET;
  if (id && secret) {
    const shared = [process.env.GOOGLE_CALENDAR_CLIENT_ID, process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_MAIL_CLIENT_ID].includes(id);
    return { clientId: id, clientSecret: secret, dedicated: !shared };
  }
  const fallback = googleConfig();
  return fallback ? { ...fallback, dedicated: false } : null;
}

function config() {
  const c = gscConfig();
  if (!c) throw new GscError("Search Console n'est pas configuré sur le serveur (GOOGLE_SEARCH_CONSOLE_CLIENT_ID / GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET).", "config");
  return c;
}

async function call(url: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  try {
    return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new GscError("Google n'a pas répondu.", "network");
  }
}

async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
  const oauth = typeof body?.error === "string" ? body.error : null;
  if (res.status === 401 || oauth === "invalid_grant") throw new GscError("Google a refusé l'accès (révoqué ou expiré) : reconnectez Search Console.", "reauth");
  if (res.status === 403) throw new GscError("Google refuse l'accès à cette propriété : vérifiez vos droits dans Search Console, ou choisissez une autre propriété.", "forbidden");
  if (res.status === 429) throw new GscError("Quota Search Console atteint : nouvel essai au prochain passage.", "quota");
  throw new GscError(`${what} : Google a répondu avec le code ${res.status}.`, "other");
}

// ---------------------------------------------------------------------------
// OAuth (code + PKCE, accès hors ligne) : même déroulé que Google Agenda
// ---------------------------------------------------------------------------

export function authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
  const q = new URLSearchParams({
    client_id: config().clientId, redirect_uri: p.redirectUri, response_type: "code", scope: GSC_SCOPE,
    access_type: "offline", prompt: "consent select_account", state: p.state, code_challenge: p.codeChallenge, code_challenge_method: "S256",
  });
  // pas d'include_granted_scopes : le jeton reste limité à la lecture de Search Console
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

export async function exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }) {
  const { clientId, clientSecret } = config();
  const res = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code: p.code, client_id: clientId, client_secret: clientSecret, redirect_uri: p.redirectUri, grant_type: "authorization_code", code_verifier: p.codeVerifier }),
  });
  if (!res.ok) await fail(res, "Échange du code Google");
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

// Jetons d'accès gardés en mémoire du processus (jamais en base, jamais côté navigateur)
const accessCache = new Map<string, { token: string; exp: number }>();

export async function accessToken(refreshToken: string): Promise<string> {
  const cached = accessCache.get(refreshToken);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const { clientId, clientSecret } = config();
  const res = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) await fail(res, "Renouvellement de l'accès Google");
  const j = (await res.json()) as { access_token: string; expires_in: number };
  accessCache.set(refreshToken, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

/** true : Google confirme la révocation (ou le jeton n'était déjà plus valide). */
export async function revoke(refreshToken: string): Promise<boolean> {
  accessCache.delete(refreshToken);
  const res = await call("https://oauth2.googleapis.com/revoke", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }),
  }).catch(() => null);
  return !!res && (res.ok || res.status === 400);
}

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/** Propriétés vérifiées du compte (« sc-domain:exemple.com » ou « https://exemple.com/ »). */
export async function listSites(token: string): Promise<string[]> {
  const res = await call(`${API}/sites`, { token });
  if (!res.ok) await fail(res, "Liste des propriétés Search Console");
  const j = (await res.json()) as { siteEntry?: { siteUrl?: string; permissionLevel?: string }[] };
  return (j.siteEntry ?? []).filter((s) => s.siteUrl && s.permissionLevel !== "siteUnverifiedUser").map((s) => s.siteUrl as string).sort();
}

/**
 * Toutes les lignes d'UN jour (date, page, requête), recherche web. Google recommande une requête par jour et
 * pagine par 25 000 lignes (au plus 50 000 par jour et par type de recherche). dataState « all » inclut les
 * données fraîches, encore provisoires : c'est pourquoi les derniers jours sont relus à chaque passage.
 * Les requêtes anonymisées par Google ne figurent pas dans ce détail : la somme est inférieure au total affiché
 * dans Search Console.
 */
export async function queryDay(token: string, siteUrl: string, day: string): Promise<SeoRow[]> {
  const out: SeoRow[] = [];
  for (let startRow = 0; startRow < 4 * ROW_LIMIT; startRow += ROW_LIMIT) {
    const res = await call(`${API}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
      method: "POST", token, headers: { "content-type": "application/json" },
      body: JSON.stringify({ startDate: day, endDate: day, dimensions: ["date", "page", "query"], type: "web", dataState: "all", rowLimit: ROW_LIMIT, startRow }),
    });
    if (!res.ok) await fail(res, "Lecture de Search Console");
    const j = (await res.json()) as { rows?: { keys?: unknown[]; clicks?: number; impressions?: number; position?: number }[] };
    const rows = j.rows ?? [];
    for (const r of rows) {
      const row = gscRow(r);
      if (row) out.push(row);
    }
    if (rows.length < ROW_LIMIT) break;
  }
  return out;
}
