import type { NextRequest } from "next/server";
import { z } from "zod";
import { portalRpc } from "@/lib/projects/portal";
import { portalFailure, reply, sameOrigin } from "@/lib/projects/portal-http";

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("save"), project: z.uuid(), idea: z.uuid().nullable(), title: z.string().trim().min(1).max(160), description: z.string().max(4000).nullable() }),
  z.object({ op: z.literal("comment"), project: z.uuid(), idea: z.uuid(), body: z.string().trim().min(1).max(1000) }),
]);

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return reply({ error: "Origine refusée" }, 403);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return reply({ error: "Requête invalide" }, 400);
  const b = parsed.data;
  try {
    if (b.op === "save") return reply(await portalRpc("portal_idea_save", { p_project: b.project, p_idea: b.idea, p_title: b.title, p_description: b.description }));
    return reply(await portalRpc("portal_idea_comment", { p_project: b.project, p_idea: b.idea, p_body: b.body }));
  } catch (e) {
    return portalFailure(e);
  }
}
