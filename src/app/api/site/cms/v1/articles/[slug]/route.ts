// Site › un article visible, avec son contenu. Ancien slug d'un article publié : 301 indiqué dans la réponse.
import { notFound, ok, publicEntry, siteRead } from "@/lib/cms/site-api";
import { isValidSlug } from "@/lib/cms/slug";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!isValidSlug(slug)) return notFound();
  const r = await siteRead(req, "entry", { type: "article", slug });
  if ("res" in r) return r.res;
  const d = r.data as { entry?: Parameters<typeof publicEntry>[0]; redirect?: string };
  if (d.redirect) return ok({ redirect: { to: d.redirect, status: 301 } });
  if (!d.entry) return notFound();
  return ok({ article: publicEntry(d.entry, true) });
}
