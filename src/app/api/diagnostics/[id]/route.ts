// Actions du propriétaire sur un dossier : chat associé, réponses, envoi, relance de la tâche Claude.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { saveAnswer, setChatUrl, submitAnswers } from "@/lib/crm/diagnostic";
import { routineConfig, triggerDiagnostic } from "@/lib/crm/diagnostic-trigger";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    if (b?.op === "chat") return setChatUrl(sb, id, String(b.url ?? ""));
    if (b?.op === "answer") return saveAnswer(sb, b.question_id, String(b.answer ?? ""), !!b.dont_know);
    if (b?.op === "submit") {
      const status = await submitAnswers(sb, id);
      return { status, ...(status === "answers_sent" ? await triggerDiagnostic(sb, id, "answers") : { triggered: false }) };
    }
    if (b?.op === "trigger") {
      if (!routineConfig()) throw new CrmError("Déclenchement automatique non configuré : utilisez le lien vers Claude.");
      const outcome = await triggerDiagnostic(sb, id, b.stage === "answers" ? "answers" : "start");
      if (outcome.error) throw new CrmError(outcome.error);
      if (!outcome.triggered) throw new CrmError("Cette étape a déjà été lancée.");
      return outcome;
    }
    throw new CrmError("Opération inconnue");
  });
}
