// Note interne d'un appel, distincte du résumé Fireflies.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { setCallNote } from "@/lib/fireflies/reads";

const schema = z.object({ note: z.string().max(20000, "Note trop longue (20 000 caractères au maximum)") });

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  return apiWrite(req, (sb) => setCallNote(sb, z.uuid().parse(id), schema.parse(body).note));
}
