// Actions du propriétaire sur un dossier : chat associé, réponses, envoi.
import type { NextRequest } from "next/server";
import { apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { saveAnswer, setChatUrl, submitAnswers } from "@/lib/crm/diagnostic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    if (b?.op === "chat") return setChatUrl(sb, id, String(b.url ?? ""));
    if (b?.op === "answer") return saveAnswer(sb, b.question_id, String(b.answer ?? ""), !!b.dont_know);
    if (b?.op === "submit") return submitAnswers(sb, id);
    throw new CrmError("Opération inconnue");
  });
}
