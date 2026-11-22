// CMS : aperçu du Markdown dans l'éditeur, rendu par le même code que pour le site (HTML nettoyé).
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { renderMarkdown } from "@/lib/cms/markdown";

const body = z.object({ md: z.string().max(400_000) });

export async function POST(req: NextRequest) {
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Contenu invalide" }, { status: 400 });
  return apiWrite(req, async () => renderMarkdown(parsed.data.md));
}
