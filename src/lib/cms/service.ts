import "server-only";
// CMS côté propriétaire : lectures et écritures avec la session (RLS et contrôles en base).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { SLUG_MAX, isValidSlug, slugify, uniqueSlug } from "./slug";
import type { CmsDraft, CmsEntry, CmsType } from "./types";

type PgError = { message: string; code?: string; details?: string | null; hint?: string | null };

function fail(error: PgError): never {
  if (error.code === "23505" && /cms_entries_slug_key/.test(error.message)) throw new CrmError("Ce slug est déjà utilisé par un autre contenu.");
  if (error.code === "23505" && /ancienne adresse/.test(error.message)) throw new CrmError(error.message);
  if (error.code === "23514" && /cms_entries_date_check/.test(error.message)) throw new CrmError("Une date de publication est nécessaire.");
  if (error.code === "23514") throw new CrmError("Un champ ne respecte pas le format attendu (longueur, adresse en https…).");
  throw new CrmError(friendlyError(error));
}
function check<T>(res: { data: T; error: PgError | null }): T {
  if (res.error) fail(res.error);
  return res.data;
}

const text = (max: number) => z.string().max(max, `${max} caractères au plus`).transform((s) => s.trim() || null).nullable().optional();
const url = z.string().trim().max(1000).transform((s) => s || null)
  .refine((s) => s === null || /^https?:\/\/[^\s]+$/i.test(s), "Adresse attendue en http(s)://").nullable().optional();
const list = z.array(z.string().max(120)).max(30).transform((a) => [...new Set(a.map((s) => s.trim()).filter(Boolean))]).optional();

export const draftSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire").max(300).optional(),
  slug: z.string().trim().max(SLUG_MAX).refine(isValidSlug, "Slug : minuscules, chiffres et tirets uniquement").optional(),
  excerpt: text(1000),
  body_md: z.string().max(400_000).optional(),
  cover_image_url: url,
  cover_alt: text(300),
  category: text(100),
  tags: list,
  author: text(120),
  focus_keyword: text(120),
  secondary_keywords: list,
  seo_title: text(200),
  seo_description: text(400),
  og_title: text(200),
  og_image_url: url,
  canonical_url: url,
  noindex: z.boolean().optional(),
});
export type DraftInput = z.input<typeof draftSchema>;

export async function listEntries(sb: SupabaseClient, type: CmsType = "article"): Promise<CmsEntry[]> {
  return check(await sb.from("cms_entries").select("*").eq("type", type).order("publish_at", { ascending: false, nullsFirst: true }).order("updated_at", { ascending: false }).limit(2000)) as CmsEntry[];
}

export async function getEntry(sb: SupabaseClient, id: string): Promise<CmsEntry | null> {
  return check(await sb.from("cms_entries").select("*").eq("id", id).maybeSingle()) as CmsEntry | null;
}

export async function getEntryBySlug(sb: SupabaseClient, slug: string, type: CmsType = "article"): Promise<CmsEntry | null> {
  return check(await sb.from("cms_entries").select("*").eq("type", type).eq("slug", slug).maybeSingle()) as CmsEntry | null;
}

/** Slugs occupés : ceux des contenus et les anciennes adresses (redirections) des autres contenus. */
export async function takenSlugs(sb: SupabaseClient, type: CmsType = "article", exceptId?: string): Promise<Set<string>> {
  const [entries, redirects] = await Promise.all([
    sb.from("cms_entries").select("id, slug").eq("type", type),
    sb.from("cms_redirects").select("from_slug, entry_id").eq("type", type),
  ]);
  const out = new Set<string>();
  for (const e of check(entries) as { id: string; slug: string }[]) if (e.id !== exceptId) out.add(e.slug);
  for (const r of check(redirects) as { from_slug: string; entry_id: string }[]) if (r.entry_id !== exceptId) out.add(r.from_slug);
  return out;
}

/** Création (identifiant fourni par l'interface : un double clic retrouve le même contenu). */
export async function createEntry(sb: SupabaseClient, id: string, input: DraftInput & { title: string }, type: CmsType = "article"): Promise<CmsEntry> {
  if (!z.uuid().safeParse(id).success) throw new CrmError("Identifiant invalide");
  const existing = await getEntry(sb, id);
  if (existing) return existing;
  const data = draftSchema.parse(input);
  const slug = data.slug ?? uniqueSlug(slugify(input.title), await takenSlugs(sb, type));
  const row = { ...data, id, type, title: input.title.trim(), slug };
  const res = await sb.from("cms_entries").insert(row).select("*").single();
  if (res.error?.code === "23505" && /cms_entries_pkey/.test(res.error.message)) return (await getEntry(sb, id))!;
  return check(res) as CmsEntry;
}

