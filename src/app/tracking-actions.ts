"use server";

// Actions de l'espace Tracking site : liens du Générateur de liens UTM. La convention de nommage (minuscules,
// sans accents, tirets) est appliquée ici, puis vérifiée une seconde fois en base.
import { z } from "zod";
import { run, type ActionResult } from "@/lib/action";
import { CrmError } from "@/lib/crm/service";
import { buildUtmUrl, canonicalUtmValue, slugUtm } from "@/lib/tracking/utm";

const input = z.object({
  name: z.string().trim().min(1, "Donnez un nom au lien.").max(120),
  path: z.string().trim().min(1).max(300),
  source: z.string().trim().min(1).max(80),
  medium: z.string().trim().min(1).max(80),
  campaign: z.string().trim().min(1).max(80),
  content: z.string().trim().max(80).optional(),
});
export type UtmLinkInput = z.input<typeof input>;

/** Chemin d'une page du site : « /services », ou une adresse complète de celygrowth.com dont on garde le chemin. */
function sitePath(raw: string): string {
  const u = new URL(raw, "https://www.celygrowth.com");
  if (!/(^|\.)celygrowth\.com$/.test(u.hostname)) throw new CrmError("Le lien doit pointer vers une page de celygrowth.com.");
  return `${u.pathname}${u.hash}`.slice(0, 300) || "/";
}

export async function saveUtmLinkAction(raw: UtmLinkInput): Promise<ActionResult<{ id: string; url: string }>> {
  return run(async (sb) => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) throw new CrmError(parsed.error.issues[0]?.message ?? "Lien invalide.");
    const v = parsed.data;
    const utm = { utm_source: canonicalUtmValue(v.source), utm_medium: canonicalUtmValue(v.medium), utm_campaign: slugUtm(v.campaign), utm_content: slugUtm(v.content) || undefined };
    if (!utm.utm_source || !utm.utm_medium || !utm.utm_campaign) throw new CrmError("Source, support et campagne sont obligatoires.");
    const path = sitePath(v.path);
    const url = buildUtmUrl(path, utm);
    const { data, error } = await sb.rpc("site_utm_link_save", { p: { name: v.name, path, ...utm, utm_content: utm.utm_content ?? "", url } });
    if (error) throw new CrmError(error.code === "22023" ? error.message : "Le lien n'a pas pu être enregistré.");
    return { id: (data as { id: string }).id, url };
  });
}

export async function deleteUtmLinkAction(id: string): Promise<ActionResult<null>> {
  return run(async (sb) => {
    if (!z.uuid().safeParse(id).success) throw new CrmError("Lien introuvable.");
    const { error } = await sb.rpc("site_utm_link_delete", { p_id: id });
    if (error) throw new CrmError("Le lien n'a pas pu être supprimé.");
    return null;
  });
}
