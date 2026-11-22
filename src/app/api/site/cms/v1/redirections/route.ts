// Site › redirections 301 des anciens slugs vers le slug actuel (articles visibles seulement).
import { ok, siteRead } from "@/lib/cms/site-api";

export async function GET(req: Request) {
  const r = await siteRead(req, "redirects", { type: "article" });
  if ("res" in r) return r.res;
  const d = r.data as { redirects: { type: string; from: string; to: string }[] };
  return ok({ redirects: d.redirects.map((x) => ({ type: x.type, from: x.from, to: x.to, status: 301 })) });
}
