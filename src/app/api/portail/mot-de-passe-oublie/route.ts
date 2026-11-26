// « Mot de passe oublié » : la demande est notée pour un email autorisé ; l'interlocuteur Cely Growth envoie le
// lien depuis le CRM. Réponse identique que l'email existe ou non.
import type { NextRequest } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { isEmail } from "@/lib/mail/types";
import { clientIp, ipHash, normalizeEmail } from "@/lib/projects/portal-auth";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";

const DONE = "Si cette adresse correspond à un accès, votre demande a été transmise à votre interlocuteur Cely Growth. Il vous enverra par mail un lien pour choisir un nouveau mot de passe.";

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const body = (await req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? normalizeEmail(body.email) : "";
  if (!isEmail(email)) return reply({ error: "Saisissez une adresse email valide." }, 400);
  try {
    const { data, error } = await publicClient().rpc("portal_reset_request", { p_server_key: serverRpcKey(), p_email: email, p_ip_hash: ipHash(clientIp(req.headers)) });
    if (error) throw error;
    if ((data as { status: string }).status === "rate_limited") return reply({ error: "Trop de demandes. Patientez une heure avant de réessayer." }, 429);
    return reply({ ok: true, message: DONE });
  } catch (e) {
    return portalFailure(e);
  }
}
