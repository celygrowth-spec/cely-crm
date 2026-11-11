// Passage planifié unique (C07, Q02, Q03) : agenda Google, rappels, réception Gmail, Fireflies.
// Appelé par Vercel Cron (« Authorization: Bearer CRON_SECRET ») ou un planificateur externe (pg_cron), ou par le
// propriétaire connecté. Route publique pour le proxy : l'autorisation est vérifiée ici. ?taches=rappels,gmail
// limite le passage (planificateur fréquent).
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ensureServerKey } from "@/lib/appointments/owner";
import { requestOrigin } from "@/lib/appointments/http";
import { firefliesApiKey } from "@/lib/fireflies/config";
import { drainImports, rematchPending, syncRecent } from "@/lib/fireflies/worker";
import { agendaJob, gmailJob, remindersJob, runJob, type JobName } from "@/lib/jobs/run";

export const maxDuration = 60;

function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret ?? "");
  return !!secret && secret.length >= 16 && given.length === expected.length && timingSafeEqual(given, expected);
}

async function ownerSession() {
  const session = await getSession();
  if (!session) return false;
  const { data } = await session.supabase.rpc("is_app_owner");
  // lancé par le propriétaire : la clé serveur est enregistrée si besoin (sinon aucune tâche ne peut s'authentifier)
  if (data === true) await ensureServerKey(session.supabase);
  return data === true;
}

const ALL: JobName[] = ["agenda", "rappels", "gmail", "fireflies"];

async function handle(req: Request) {
  if (!cronAuthorized(req) && !(await ownerSession())) return NextResponse.json({ error: "Non autorisé" }, { status: 401 });
  const wanted = new URL(req.url).searchParams.get("taches")?.split(",").filter((j): j is JobName => (ALL as string[]).includes(j)) ?? ALL;
  const origin = requestOrigin(req);
  const results = [];
  for (const job of wanted) {
    if (job === "agenda") results.push(await runJob(job, (sb) => agendaJob(sb, origin)));
    if (job === "rappels") results.push(await runJob(job, (sb) => remindersJob(sb, { origin })));
    if (job === "gmail") results.push(await runJob(job, (sb) => gmailJob(sb)));
    if (job === "fireflies") {
      results.push(await runJob(job, async (sb) => {
        if (!firefliesApiKey()) return { skipped: "Fireflies non configuré" };
        const sync = await syncRecent(sb).catch(() => ({ error: "Liste Fireflies indisponible" }));
        return { sync, drain: await drainImports(sb), rematched: await rematchPending(sb) };
      }));
    }
  }
  return NextResponse.json({ results }, { headers: { "Cache-Control": "private, no-store" } });
}

export const GET = handle;
export const POST = handle;
