// Relance d'un import en échec : remis en file, traité ensuite par /api/fireflies/process ou le passage quotidien.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { retryJob } from "@/lib/fireflies/reads";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return apiWrite(req, (sb) => retryJob(sb, z.uuid().parse(id)));
}
