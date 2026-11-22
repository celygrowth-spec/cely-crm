// Site › aperçu d'un contenu, quel que soit son statut, avec un jeton valide (24 h au plus). ?jeton=…
import { notFound, ok, publicEntry, siteRead } from "@/lib/cms/site-api";
import { PREVIEW_TOKEN_RE, previewHash } from "@/lib/cms/preview";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("jeton") ?? "";
  if (!PREVIEW_TOKEN_RE.test(token)) return notFound();
  const r = await siteRead(req, "preview", { token_hash: previewHash(token) });
  if ("res" in r) return r.res;
  const d = r.data as { entry?: Parameters<typeof publicEntry>[0]; status?: string; expires_at?: string };
  if (!d.entry) return notFound();
  return ok({ preview: { status: d.status, expires_at: d.expires_at }, article: publicEntry(d.entry, true) });
}
