// Site › liste des articles visibles (sans le contenu). ?page=1&par_page=20&categorie=…&tag=…
import { notFound, ok, publicEntry, siteRead } from "@/lib/cms/site-api";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const perPage = Math.min(100, Math.max(1, Number(q.get("par_page")) || 20));
  const page = Math.min(10000, Math.max(1, Number(q.get("page")) || 1));
  const r = await siteRead(req, "list", {
    type: "article", limit: perPage, offset: (page - 1) * perPage,
    category: q.get("categorie")?.slice(0, 100) || undefined, tag: q.get("tag")?.slice(0, 120) || undefined,
  });
  if ("res" in r) return r.res;
  const d = r.data as { total: number; items: Parameters<typeof publicEntry>[0][]; next_change_at: string | null };
  if (!d.items) return notFound();
  return ok({ total: d.total, page, per_page: perPage, next_change_at: d.next_change_at, items: d.items.map((e) => publicEntry(e, false)) });
}
