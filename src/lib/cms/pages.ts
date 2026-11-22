// Pages SEO du site : format d'import JSON (fourni par le site) et règles partagées. Sans dépendance serveur.
import { z } from "zod";

export type CmsPage = {
  id: string;
  path: string;
  label: string | null;
  seo_title: string | null;
  seo_description: string | null;
  og_title: string | null;
  og_image_url: string | null;
  canonical_url: string | null;
  /** null : valeur du site ; true : ne pas indexer ; false : indexer. */
  noindex: boolean | null;
  site_defaults: PageDefaults;
  updated_at: string;
};

export type PageDefaults = Partial<{ title: string | null; description: string | null; og_title: string | null; og_image: string | null; canonical: string | null; noindex: boolean | null }>;

/** Chemin d'une page : commence par « / », sans paramètres ni ancre, sans « / » final (sauf la racine). */
export const PATH_RE = /^(\/|(\/[A-Za-z0-9._~%!$&'()*+,;=:@-]+)+)$/;

export function normalizePath(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return null; }
  }
  p = p.split(/[?#]/)[0];
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return PATH_RE.test(p) && p.length <= 300 ? p : null;
}

const opt = (max: number) => z.string().max(max).nullish().transform((s) => (s?.trim() ? s.trim() : null));
const optUrl = z.string().max(1000).nullish().transform((s) => (s?.trim() ? s.trim() : null))
  .refine((s) => s === null || /^https?:\/\/\S+$/i.test(s), "Adresse attendue en http(s)://");

/** Format d'import « cely-cms-pages », version 1 (voir docs/cms-contrat-site.md). */
export const pagesImportSchema = z.object({
  format: z.literal("cely-cms-pages"),
  version: z.literal(1),
  pages: z.array(z.object({
    path: z.string().max(2000),
    label: opt(200),
    defaults: z.object({
      title: opt(200), description: opt(400), og_title: opt(200), og_image: optUrl, canonical: optUrl, noindex: z.boolean().nullish().transform((v) => v ?? null),
    }).partial().nullish().transform((d) => d ?? {}),
  })).max(500),
});

export type PagesImportResult = { pages: { path: string; label: string | null; defaults: PageDefaults }[]; errors: string[] };

/** Lit et valide un fichier JSON d'import ; chaque page invalide est signalée, les autres sont gardées. */
export function parsePagesImport(text: string): PagesImportResult {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return { pages: [], errors: ["Fichier JSON illisible."] }; }
  const parsed = pagesImportSchema.safeParse(json);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { pages: [], errors: [`Format attendu « cely-cms-pages » version 1 : ${i?.path.join(".") || "racine"} — ${i?.message ?? "invalide"}`] };
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  const pages: PagesImportResult["pages"] = [];
  for (const p of parsed.data.pages) {
    const path = normalizePath(p.path);
    if (!path) { errors.push(`Chemin invalide : « ${p.path} »`); continue; }
    if (seen.has(path)) { errors.push(`Chemin en double : ${path}`); continue; }
    seen.add(path);
    pages.push({ path, label: p.label, defaults: p.defaults });
  }
  return { pages, errors };
}
