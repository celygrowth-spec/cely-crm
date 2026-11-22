// CMS : export Markdown. ?id=<article> : un fichier .md ; sans id : archive .zip de tous les articles.
// Lecture avec la session du propriétaire (RLS) ; réponse jamais mise en cache.
import { zipSync, strToU8 } from "fflate";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { exportFileName, toMarkdownFile } from "@/lib/cms/frontmatter";
import { getEntry, listEntries } from "@/lib/cms/service";

const headers = (type: string, name: string) => ({
  "Content-Type": type,
  "Content-Disposition": `attachment; filename="${name}"`,
  "Cache-Control": "private, no-store",
});

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Session expirée" }, { status: 401 });
  const { data: owner } = await session.supabase.rpc("is_app_owner");
  if (owner !== true) return NextResponse.json({ error: "Accès refusé" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Identifiant invalide" }, { status: 400 });
    const e = await getEntry(session.supabase, id);
    if (!e) return NextResponse.json({ error: "Article introuvable" }, { status: 404 });
    return new Response(toMarkdownFile(e), { headers: headers("text/markdown; charset=utf-8", exportFileName(e.slug)) });
  }
  const all = await listEntries(session.supabase);
  const files: Record<string, Uint8Array> = {};
  for (const e of all) files[`articles/${exportFileName(e.slug)}`] = strToU8(toMarkdownFile(e));
  const zip = zipSync(files, { level: 6 });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(zip as unknown as BodyInit, { headers: headers("application/zip", `articles-${day}.zip`) });
}
