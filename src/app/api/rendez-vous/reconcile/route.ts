// Reprise de la synchronisation Google : la base fait foi. Appelable par le propriétaire (session)
// ou par une tâche planifiée (Vercel Cron) avec « Authorization: Bearer CRON_SECRET ».
import { timingSafeEqual } from "node:crypto";
import { getSession } from "@/lib/auth";
import { json, publicError, requestOrigin } from "@/lib/appointments/http";
import { publicClient, reconcileCalendar } from "@/lib/appointments/server";
import { syncGoogleChanges } from "@/lib/appointments/google-sync";

function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && secret.length >= 16 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

async function handle(req: Request) {
  const session = cronAuthorized(req) ? null : await getSession();
  if (!session && !cronAuthorized(req)) return json({ error: "Non autorisé" }, 401);
  try {
    const sb = session?.supabase ?? publicClient();
    const pushed = await reconcileCalendar(sb, requestOrigin(req), 30);
    // puis lecture des changements faits directement dans Google (signalés, jamais appliqués d'office)
    const pulled = await syncGoogleChanges(sb).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    return json({ pushed, pulled });
  } catch (e) {
    return publicError(e);
  }
}

export const GET = handle;
export const POST = handle;
