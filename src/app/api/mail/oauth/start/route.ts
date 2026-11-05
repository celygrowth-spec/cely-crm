import { createHash, randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireAppOwner } from "@/lib/auth";
import { authorizeUrl } from "@/lib/mail/google";
import { mailConfig } from "@/lib/mail/service";

// Lance la connexion Gmail. Le mot de passe est saisi chez Google, jamais ici.
export async function GET(req: NextRequest) {
  await requireAppOwner();
  const c = mailConfig();
  const origin = req.nextUrl.origin;
  if (!c) return NextResponse.redirect(`${origin}/mail?error=config`);
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const res = NextResponse.redirect(authorizeUrl(c, { redirectUri: `${origin}/api/mail/oauth/callback`, state, challenge, loginHint: req.nextUrl.searchParams.get("hint") ?? undefined }));
  // anti-CSRF : la réponse de Google n'est acceptée que dans le navigateur qui a lancé la connexion
  res.cookies.set("mail_oauth", `${state}.${verifier}`, { httpOnly: true, secure: origin.startsWith("https"), sameSite: "lax", maxAge: 600, path: "/api/mail/oauth" });
  return res;
}
