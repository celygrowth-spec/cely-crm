import "server-only";
// Capture du site du prospect rattachée à un dossier de diagnostic. N'interrompt jamais le lancement :
// tout échec est enregistré avec sa raison, que l'application et la session Claude affichent.
import type { SupabaseClient } from "@supabase/supabase-js";
import { companyOf } from "./diagnostic";
import { captureSite, type SiteCaptureResult } from "./site-capture";

/**
 * Une seule capture à la fois par dossier (double clic) ; `onlyIfNone` : seulement si le dossier n'en a aucune.
 * Renvoie le statut enregistré, ou null si aucune capture n'a été lancée.
 */
export async function captureDiagnosticSite(sb: SupabaseClient, id: string, onlyIfNone: boolean, capture: typeof captureSite = captureSite): Promise<SiteCaptureResult["status"] | null> {
  const claim = await sb.rpc("diagnostic_site_capture_claim", { p_id: id, p_only_if_none: onlyIfNone });
  if (claim.error || typeof claim.data !== "string") return null;
  let result: SiteCaptureResult;
  try {
    const company = await companyOf(sb, id);
    const { data } = await sb.from("companies").select("website").eq("id", company).maybeSingle();
    result = await capture((data as { website: string | null } | null)?.website ?? null);
  } catch {
    result = { status: "failed", site_url: null, error: "Capture du site impossible.", pages: [] };
  }
  const save = (r: SiteCaptureResult) =>
    sb.rpc("diagnostic_site_capture_save", { p_capture: claim.data, p_status: r.status, p_site_url: r.site_url, p_error: r.error, p_pages: r.pages });
  const saved = await save(result);
  if (saved.error) {
    await save({ status: "failed", site_url: result.site_url, error: "Capture du site non enregistrée (contenu refusé par la base).", pages: [] });
    return "failed";
  }
  return result.status;
}
