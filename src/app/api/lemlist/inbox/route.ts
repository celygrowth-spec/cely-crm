// Messages : liste des conversations des comptes lemlist (lue au CRM) et actualisation (lue chez lemlist, compte par compte).
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { loadInbox, syncInbox } from "@/lib/lemlist/inbox";

export const maxDuration = 60;

export async function GET() {
  return apiRead((sb) => loadInbox(sb));
}

const body = z.object({ force: z.boolean().optional() });

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé.");
    const b = body.parse(await req.json().catch(() => ({})));
    const results = await syncInbox(sb, { force: b.force === true });
    return { results, inbox: await loadInbox(sb) };
  });
}
