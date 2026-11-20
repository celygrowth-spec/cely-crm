// Retour de Google pour Search Console : vérification de l'état, échange du code (PKCE), jeton de rafraîchissement
// chiffré puis enregistré. Le jeton ne revient jamais vers le navigateur et n'est jamais journalisé.
import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { requireAppOwner } from "@/lib/auth";
import { appUrl } from "@/lib/appointments/config";
import { encryptSecret } from "@/lib/appointments/secrets";
import { GSC_SCOPE, exchangeCode, listSites } from "@/lib/tracking/seo/gsc";

const COOKIE_PATH = "/api/tracking/seo/google";

export async function GET(req: NextRequest) {
  const { supabase } = await requireAppOwner();
  const back = new URL("/parametres/connecteurs?gerer=search_console", req.nextUrl.origin);
  const done = (param: "seo" | "seo_erreur", code: string) => {
    back.searchParams.set(param, code);
    const r = NextResponse.redirect(back);
    r.cookies.delete({ name: "gsc_state", path: COOKIE_PATH });
    r.cookies.delete({ name: "gsc_verifier", path: COOKIE_PATH });
    return r;
  };
  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return done("seo_erreur", sp.get("error") === "access_denied" ? "refus" : "google");
  const state = sp.get("state") ?? "";
  const saved = req.cookies.get("gsc_state")?.value ?? "";
  const verifier = req.cookies.get("gsc_verifier")?.value ?? "";
  if (!state || !saved || state.length !== saved.length || !timingSafeEqual(Buffer.from(state), Buffer.from(saved)) || !verifier) return done("seo_erreur", "etat");
  const code = sp.get("code");
  if (!code) return done("seo_erreur", "google");

  try {
    const tokens = await exchangeCode({ code, redirectUri: `${appUrl(req.nextUrl.origin)}${COOKIE_PATH}/callback`, codeVerifier: verifier });
    if (!(tokens.scope ?? "").split(" ").includes(GSC_SCOPE)) return done("seo_erreur", "permissions");
    if (!tokens.refresh_token) return done("seo_erreur", "hors-ligne");
    const sites = await listSites(tokens.access_token);
    if (!sites.length) return done("seo_erreur", "aucun-site");
    const { error } = await supabase.rpc("seo_connect", {
      p_provider: "gsc",
      p_secret_enc: encryptSecret(tokens.refresh_token),
      p_account_label: null,
      // une seule propriété : elle est suivie d'office ; plusieurs : le choix se fait dans le panneau
      p_site_url: sites.length === 1 ? sites[0] : null,
      p_sites: sites,
    });
    if (error) return done("seo_erreur", "enregistrement");
  } catch (e) {
    // jamais l'erreur brute : elle pourrait reprendre une réponse de Google
    console.error("[search-console]", e instanceof Error ? e.name : "erreur");
    return done("seo_erreur", "google");
  }
  return done("seo", "connecte");
}
