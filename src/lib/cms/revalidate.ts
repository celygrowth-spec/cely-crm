import "server-only";
// Rafraîchissement du site : appel POST vers l'adresse du site (CMS_SITE_REVALIDATE_URL), authentifié par un secret
// partagé (CMS_SITE_REVALIDATE_SECRET). Les demandes sont tenues en base (cms_revalidations) : envoi immédiat après
// une action, reprises automatiques par le passage planifié « contenus », échecs visibles dans Aujourd'hui.
import type { SupabaseClient } from "@supabase/supabase-js";

export function revalidateConfig(): { url: string; secret: string } | null {
  const url = process.env.CMS_SITE_REVALIDATE_URL?.trim();
  const secret = process.env.CMS_SITE_REVALIDATE_SECRET?.trim();
  if (!url || !secret || secret.length < 24 || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) return null;
  return { url, secret };
}

export type SiteCall = { ok: true } | { ok: false; error: string };

/** Un appel au site. Le corps décrit ce qui a changé ; le site rafraîchit au moins l'étiquette « cms ». */
export async function callSite(tags: string[], reasons: string[], fetcher: typeof fetch = fetch): Promise<SiteCall> {
  const cfg = revalidateConfig();
  if (!cfg) return { ok: false, error: "Rafraîchissement du site non configuré (CMS_SITE_REVALIDATE_URL et CMS_SITE_REVALIDATE_SECRET)." };
  try {
    const res = await fetcher(cfg.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify({ tags: [...new Set(["cms", ...tags])].slice(0, 100), reasons: reasons.slice(0, 20), sent_at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `Le site a répondu ${res.status}${res.status === 401 ? " (secret refusé)" : ""}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "TimeoutError" ? "Le site n'a pas répondu dans les 8 secondes." : "Site injoignable." };
  }
}

type Claim = { ids: string[]; tags: string[]; reasons: string[] } | null;

/**
 * Envoie les demandes dues. p_server_key : passage planifié ; sans clé : le propriétaire connecté.
 * Renvoie le nombre d'appels réussis et échoués. Ne lève jamais : un échec reste en base et sera repris.
 */
export async function flushRevalidations(sb: SupabaseClient, serverKey: string | null = null, fetcher: typeof fetch = fetch) {
  let sent = 0, failed = 0;
  for (let round = 0; round < 3; round++) {
    const { data, error } = await sb.rpc("cms_revalidation_claim", { p_server_key: serverKey });
    if (error) return { sent, failed, error: "Demandes de rafraîchissement illisibles." };
    const claim = data as Claim;
    if (!claim) break;
    const r = await callSite(claim.tags, claim.reasons, fetcher);
    await sb.rpc("cms_revalidation_report", { p_ids: claim.ids, p_ok: r.ok, p_error: r.ok ? null : r.error, p_server_key: serverKey });
    if (r.ok) sent++;
    else { failed++; break; }
  }
  return { sent, failed };
}
