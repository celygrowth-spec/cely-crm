// Actions du propriétaire sur un dossier de générateur : réponses, sources et bibliothèque, génération, relance,
// validation. Le type du dossier est lu en base, jamais dans la requête.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import type { GeneratorKind } from "@/lib/generators/rules";
import * as gen from "@/lib/generators/service";

export const maxDuration = 60;

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => gen.getDossier(sb, id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    const { data } = await sb.from("generator_dossiers").select("kind").eq("id", id).maybeSingle();
    const kind = data?.kind as GeneratorKind | undefined;
    if (!kind) throw new CrmError("Dossier introuvable.");
    switch (b?.op) {
      case "answer":
        return gen.saveAnswer(sb, id, kind, String(b.key ?? ""), b.value);
      case "selection":
        return gen.setSelection(sb, id, Array.isArray(b.excluded) ? b.excluded : [], Array.isArray(b.library) ? b.library : null);
      case "generate":
        return gen.generate(sb, id, kind, b.request_key, typeof b.feedback === "string" ? b.feedback : null);
      case "retry":
        return gen.retrySlides(sb, kind, String(b.version_id ?? ""));
      case "trigger": {
        if (!gen.generatorRoutine(kind)) throw new CrmError("Déclenchement automatique non configuré : utilisez le lien vers Claude.");
        const out = await gen.trigger(sb, id, kind, "preremplissage", "prefill");
        if (out.error) throw new CrmError(out.error);
        if (!out.triggered) throw new CrmError("Cette étape a déjà été lancée.");
        return out;
      }
      case "validate":
        return { validated_at: await gen.validateVersion(sb, String(b.version_id ?? "")) };
    }
    throw new CrmError("Opération inconnue");
  });
}
