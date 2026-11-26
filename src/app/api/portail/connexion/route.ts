// Connexion au portail client : email + mot de passe (compte créé par invitation), ou ancien code d'accès tant
// que le contact n'a pas activé de compte. Les secrets ne transitent que dans le corps de la requête, jamais dans
// l'URL ; ils ne sont ni journalisés ni conservés.
import type { NextRequest } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { isEmail } from "@/lib/mail/types";
import { PASSWORD_MAX } from "@/lib/projects/password-rules";
import { PORTAL_COOKIE, clientIp, codeHash, cookieOptions, emailHash, ipHash, newSessionToken, normalizeCode, normalizeEmail, verifyPassword } from "@/lib/projects/portal-auth";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";

const RATE_LIMITED = "Trop de tentatives. Patientez quinze minutes avant de réessayer.";

async function passwordLogin(req: NextRequest, rawEmail: string, password: unknown) {
  const email = normalizeEmail(rawEmail);
  if (!isEmail(email) || typeof password !== "string" || !password || password.length > PASSWORD_MAX) {
    return reply({ error: "Saisissez votre email et votre mot de passe." }, 400);
  }
  const sb = publicClient();
  const key = serverRpcKey();
  const ip = ipHash(clientIp(req.headers));
  const who = emailHash(email);
  const c = await sb.rpc("portal_password_challenge", { p_server_key: key, p_email: email, p_email_hash: who, p_ip_hash: ip });
  if (c.error) throw c.error;
  const ch = c.data as { status: "ok" | "unknown" | "rate_limited"; access_id?: string; hash?: string };
  if (ch.status === "rate_limited") return reply({ error: RATE_LIMITED }, 429);
  // même calcul pour un compte inconnu : la réponse ne dit pas si l'email existe
  const ok = await verifyPassword(password, ch.status === "ok" ? ch.hash : null);
  const session = newSessionToken();
  const { data, error } = await sb.rpc("portal_password_login", {
    p_server_key: key, p_access: ch.access_id ?? null, p_password_hash: ch.hash ?? null, p_ok: ok, p_email_hash: who, p_ip_hash: ip,
    p_session_hash: ok ? session.hash : null, p_user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
  });
  if (error) throw error;
  const r = data as { status: "ok" | "invalid"; name?: string };
  if (r.status !== "ok") return reply({ error: "Email ou mot de passe incorrect." }, 401);
  const res = reply({ ok: true, name: r.name });
  res.cookies.set(PORTAL_COOKIE, session.token, cookieOptions(req.nextUrl.protocol === "https:"));
  return res;
}

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const body = (await req.json().catch(() => null)) as { code?: unknown; email?: unknown; password?: unknown } | null;
  if (typeof body?.email === "string") {
    try {
      return await passwordLogin(req, body.email, body.password);
    } catch (e) {
      return portalFailure(e);
    }
  }
  const code = typeof body?.code === "string" ? normalizeCode(body.code) : "";
  if (code.length !== 20) return reply({ error: "Ce code n'est pas valide. Vérifiez-le (20 caractères) ou demandez-en un nouveau." }, 400);
  try {
    const session = newSessionToken();
    const { data, error } = await publicClient().rpc("portal_login", {
      p_server_key: serverRpcKey(), p_code_hash: codeHash(code), p_ip_hash: ipHash(clientIp(req.headers)),
      p_session_hash: session.hash, p_user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    });
    if (error) throw error;
    const r = data as { status: "ok" | "invalid" | "rate_limited"; name?: string };
    if (r.status === "rate_limited") return reply({ error: RATE_LIMITED }, 429);
    if (r.status !== "ok") return reply({ error: "Ce code n'est pas valide, a expiré ou a été désactivé. Demandez un nouveau code à votre interlocuteur." }, 401);
    const res = reply({ ok: true, name: r.name });
    res.cookies.set(PORTAL_COOKIE, session.token, cookieOptions(req.nextUrl.protocol === "https:"));
    return res;
  } catch (e) {
    return portalFailure(e);
  }
}
