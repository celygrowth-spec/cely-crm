// Passage planifié (Vercel Cron, « Authorization: Bearer CRON_SECRET ») ou lancé par le propriétaire :
// rattrape les webhooks manqués, relance les imports dus. Route publique pour le proxy, contrôlée ici.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { getSession } from "@/lib/auth";
import { firefliesApiKey } from "@/lib/fireflies/config";
import { drainImports, rematchPending, syncRecent } from "@/lib/fireflies/worker";

export const maxDuration = 60;

function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret ?? "");
  return !!secret && secret.length >= 16 && given.length === expected.length && timingSafeEqual(given, expected);
}

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** Une session ne suffit pas : ce passage agit avec la clé serveur, il est réservé au propriétaire. */
async function ownerSession() {
  const session = await getSession();
  if (!session) return false;
  const { data } = await session.supabase.rpc("is_app_owner");
  return data === true;
}

async function handle(req: Request) {
  if (!cronAuthorized(req) && !(await ownerSession())) return reply({ error: "Non autorisé" }, 401);
  if (!firefliesApiKey()) return reply({ error: "Fireflies non configuré" }, 503);
  const sb = publicClient();
  let sync: { seen: number; queued: number } | { error: string };
  try {
    sync = await syncRecent(sb);
  } catch {
    sync = { error: "Liste Fireflies indisponible" }; // les tâches déjà enregistrées restent à traiter
  }
  try {
    const drain = await drainImports(sb);
    return reply({ sync, drain, rematched: await rematchPending(sb) });
  } catch {
    return reply({ sync, error: "Traitement interrompu" }, 500);
  }
}

export const GET = handle;
export const POST = handle;
