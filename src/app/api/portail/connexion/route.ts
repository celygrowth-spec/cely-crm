// Connexion au portail client par code d'accès. Le code ne transite que dans le corps de la requête,
// jamais dans l'URL ; il n'est ni journalisé ni conservé.
import type { NextRequest } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { PORTAL_COOKIE, clientIp, codeHash, cookieOptions, ipHash, newSessionToken, normalizeCode } from "@/lib/projects/portal-auth";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
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
    if (r.status === "rate_limited") return reply({ error: "Trop de tentatives. Patientez quinze minutes avant de réessayer." }, 429);
    if (r.status !== "ok") return reply({ error: "Ce code n'est pas valide, a expiré ou a été désactivé. Demandez un nouveau code à votre interlocuteur." }, 401);
    const res = reply({ ok: true, name: r.name });
    res.cookies.set(PORTAL_COOKIE, session.token, cookieOptions(req.nextUrl.protocol === "https:"));
    return res;
  } catch (e) {
    return portalFailure(e);
  }
}
