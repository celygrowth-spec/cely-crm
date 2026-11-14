// Messages : grille des clients, liste des conversations (lue au CRM, d'un client si `company`) et actualisation
// (lue chez lemlist, compte par compte).
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { loadInbox, syncInbox } from "@/lib/lemlist/inbox";

export const maxDuration = 60;

const company = z.uuid().nullish();

export async function GET(req: NextRequest) {
  const c = company.safeParse(req.nextUrl.searchParams.get("company"));
  return apiRead(async (sb) => {
    if (!c.success) throw new CrmError("Client inconnu.");
    return loadInbox(sb, c.data);
  });
}

const body = z.object({ force: z.boolean().optional(), company });

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé.");
    const b = body.parse(await req.json().catch(() => ({})));
    const results = await syncInbox(sb, { force: b.force === true });
    return { results, inbox: await loadInbox(sb, b.company) };
  });
}
