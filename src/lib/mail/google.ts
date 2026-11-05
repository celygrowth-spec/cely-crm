import "server-only";

// Tous les appels à Google sont ici. Aucun autre fichier ne connaît ces adresses.
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media";

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const IDENTITY_SCOPES = ["openid", "email", "profile"];

export type GoogleClient = { clientId: string; clientSecret: string };

/** Autorisation progressive : la phase 1 ne demande que l'envoi, jamais la lecture de la boîte. */
export function authorizeUrl(c: GoogleClient, p: { redirectUri: string; state: string; challenge: string; loginHint?: string }) {
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: [...IDENTITY_SCOPES, GMAIL_SEND_SCOPE].join(" "),
    access_type: "offline",
    prompt: "consent select_account", // sans « consent », Google ne redonne pas de jeton de renouvellement
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return u.toString();
}

export type TokenSet = { accessToken: string; expiresAt: string; refreshToken?: string; scopes: string[]; email?: string; name?: string };

async function tokenRequest(body: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function toTokenSet(json: Record<string, unknown>): TokenSet {
  const idToken = typeof json.id_token === "string" ? json.id_token : null;
  // reçu directement de Google en HTTPS : pas de vérification de signature nécessaire (OpenID Connect, 3.1.3.7)
  const claims = idToken ? (JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { email?: string; name?: string }) : {};
  return {
    accessToken: String(json.access_token),
    expiresAt: new Date(Date.now() + Number(json.expires_in ?? 3000) * 1000).toISOString(),
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    scopes: typeof json.scope === "string" ? json.scope.split(" ") : [],
    email: claims.email,
    name: claims.name,
  };
}

export async function exchangeCode(c: GoogleClient, p: { code: string; redirectUri: string; verifier: string }) {
  const { status, json } = await tokenRequest({
    grant_type: "authorization_code",
    code: p.code,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
  });
  // le détail de la réponse n'est jamais journalisé : il peut contenir des données sensibles
  if (status !== 200 || !json.access_token) throw new GoogleError(`token_${status}`, "Google a refusé la connexion. Réessayez.");
  return toTokenSet(json);
}

export class GoogleError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** `revoked` : l'accès n'existe plus côté Google, seule une reconnexion peut le rétablir. */
export async function refreshAccess(c: GoogleClient, refreshToken: string) {
  const { status, json } = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: c.clientId, client_secret: c.clientSecret });
  if (json.error === "invalid_grant") throw new GoogleError("revoked", "Google a retiré l'accès à ce compte. Reconnectez Gmail.");
  if (status !== 200 || !json.access_token) throw new GoogleError("refresh_failed", "Renouvellement de l'accès Google impossible pour le moment.");
  return toTokenSet(json);
}

export async function revokeToken(token: string) {
  const res = await fetch(REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  // 400 : jeton déjà invalide, donc déjà révoqué
  return res.ok || res.status === 400;
}

export type SendOutcome =
  | { kind: "accepted"; messageId: string; threadId: string | null }
  | { kind: "failed"; code: string; message: string; retryAuth?: boolean }
  | { kind: "uncertain"; code: string; message: string };

const UNCERTAIN = "Gmail n'a pas répondu clairement : le message est peut-être parti. Vérifiez dans « Messages envoyés » avant de le renvoyer.";

/**
 * Gmail et la base ne partagent pas de transaction, et Gmail n'a pas de clé d'idempotence : seule une
 * réponse claire permet de conclure. Coupure, délai dépassé ou erreur 5xx donnent un résultat incertain.
 */
export async function gmailSend(accessToken: string, raw: Buffer, threadId?: string | null): Promise<SendOutcome> {
  let res: Response;
  try {
    // threadId n'est pas transmissible par l'envoi « media » : la réponse dans un fil passe par multipart.
    res = threadId ? await sendMultipart(accessToken, raw, threadId) : await fetch(SEND_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "message/rfc822" },
      body: new Uint8Array(raw),
      signal: AbortSignal.timeout(50_000),
    });
  } catch {
    return { kind: "uncertain", code: "network", message: UNCERTAIN };
  }
  const json = (await res.json().catch(() => null)) as { id?: string; threadId?: string; error?: { message?: string; errors?: { reason?: string }[] } } | null;
  if (res.ok) {
    if (json?.id) return { kind: "accepted", messageId: json.id, threadId: json.threadId ?? null };
    return { kind: "uncertain", code: "bad_response", message: UNCERTAIN };
  }
  if (res.status >= 500) return { kind: "uncertain", code: `http_${res.status}`, message: UNCERTAIN };
  const reason = json?.error?.errors?.[0]?.reason ?? "";
  if (res.status === 401) return { kind: "failed", code: "unauthorized", message: "Accès Google refusé. Reconnectez Gmail.", retryAuth: true };
  if (res.status === 429 || /rateLimit|userRateLimit|dailyLimit|quota/i.test(reason)) {
    return { kind: "failed", code: "quota", message: "Limite d'envoi Gmail atteinte. Réessayez plus tard." };
  }
  if (res.status === 403) return { kind: "failed", code: "forbidden", message: "Gmail refuse cet envoi : autorisation manquante. Reconnectez le compte en acceptant l'envoi." };
  if (res.status === 413) return { kind: "failed", code: "too_large", message: "Message trop volumineux pour Gmail." };
  return { kind: "failed", code: `http_${res.status}`, message: "Gmail a refusé ce message. Vérifiez les destinataires." };
}

function sendMultipart(accessToken: string, raw: Buffer, threadId: string) {
  const boundary = `cely_${crypto.randomUUID()}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ threadId })}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`),
    raw,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  return fetch(SEND_URL.replace("uploadType=media", "uploadType=multipart"), {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(50_000),
  });
}
