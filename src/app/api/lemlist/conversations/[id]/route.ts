// Fil d'une conversation : le serveur retrouve lui-même le compte lemlist de la conversation à partir de son
// identifiant CRM ; aucun identifiant de compte n'est accepté du navigateur. Rien du fil n'est enregistré.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { openThread } from "@/lib/lemlist/inbox";

export const maxDuration = 30;
type Ctx = { params: Promise<{ id: string }> };

const body = z.object({ op: z.literal("open") });

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return apiWrite(req, async (sb) => {
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé.");
    body.parse(await req.json());
    return openThread(sb, id);
  });
}
