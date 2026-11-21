// Boîte Gmail (lot M04) : rédaction. GET : contexte (adresse, signature) ou brouillon à reprendre. POST : enregistrer
// le brouillon dans Gmail (avec de nouveaux fichiers éventuels), l'envoyer ou le supprimer. Réservé au propriétaire.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import type { ComposeContext, ComposeDraft } from "@/lib/mail/box-types";
import { composeContext, discardComposeDraft, loadComposeDraft, saveComposeDraft, sendComposeDraft, type UploadedFile } from "@/lib/mail/box-compose";

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const message = req.nextUrl.searchParams.get("draft_message");
  return apiRead<ComposeContext | ComposeDraft>((sb) => (message ? loadComposeDraft(sb, message) : composeContext(sb)));
}

const op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("send"), draft_id: z.string() }),
  z.object({ op: z.literal("discard"), draft_id: z.string() }),
]);

export async function POST(req: NextRequest) {
  return apiWrite(req, async (sb) => {
    // ces actions utilisent le jeton côté serveur : le droit du demandeur est vérifié ici
    const { data: owner } = await sb.rpc("is_app_owner");
    if (owner !== true) throw new CrmError("Accès refusé");
    if (req.headers.get("content-type")?.includes("multipart/form-data")) {
      const form = await req.formData();
      let data: unknown;
      try {
        data = JSON.parse(String(form.get("data") ?? ""));
      } catch {
        throw new CrmError("Demande invalide.");
      }
      const files: UploadedFile[] = [];
      for (const f of form.getAll("files")) if (f instanceof File) files.push({ name: f.name, type: f.type, data: Buffer.from(await f.arrayBuffer()) });
      return saveComposeDraft(sb, data, files);
    }
    const b = op.parse(await req.json());
    if (b.op === "send") return sendComposeDraft(sb, b.draft_id);
    return discardComposeDraft(sb, b.draft_id);
  });
}
