// Site › réglages SEO des pages. Un champ absent : le site garde la valeur de son code.
import { ok, siteRead } from "@/lib/cms/site-api";

type Page = { path: string; seo_title?: string; seo_description?: string; og_title?: string; og_image_url?: string; canonical_url?: string; noindex?: boolean };

export async function GET(req: Request) {
  const r = await siteRead(req, "pages");
  if ("res" in r) return r.res;
  const d = r.data as { pages: Page[] };
  return ok({
    pages: d.pages.map((p) => Object.fromEntries(Object.entries({
      path: p.path, title: p.seo_title, description: p.seo_description, og_title: p.og_title, og_image: p.og_image_url, canonical: p.canonical_url, noindex: p.noindex,
    }).filter(([, v]) => v !== undefined && v !== null))),
  });
}
