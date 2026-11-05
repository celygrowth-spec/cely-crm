// Reprise de la synchronisation Google : la base fait foi. Appelable par le propriétaire (session)
// ou par une tâche planifiée (Vercel Cron) avec « Authorization: Bearer CRON_SECRET ».
import { timingSafeEqual } from "node:crypto";
import { getSession } from "@/lib/auth";
import { json, publicError, requestOrigin } from "@/lib/appointments/http";
import { publicClient, reconcileCalendar } from "@/lib/appointments/server";

function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return !!secret && secret.length >= 16 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

async function handle(req: Request) {
  const session = cronAuthorized(req) ? null : await getSession();
  if (!session && !cronAuthorized(req)) return json({ error: "Non autorisé" }, 401);
  try {
    return json(await reconcileCalendar(session?.supabase ?? publicClient(), requestOrigin(req), 30));
  } catch (e) {
    return publicError(e);
  }
}

export const GET = handle;
export const POST = handle;
