// Fil d'une conversation : le serveur retrouve lui-même le compte lemlist de la conversation à partir de son
// identifiant CRM ; aucun identifiant de compte n'est accepté du navigateur. Rien du fil n'est enregistré.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { openThread, sendReply } from "@/lib/lemlist/inbox";

export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

const REFUSED = "Requête refusée : champ inattendu.";
// objets stricts : un champ en trop (identifiant de compte, clé, expéditeur…) fait refuser la requête
const body = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("open") }, { error: REFUSED }),
  z.strictObject({ op: z.literal("reply"), channel: z.string(), text: z.string(), key: z.string() }, { error: REFUSED }),
]);

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  return apiWrite(req, async (sb) => {
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé.");
    const b = body.parse(await req.json());
    if (b.op === "reply") return sendReply(sb, id, b);
    return openThread(sb, id);
  });
}
