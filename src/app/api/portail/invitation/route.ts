// Ouverture d'un lien d'invitation : renvoie l'email porté par l'invitation (lu en base, jamais dans l'URL).
// Le jeton arrive dans le corps de la requête ; il n'est ni journalisé ni conservé.
import type { NextRequest } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { clientIp, inviteHash, ipHash } from "@/lib/projects/portal-auth";
import { INVALID_LINK, portalFailure, readToken, reply, sameOrigin } from "@/lib/projects/portal-http";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const token = readToken(await req.json().catch(() => null));
  if (!token) return reply({ error: INVALID_LINK }, 410);
  try {
    const { data, error } = await publicClient().rpc("portal_invite_check", {
      p_server_key: serverRpcKey(), p_token_hash: inviteHash(token), p_ip_hash: ipHash(clientIp(req.headers)),
    });
    if (error) throw error;
    const r = data as { status: "ok" | "invalid" | "rate_limited"; email?: string; kind?: "invitation" | "reset"; first_name?: string | null };
    if (r.status === "rate_limited") return reply({ error: "Trop de tentatives. Patientez quinze minutes avant de réessayer." }, 429);
    if (r.status !== "ok") return reply({ error: INVALID_LINK }, 410);
    return reply({ ok: true, email: r.email, kind: r.kind, firstName: r.first_name ?? null });
  } catch (e) {
    return portalFailure(e);
  }
}
