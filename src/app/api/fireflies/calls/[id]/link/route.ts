// Rattacher, déplacer, ignorer un appel ou annuler ce choix : propriétaire uniquement.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { applyLinkAction, callIdSchema, linkActionSchema } from "@/lib/fireflies/links";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => applyLinkAction(sb, callIdSchema.parse(id), linkActionSchema.parse(body)));
}
