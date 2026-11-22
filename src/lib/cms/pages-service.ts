import "server-only";
// Pages SEO côté propriétaire (session, RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { normalizePath, parsePagesImport, type CmsPage } from "./pages";

const text = (max: number) => z.string().max(max, `${max} caractères au plus`).nullish().transform((s) => (s?.trim() ? s.trim() : null));
const url = z.string().max(1000).nullish().transform((s) => (s?.trim() ? s.trim() : null))
  .refine((s) => s === null || /^https?:\/\/\S+$/i.test(s), "Adresse attendue en http(s)://");

export const pageSchema = z.object({
  path: z.string().transform((p, ctx) => {
    const n = normalizePath(p);
    if (!n) ctx.addIssue({ code: "custom", message: "Chemin invalide : il commence par « / », sans paramètres (ex. /offres)" });
    return n ?? "";
  }),
  label: text(200),
  seo_title: text(200),
  seo_description: text(400),
  og_title: text(200),
  og_image_url: url,
  canonical_url: url,
  noindex: z.boolean().nullable(),
});
export type PageInput = z.input<typeof pageSchema>;

function fail(e: { message: string; code?: string }): never {
  if (e.code === "23505") throw new CrmError("Une page existe déjà pour ce chemin.");
  if (e.code === "23514") throw new CrmError("Un champ ne respecte pas le format attendu (chemin, adresse en https…).");
  throw new CrmError(friendlyError(e));
}

export async function listPages(sb: SupabaseClient): Promise<CmsPage[]> {
  const { data, error } = await sb.from("cms_pages").select("*").order("path").limit(1000);
  if (error) fail(error);
  return data as CmsPage[];
}

export async function savePage(sb: SupabaseClient, id: string | null, input: PageInput): Promise<CmsPage> {
  const row = pageSchema.parse(input);
  const res = id
    ? await sb.from("cms_pages").update(row).eq("id", z.uuid().parse(id)).select("*").maybeSingle()
    : await sb.from("cms_pages").insert(row).select("*").single();
  if (res.error) fail(res.error);
  if (!res.data) throw new CrmError("Page introuvable.");
  return res.data as CmsPage;
}

export async function deletePage(sb: SupabaseClient, id: string) {
  const { data, error } = await sb.from("cms_pages").delete().eq("id", z.uuid().parse(id)).select("id");
  if (error) fail(error);
  if (!data?.length) throw new CrmError("Page introuvable.");
}

export async function importPages(sb: SupabaseClient, text: string) {
  const parsed = parsePagesImport(text);
  if (!parsed.pages.length) return { created: 0, updated: 0, unchanged: 0, errors: parsed.errors.length ? parsed.errors : ["Aucune page dans le fichier."] };
  const { data, error } = await sb.rpc("cms_pages_import", { p_pages: parsed.pages });
  if (error) fail(error);
  return { ...(data as { created: number; updated: number; unchanged: number }), errors: parsed.errors };
}
