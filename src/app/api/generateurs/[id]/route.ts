// Actions du propriétaire sur un dossier de générateur : réponses, sources et bibliothèque, génération, relance,
// validation. Le type du dossier est lu en base, jamais dans la requête.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import type { GeneratorKind } from "@/lib/generators/rules";
import * as gen from "@/lib/generators/service";
import { generateProposal, proposalExtras, sendQuote } from "@/lib/proposals/service";
import { markSigned } from "@/lib/proposals/signature";

export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // ?vue=proposition : devis et signature des versions (réservé à l'application)
  return apiRead<unknown>((sb) => (req.nextUrl.searchParams.get("vue") === "proposition" ? proposalExtras(sb, id) : gen.getDossier(sb, id)));
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
      case "generate": {
        const feedback = typeof b.feedback === "string" ? b.feedback : null;
        // proposition : la version et son devis sont créés ensemble, puis slides et devis partent séparément
        return kind === "proposal" ? generateProposal(sb, id, b.request_key, feedback, { origin: req.nextUrl.origin }) : gen.generate(sb, id, kind, b.request_key, feedback);
      }
      case "quote_retry":
        return sendQuote(sb, String(b.quote_id ?? ""), { origin: req.nextUrl.origin });
      case "sign":
        if (kind !== "proposal") throw new CrmError("Seule une proposition se signe.");
        return markSigned(sb, String(b.version_id ?? ""));
      case "sent":
        return { sent_at: await gen.markSent(sb, String(b.version_id ?? ""), typeof b.mail_id === "string" ? b.mail_id : null) };
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
