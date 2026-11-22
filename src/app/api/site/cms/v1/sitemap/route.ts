// Site › éléments du sitemap : articles visibles et indexables ; pages réglées « Ne pas indexer » à retirer.
import { ok, siteRead } from "@/lib/cms/site-api";

export async function GET(req: Request) {
  const r = await siteRead(req, "sitemap", { type: "article" });
  if ("res" in r) return r.res;
  const d = r.data as { entries: { type: string; slug: string; updated_at: string; published_at: string; canonical_url?: string }[]; noindex_pages: string[] };
  return ok({
    articles: d.entries.map((e) => ({ slug: e.slug, updated_at: e.updated_at, published_at: e.published_at, canonical: e.canonical_url ?? null })),
    noindex_pages: d.noindex_pages,
  });
}
