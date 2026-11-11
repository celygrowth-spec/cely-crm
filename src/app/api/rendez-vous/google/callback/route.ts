// Retour de Google : vérification de l'état, échange du code, jeton chiffré puis enregistré.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireAppOwner } from "@/lib/auth";
import { appUrl } from "@/lib/appointments/config";
import { GOOGLE_SCOPES, exchangeCode, listCalendars } from "@/lib/appointments/google";
import { encryptSecret } from "@/lib/appointments/secrets";

export async function GET(req: NextRequest) {
  const { supabase } = await requireAppOwner();
  const back = new URL("/parametres/connecteurs/google-agenda", req.nextUrl.origin);
  const fail = (code: string) => {
    back.searchParams.set("erreur", code);
    const r = NextResponse.redirect(back);
    r.cookies.delete({ name: "gcal_state", path: "/api/rendez-vous/google" });
    r.cookies.delete({ name: "gcal_verifier", path: "/api/rendez-vous/google" });
    return r;
  };
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return fail(sp.get("error") === "access_denied" ? "refus" : "google");
  const state = sp.get("state") ?? "";
  const saved = req.cookies.get("gcal_state")?.value ?? "";
  const verifier = req.cookies.get("gcal_verifier")?.value ?? "";
  if (!state || !saved || state.length !== saved.length || !timingSafeEqual(Buffer.from(state), Buffer.from(saved)) || !verifier) return fail("etat");
  const code = sp.get("code");
  if (!code) return fail("google");

  try {
    const tokens = await exchangeCode({ code, redirectUri: `${appUrl(req.nextUrl.origin)}/api/rendez-vous/google/callback`, codeVerifier: verifier });
    const granted = new Set(tokens.scope.split(" "));
    if (!GOOGLE_SCOPES.every((s) => granted.has(s))) return fail("permissions");
    if (!tokens.refresh_token) return fail("hors-ligne");
    const calendars = await listCalendars(tokens.access_token);
    const primary = calendars.find((c) => c.primary);
    const { error } = await supabase.rpc("appt_save_google_connection", {
      p_email: primary?.id ?? null,
      p_refresh_token_enc: encryptSecret(tokens.refresh_token),
      p_scopes: tokens.scope,
      p_calendars: calendars,
    });
    if (error) return fail("enregistrement");
  } catch (e) {
    console.error("[google-calendar]", e);
    return fail("google");
  }
  back.searchParams.set("connecte", "1");
  const r = NextResponse.redirect(back);
  r.cookies.delete({ name: "gcal_state", path: "/api/rendez-vous/google" });
  r.cookies.delete({ name: "gcal_verifier", path: "/api/rendez-vous/google" });
  return r;
}
