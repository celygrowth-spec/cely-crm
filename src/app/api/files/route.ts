import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { abortUpload, confirmUpload, fileUrl, startUpload } from "@/lib/crm/files";
import { CrmError } from "@/lib/crm/service";

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/**
 * Préparation, confirmation et lien temporaire des fichiers. Ces appels ne sont pas des server actions,
 * que Next exécute une par une : plusieurs transferts bloqueraient toute sauvegarde de la fiche.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get("origin") !== req.nextUrl.origin) return reply({ ok: false, error: "Origine refusée" }, 403);
  const session = await getSession();
  if (!session) return reply({ ok: false, error: "Session expirée. Reconnectez-vous." }, 401);
  const sb = session.supabase;
  try {
    const b = await req.json();
    if (b.op === "start") return reply({ ok: true, data: await startUpload(sb, b) });
    if (b.op === "confirm") return reply({ ok: true, data: await confirmUpload(sb, b.id) });
    if (b.op === "abort") return reply({ ok: true, data: await abortUpload(sb, b.id) ?? null });
    if (b.op === "url") return reply({ ok: true, data: await fileUrl(sb, b.id, !!b.download) });
    return reply({ ok: false, error: "Opération inconnue" }, 400);
  } catch (e) {
    if (e instanceof CrmError) return reply({ ok: false, error: e.message }, 400);
    console.error(e);
    return reply({ ok: false, error: "L'opération a échoué. Réessayez." }, 500);
  }
}
