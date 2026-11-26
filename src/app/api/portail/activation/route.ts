// « Créer mon accès » : le contact choisit son mot de passe. Une seule opération en base (compte activé, ancien
// code désactivé, lien consommé, session ouverte). L'identifiant vient de l'invitation : un email envoyé dans
// la requête est ignoré. Le mot de passe n'est ni journalisé ni conservé : seule son empreinte scrypt part en base.
import type { NextRequest } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { passwordProblem } from "@/lib/projects/password-rules";
import { PORTAL_COOKIE, clientIp, cookieOptions, hashPassword, inviteHash, ipHash, newSessionToken, sessionHash } from "@/lib/projects/portal-auth";
import { INVALID_LINK, portalFailure, readToken, reply, sameOrigin } from "@/lib/projects/portal-http";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const body = (await req.json().catch(() => null)) as { password?: unknown; confirm?: unknown } | null;
  const token = readToken(body);
  if (!token) return reply({ error: INVALID_LINK }, 410);
  const password = typeof body?.password === "string" ? body.password : "";
  const problem = passwordProblem(password);
  if (problem) return reply({ error: problem }, 400);
  if (body?.confirm !== password) return reply({ error: "Les deux mots de passe ne sont pas identiques." }, 400);
  try {
    const session = newSessionToken();
    const { data, error } = await publicClient().rpc("portal_invite_activate", {
      p_server_key: serverRpcKey(), p_token_hash: inviteHash(token), p_password_hash: await hashPassword(password),
      p_ip_hash: ipHash(clientIp(req.headers)), p_session_hash: session.hash, p_user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    });
    if (error) throw error;
    const r = data as { status: "ok" | "invalid" | "rate_limited"; name?: string };
    if (r.status === "rate_limited") return reply({ error: "Trop de tentatives. Patientez quinze minutes avant de réessayer." }, 429);
    if (r.status !== "ok") return reply({ error: INVALID_LINK }, 410);
    // une autre session ouverte dans ce navigateur est fermée : les deux comptes ne se mélangent jamais
    const previous = req.cookies.get(PORTAL_COOKIE)?.value;
    if (previous) await publicClient().rpc("portal_logout", { p_server_key: serverRpcKey(), p_session_hash: sessionHash(previous) }).then(() => undefined, () => undefined);
    const res = reply({ ok: true, name: r.name });
    res.cookies.set(PORTAL_COOKIE, session.token, cookieOptions(req.nextUrl.protocol === "https:"));
    return res;
  } catch (e) {
    return portalFailure(e);
  }
}