export async function updateEntry(sb: SupabaseClient, id: string, patch: DraftInput): Promise<CmsEntry> {
  const data = draftSchema.parse(patch);
  const res = check(await sb.from("cms_entries").update(data).eq("id", id).select("*").maybeSingle()) as CmsEntry | null;
  if (!res) throw new CrmError("Contenu introuvable (peut-être à la corbeille).");
  return res;
}

type StatusResult = { already: boolean; entry: CmsEntry };

export async function publishNow(sb: SupabaseClient, id: string): Promise<StatusResult> {
  return check(await sb.rpc("cms_publish_now", { p_id: id })) as StatusResult;
}

export class PastDateError extends CrmError {}

export async function schedule(sb: SupabaseClient, id: string, at: string, confirmNow = false): Promise<StatusResult> {
  if (!Number.isFinite(Date.parse(at))) throw new CrmError("Date de publication invalide.");
  const res = await sb.rpc("cms_schedule", { p_id: id, p_at: at, p_confirm_now: confirmNow });
  if (res.error && res.error.message === "past_date") throw new PastDateError("La date choisie est déjà passée. Publier maintenant ?");
  return check(res) as StatusResult;
}

export async function setStatus(sb: SupabaseClient, id: string, status: "draft" | "unpublished"): Promise<StatusResult> {
  return check(await sb.rpc("cms_set_status", { p_id: id, p_status: status })) as StatusResult;
}

export async function promoteDue(sb: SupabaseClient): Promise<number> {
  return Number(check(await sb.rpc("cms_promote_due")) ?? 0);
}

export type CmsDraftFields = CmsDraft;

// ---------------------------------------------------------------------------
// Import de fichiers Markdown (déjà lus par l'interface, images déjà dans le stockage)
// ---------------------------------------------------------------------------
export type ImportMode = "new" | "replace" | "copy";
export type ImportItem = { id: string; mode: ImportMode; draft: DraftInput & { title: string; slug: string }; status: string; publish_at: string | null };

const statusSchema = z.enum(["draft", "scheduled", "published", "unpublished"]);

/** Contenus existants pour ces slugs (pour demander Remplacer ou Créer une copie). */
export async function existingSlugs(sb: SupabaseClient, slugs: string[], type: CmsType = "article") {
  if (!slugs.length) return [];
  return check(await sb.from("cms_entries").select("id, slug, title").eq("type", type).in("slug", slugs.slice(0, 500))) as { id: string; slug: string; title: string }[];
}

export async function importEntry(sb: SupabaseClient, item: ImportItem, type: CmsType = "article"): Promise<{ entry: CmsEntry; mode: ImportMode }> {
  if (!z.uuid().safeParse(item.id).success) throw new CrmError("Identifiant invalide");
  const data = draftSchema.parse(item.draft);
  let status = statusSchema.parse(item.status);
  let publishAt = item.publish_at && Number.isFinite(Date.parse(item.publish_at)) ? new Date(item.publish_at).toISOString() : null;
  if (status !== "draft" && status !== "unpublished" && !publishAt) status = "draft";

  if (item.mode === "replace") {
    const target = await getEntryBySlug(sb, data.slug!, type);
    if (!target) throw new CrmError(`Aucun article « ${data.slug} » à remplacer.`);
    const res = check(await sb.from("cms_entries").update({ ...data, status, publish_at: publishAt }).eq("id", target.id).select("*").single()) as CmsEntry;
    return { entry: res, mode: "replace" };
  }
  const already = await getEntry(sb, item.id);
  if (already) return { entry: already, mode: item.mode }; // réessai : rien n'est créé deux fois
  let slug = data.slug!;
  if (item.mode === "copy") {
    slug = uniqueSlug(slug, await takenSlugs(sb, type));
    status = "draft"; // une copie n'est jamais publiée d'office (contenu en double)
    publishAt = null;
  }
  const res = await sb.from("cms_entries").insert({ ...data, id: item.id, type, slug, status, publish_at: publishAt }).select("*").single();
  if (res.error?.code === "23505" && /cms_entries_slug_key/.test(res.error.message)) throw new CrmError(`Le slug « ${slug} » existe déjà : choisissez Remplacer ou Créer une copie.`);
  return { entry: check(res) as CmsEntry, mode: item.mode };
}
