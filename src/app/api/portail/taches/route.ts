// Écritures du portail sur les tâches : statut (et explication d'un blocage) ou commentaire.
// Toutes les règles (tâche attribuée, projet ouvert, visibilité) sont vérifiées en base.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { portalRpc } from "@/lib/projects/portal";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status"), task: z.uuid(), status: z.enum(["a_faire", "en_cours", "bloque", "termine"]), blocked_reason: z.string().max(1000).nullable().optional() }),
  z.object({ op: z.literal("comment"), task: z.uuid(), body: z.string().trim().min(1).max(1000) }),
]);

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Requête invalide" }, 400);
  const b = parsed.data;
  try {
    if (b.op === "status") return reply(await portalRpc("portal_task_update", { p_task: b.task, p_status: b.status, p_blocked_reason: b.blocked_reason ?? null }));
    return reply(await portalRpc("portal_task_comment", { p_task: b.task, p_body: b.body }));
  } catch (e) {
    return portalFailure(e);
  }
}
