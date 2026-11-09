import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { duplicateTemplate, listTemplates, saveTemplate, setTemplateArchived } from "@/lib/mail/templates";

export async function GET(req: NextRequest) {
  return apiRead((sb) => listTemplates(sb, req.nextUrl.searchParams.get("archives") === "1"));
}

const id = z.uuid();
const body = z.discriminatedUnion("op", [
  z.object({ op: z.literal("save"), id: id.nullable(), name: z.string(), category: z.string().nullish(), subject: z.string(), html: z.string() }),
  z.object({ op: z.literal("duplicate"), id }),
  z.object({ op: z.literal("archive"), id, archived: z.boolean() }),
]);

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    const b = body.parse(await req.json());
    if (b.op === "save") return saveTemplate(sb, b.id, b);
    if (b.op === "duplicate") return duplicateTemplate(sb, b.id);
    return setTemplateArchived(sb, b.id, b.archived);
  });
}
