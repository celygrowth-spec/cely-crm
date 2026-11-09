import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { discardMail, reopenMail, resolveUncertain, saveDraft, sendStored, type DraftInput } from "@/lib/mail/service";

export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return apiWrite(req, async (sb) => saveDraft(sb, id, (await req.json()) as DraftInput));
}

const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("send"), allow_dnc: z.boolean().optional() }),
  z.object({ op: z.literal("reopen") }),
  z.object({ op: z.literal("discard") }),
  z.object({ op: z.literal("resolve"), sent: z.boolean() }),
]);

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return apiWrite(req, async (sb) => {
    const b = body.parse(await req.json());
    if (b.op === "send") return sendStored(sb, id, { allowDoNotContact: b.allow_dnc === true });
    if (b.op === "reopen") return reopenMail(sb, id);
    if (b.op === "discard") return discardMail(sb, id);
    return resolveUncertain(sb, id, b.sent);
  });
}
