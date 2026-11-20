// Début de la connexion Google Search Console (propriétaire uniquement) : état + PKCE en cookies httpOnly,
// comme pour Google Agenda. Seule la portée de lecture (webmasters.readonly) est demandée.
import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireAppOwner } from "@/lib/auth";
import { appUrl, appointmentsSecretOrNull } from "@/lib/appointments/config";
import { authorizationUrl, gscConfig } from "@/lib/tracking/seo/gsc";

const COOKIE_PATH = "/api/tracking/seo/google";

export async function GET(req: NextRequest) {
  const { supabase } = await requireAppOwner();
  const back = new URL("/parametres/connecteurs?gerer=search_console", req.nextUrl.origin);
  if (!gscConfig() || !appointmentsSecretOrNull()) {
    back.searchParams.set("seo_erreur", "config");
    return NextResponse.redirect(back);
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${appUrl(req.nextUrl.origin)}${COOKIE_PATH}/callback`;
  // même compte Google que l'agenda du CRM, ouvert d'office : le navigateur peut être connecté à un autre par défaut
  const { data: agenda } = await supabase.from("appt_google_connection").select("google_email").maybeSingle();
  const hint = typeof agenda?.google_email === "string" && /^[^@\s]+@[^@\s]+$/.test(agenda.google_email) ? agenda.google_email : null;
  const res = NextResponse.redirect(authorizationUrl({ redirectUri, state, codeChallenge: challenge, loginHint: hint }));
  const opts = { httpOnly: true, secure: req.nextUrl.protocol === "https:", sameSite: "lax" as const, path: COOKIE_PATH, maxAge: 600 };
  res.cookies.set("gsc_state", state, opts);
  res.cookies.set("gsc_verifier", verifier, opts);
  return res;
}
