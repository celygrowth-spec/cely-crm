import "server-only";
// Appels à l'API lemlist (https://api.lemlist.com/api), toujours depuis le serveur.
// Authentification Basic : identifiant vide, mot de passe = clé API. Une clé = un compte lemlist.
// Limite : 20 requêtes par 2 secondes et par clé. Les erreurs sont traduites en codes : jamais la réponse brute
// (elle pourrait contenir des données d'un contact) ni la clé dans un message ou un journal.

export const LEMLIST_API = "https://api.lemlist.com/api";

export type LemlistErrorCode = "auth" | "rate" | "unavailable" | "bad_request";

export class LemlistError extends Error {
  constructor(public code: LemlistErrorCode, message: string, public retryAfterSec: number | null = null) {
    super(message);
    this.name = "LemlistError";
  }
}

const MESSAGES: Record<LemlistErrorCode, string> = {
  auth: "Clé API refusée par lemlist (invalide ou révoquée).",
  rate: "Limite de requêtes lemlist atteinte : nouvel essai dans quelques secondes.",
  unavailable: "lemlist n'a pas répondu.",
  bad_request: "lemlist a refusé la demande.",
};

/** Environnement de test local uniquement : faux lemlist sur 127.0.0.1 (scripts/test-env/lemlist-fake.mjs). */
function apiBase() {
  const local = process.env.LEMLIST_API_URL;
  if (local && process.env.CELY_TEST_ENV === "1" && /^http:\/\/127\.0\.0\.1:\d+$/.test(local)) return `${local}/api`;
  return LEMLIST_API;
}

export const authHeader = (apiKey: string) => `Basic ${Buffer.from(`:${apiKey}`, "utf8").toString("base64")}`;

export async function lemlistRequest<T>(
  apiKey: string,
  path: string,
  opts: { method?: "GET" | "POST"; query?: Record<string, string | number | boolean | undefined>; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(`${apiBase()}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers: { authorization: authHeader(apiKey), accept: "application/json", ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      cache: "no-store",
    });
  } catch {
    throw new LemlistError("unavailable", MESSAGES.unavailable);
  }
  if (res.status === 401) throw new LemlistError("auth", MESSAGES.auth);
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after"));
    throw new LemlistError("rate", MESSAGES.rate, Number.isFinite(after) && after > 0 ? after : 2);
  }
  if (res.status >= 500) throw new LemlistError("unavailable", MESSAGES.unavailable);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // « No user found for this API key » / « User linked to this API key is blocked » : clé inutilisable
    if (/api key/i.test(text)) throw new LemlistError("auth", MESSAGES.auth);
    throw new LemlistError("bad_request", MESSAGES.bad_request);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new LemlistError("unavailable", "Réponse de lemlist illisible.");
  }
}

export type LemlistTeam = { id: string; name: string; userIds: string[] };

/** Équipe de la clé : sert de test de clé à la connexion et à la vérification. */
export async function getTeam(apiKey: string, timeoutMs = 10_000): Promise<LemlistTeam> {
  const t = await lemlistRequest<{ _id?: unknown; name?: unknown; userIds?: unknown }>(apiKey, "/team", { timeoutMs });
  if (typeof t._id !== "string" || !t._id) throw new LemlistError("unavailable", "Réponse de lemlist illisible.");
  return {
    id: t._id,
    name: typeof t.name === "string" ? t.name.slice(0, 200) : "",
    userIds: Array.isArray(t.userIds) ? t.userIds.filter((u): u is string => typeof u === "string") : [],
  };
}
