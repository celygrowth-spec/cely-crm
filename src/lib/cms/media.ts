import "server-only";
// Images du CMS : bucket public « cms-media » (affichées par le site), envoi direct du navigateur par lien signé,
// suppression avec avertissement si l'image est utilisée (couverture, partage, corps d'un article, page SEO).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";

export const MEDIA_BUCKET = "cms-media";
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif" };

export type CmsMedia = { id: string; path: string; filename: string; mime: string; size: number; created_at: string; url: string };
export type MediaUsage = { kind: "article" | "page"; id: string; label: string; where: string[] };

const publicUrl = (sb: SupabaseClient, path: string) => sb.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;

export async function startMediaUpload(sb: SupabaseClient, input: { name: string; size: number }) {
  const ext = input.name.split(".").pop()?.toLowerCase() ?? "";
  const mime = TYPES[ext];
  if (!mime) throw new CrmError("Format non accepté : PNG, JPEG, WebP, GIF ou AVIF (SVG refusé).");
  if (input.size <= 0) throw new CrmError("Ce fichier est vide.");
  if (input.size > MEDIA_MAX_BYTES) throw new CrmError("Image trop lourde (10 Mo au plus).");
  const id = crypto.randomUUID();
  const path = `${id}.${ext}`;
  const ins = await sb.from("cms_media").insert({ id, path, filename: input.name.slice(0, 200), mime, size: input.size });
  if (ins.error) throw new CrmError(friendlyError(ins.error));
  const { data, error } = await sb.storage.from(MEDIA_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    await sb.from("cms_media").delete().eq("id", id);
    throw new CrmError("Préparation de l'envoi impossible. Réessayez.");
  }
  return { id, signedUrl: data.signedUrl, mime };
}

export async function confirmMediaUpload(sb: SupabaseClient, id: string): Promise<CmsMedia> {
  const row = (await sb.from("cms_media").select("*").eq("id", z.uuid().parse(id)).maybeSingle()).data as Omit<CmsMedia, "url"> | null;
  if (!row) throw new CrmError("Image introuvable.");
  const probe = await sb.storage.from(MEDIA_BUCKET).createSignedUrl(row.path, 10);
  if (probe.error) throw new CrmError("L'image n'a pas été reçue par le stockage.");
  const upd = await sb.from("cms_media").update({ status: "ready" }).eq("id", id).select("*").single();
  if (upd.error) throw new CrmError(friendlyError(upd.error));
  return { ...(upd.data as Omit<CmsMedia, "url">), url: publicUrl(sb, row.path) };
}

export async function listMedia(sb: SupabaseClient): Promise<CmsMedia[]> {
  const { data, error } = await sb.from("cms_media").select("*").eq("status", "ready").order("created_at", { ascending: false }).limit(1000);
  if (error) throw new CrmError(friendlyError(error));
  return (data as Omit<CmsMedia, "url">[]).map((m) => ({ ...m, url: publicUrl(sb, m.path) }));
}

/** Où une image est utilisée (articles, y compris à la corbeille ? non : la corbeille les cache). */
export async function mediaUsage(sb: SupabaseClient, path: string): Promise<MediaUsage[]> {
  const like = `%${path.replace(/[%_\\]/g, "\\$&")}%`;
  const [entries, pages] = await Promise.all([
    sb.from("cms_entries").select("id, title, cover_image_url, og_image_url, body_md")
      .or(`cover_image_url.ilike.${like},og_image_url.ilike.${like},body_md.ilike.${like}`).limit(200),
    sb.from("cms_pages").select("id, path, og_image_url").ilike("og_image_url", like).limit(200),
  ]);
  const out: MediaUsage[] = [];
  for (const e of (entries.data ?? []) as { id: string; title: string; cover_image_url: string | null; og_image_url: string | null; body_md: string }[]) {
    const where = [e.cover_image_url?.includes(path) && "couverture", e.og_image_url?.includes(path) && "partage", e.body_md.includes(path) && "contenu"].filter(Boolean) as string[];
    out.push({ kind: "article", id: e.id, label: e.title, where });
  }
  // la table des pages n'existe qu'à partir du lot 3 : une erreur ici n'empêche pas l'avertissement des articles
  for (const p of (pages.error ? [] : pages.data ?? []) as { id: string; path: string }[]) out.push({ kind: "page", id: p.id, label: p.path, where: ["partage"] });
  if (entries.error) throw new CrmError(friendlyError(entries.error));
  return out;
}

/** Supprime une image. Utilisée quelque part : refus, sauf confirmation explicite après avertissement. */
export async function deleteMedia(sb: SupabaseClient, id: string, confirmed: boolean): Promise<{ deleted: boolean; usage: MediaUsage[] }> {
  const row = (await sb.from("cms_media").select("path").eq("id", z.uuid().parse(id)).maybeSingle()).data as { path: string } | null;
  if (!row) throw new CrmError("Image introuvable.");
  const usage = await mediaUsage(sb, row.path);
  if (usage.length && !confirmed) return { deleted: false, usage };
  const rm = await sb.storage.from(MEDIA_BUCKET).remove([row.path]);
  if (rm.error) throw new CrmError("L'image n'a pas pu être retirée du stockage. Réessayez.");
  const del = await sb.from("cms_media").delete().eq("id", id);
  if (del.error) throw new CrmError(friendlyError(del.error));
  return { deleted: true, usage };
}
