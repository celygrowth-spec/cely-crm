// Début de la connexion Google Calendar (propriétaire uniquement) : état + PKCE en cookies httpOnly.
import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireAppOwner } from "@/lib/auth";
import { appUrl, googleConfig } from "@/lib/appointments/config";
import { authorizationUrl } from "@/lib/appointments/google";
import { appointmentsSecretOrNull } from "@/lib/appointments/config";

export async function GET(req: NextRequest) {
  await requireAppOwner();
  const back = new URL("/rendez-vous/agenda-google", req.nextUrl.origin);
  if (!googleConfig() || !appointmentsSecretOrNull()) {
    back.searchParams.set("erreur", "config");
    return NextResponse.redirect(back);
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = `${appUrl(req.nextUrl.origin)}/api/rendez-vous/google/callback`;
  const res = NextResponse.redirect(authorizationUrl({ redirectUri, state, codeChallenge: challenge }));
  const opts = { httpOnly: true, secure: req.nextUrl.protocol === "https:", sameSite: "lax" as const, path: "/api/rendez-vous/google", maxAge: 600 };
  res.cookies.set("gcal_state", state, opts);
  res.cookies.set("gcal_verifier", verifier, opts);
  return res;
}
