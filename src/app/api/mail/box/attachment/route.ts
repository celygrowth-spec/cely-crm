// Boîte Gmail (lot M02) : téléchargement d'une pièce jointe, lue dans Gmail à la demande.
// Toujours servie comme un fichier à enregistrer, jamais affichée dans la page : une pièce jointe HTML ne peut
// pas s'exécuter sur le domaine du CRM.
import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";
import { readAttachment } from "@/lib/mail/box";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Session expirée" }, { status: 401 });
  const { data: owner } = await session.supabase.rpc("is_app_owner");
  if (owner !== true) return NextResponse.json({ error: "Accès refusé" }, { status: 403 });
  const p = req.nextUrl.searchParams;
  try {
    const file = await readAttachment(session.supabase, p.get("thread") ?? "", p.get("message") ?? "", Number(p.get("n") ?? "-1"));
    const ascii = file.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    return new NextResponse(new Uint8Array(file.data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof CrmError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error(e instanceof Error ? e.name : "Erreur inconnue"); // jamais le contenu
    return NextResponse.json({ error: "Téléchargement impossible" }, { status: 500 });
  }
}
