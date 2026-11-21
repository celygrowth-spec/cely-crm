// Boîte Gmail (lot M03) : tri d'un ou plusieurs fils (archiver, corbeille, lu, suivi, important, spam, libellés,
// déplacer). Réservé au propriétaire ; l'action est faite dans Gmail, puis reflétée dans l'index.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { runBoxAction } from "@/lib/mail/box";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    // l'action utilise le jeton côté serveur : le droit du demandeur est vérifié ici, pas seulement par l'interface
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé");
    return runBoxAction(sb, await req.json());
  });
}
