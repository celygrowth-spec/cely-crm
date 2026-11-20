"use server";

// Actions du panneau Search Console / Bing (Paramètres › Connecteurs). Réservées au propriétaire.
// La clé API Bing entre ici, est vérifiée auprès de Bing, chiffrée, puis n'en ressort plus : aucune réponse
// ne contient de clé, de jeton ni de réponse brute d'un fournisseur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ActionResult } from "@/lib/action";
import { requireAppOwner } from "@/lib/auth";
import { appointmentsSecretOrNull } from "@/lib/appointments/config";
import { ensureServerKey } from "@/lib/appointments/owner";
import { encryptSecret } from "@/lib/appointments/secrets";
import type { Connector } from "@/lib/connectors/types";
import { CrmError } from "@/lib/crm/service";
import { BingError, listSites as bingSites } from "./bing";
import { syncProvider } from "./job";
import { SEO_CONNECTOR_KEY, sameSite, type SeoProvider } from "./rules";
import { seoConnector } from "./status";

const PROVIDER = z.enum(["gsc", "bing"]);

async function owned<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<ActionResult<T>> {
  const { supabase } = await requireAppOwner();
  try {
    return { ok: true, data: await fn(supabase) };
  } catch (e) {
    if (e instanceof CrmError) return { ok: false, error: e.message };
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? "Requête invalide." };
    console.error("connecteurs-seo", e instanceof Error ? e.name : "erreur");
    return { ok: false, error: "L'action a échoué. Rechargez la page pour voir l'état, puis réessayez." };
  }
}

/** Ligne à jour du connecteur, pour l'interface (aucun appel au fournisseur). */
async function fresh(sb: SupabaseClient, provider: SeoProvider): Promise<Connector | null> {
  try {
    const { data } = await sb.from("connector_checks").select("checked_at, ok, message").eq("key", SEO_CONNECTOR_KEY[provider]).maybeSingle();
    return await seoConnector(sb, provider, data ? { at: data.checked_at as string, ok: data.ok as boolean, message: (data.message as string) ?? null } : null);
  } catch {
    return null;
  }
}

const bingInput = z.object({
  apiKey: z.string().trim().regex(/^[A-Za-z0-9_-]{16,128}$/, "Cette clé API n'a pas la forme attendue : copiez-la depuis Bing Webmaster Tools (Paramètres › Accès API)."),
  siteUrl: z.string().trim().max(300, "Adresse trop longue.").refine((v) => v === "" || /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(v), "Indiquez l'adresse complète du site (https://…)."),
});

/** Connexion (ou reconnexion) de Bing : la clé est essayée en lecture avant d'être enregistrée. */
export async function connectBingAction(input: { apiKey: string; siteUrl: string }): Promise<ActionResult<{ message: string; connector: Connector | null }>> {
  return owned(async (sb) => {
    const { apiKey, siteUrl } = bingInput.parse({ apiKey: String(input?.apiKey ?? ""), siteUrl: String(input?.siteUrl ?? "") });
    if (!appointmentsSecretOrNull()) throw new CrmError("Secret serveur absent (APPOINTMENTS_SECRET) : la clé ne peut pas être protégée.");
    let sites: string[];
    try {
      sites = await bingSites(apiKey);
    } catch (e) {
      throw new CrmError(e instanceof BingError ? e.message : "Bing n'a pas répondu.");
    }
    if (!sites.length) throw new CrmError("Aucun site vérifié dans ce compte Bing Webmaster Tools.");
    const site = siteUrl ? sites.find((s) => sameSite(s, siteUrl)) : sites.length === 1 ? sites[0] : undefined;
    if (!site) throw new CrmError(`${siteUrl ? "Ce site n'est pas vérifié dans ce compte Bing." : "Indiquez le site à suivre."} Sites disponibles : ${sites.slice(0, 10).join(", ")}.`);
    const { error } = await sb.rpc("seo_connect", { p_provider: "bing", p_secret_enc: encryptSecret(apiKey), p_account_label: null, p_site_url: site, p_sites: sites });
    if (error) throw new CrmError("Enregistrement refusé par la base.");
    return { message: `Bing connecté en lecture pour ${site}.`, connector: await fresh(sb, "bing") };
  });
}

/** Choix de la propriété Search Console (ou du site Bing) parmi ceux du compte connecté. */
export async function setSeoSiteAction(provider: string, siteUrl: string): Promise<ActionResult<{ connector: Connector | null }>> {
  return owned(async (sb) => {
    const p = PROVIDER.parse(provider);
    const { error } = await sb.rpc("seo_set_site", { p_provider: p, p_site_url: z.string().trim().min(1).max(500).parse(siteUrl) });
    if (error) throw new CrmError(error.code === "22023" || error.code === "P0002" ? error.message : "Enregistrement refusé par la base.");
    return { connector: await fresh(sb, p) };
  });
}

/**
 * « Synchroniser maintenant » : un lot borné (quelques secondes). done = false : il reste de l'historique,
 * l'interface relance d'elle-même ; le passage quotidien continuerait de toute façon.
 */
export async function syncSeoAction(provider: string): Promise<ActionResult<{ ok: boolean; done: boolean; message: string; connector: Connector | null }>> {
  return owned(async (sb) => {
    const p = PROVIDER.parse(provider);
    if (!(await ensureServerKey(sb))) throw new CrmError("Secret serveur absent (APPOINTMENTS_SECRET).");
    const out = await syncProvider(sb, p, { deadline: Date.now() + 8000 });
    return { ok: out.status === "ok", done: out.done || out.status !== "ok", message: out.message, connector: await fresh(sb, p) };
  });
}
