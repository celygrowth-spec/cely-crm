// Dossiers de proposition ou d'onboarding d'une fiche : lecture et création (un double clic renvoie le même dossier).
// À la création, le CRM dépose ce qu'il sait déjà, puis lance la tâche Claude si elle est configurée.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import type { GeneratorKind } from "@/lib/generators/rules";
import { listDossiers, startDossier } from "@/lib/generators/service";

export const maxDuration = 60;

const kindOf = (v: unknown): GeneratorKind => {
  if (v === "proposal" || v === "onboarding") return v;
  throw new CrmError("Générateur inconnu.");
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => listDossiers(sb, id, kindOf(req.nextUrl.searchParams.get("kind"))));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const b = await req.json().catch(() => null);
  return apiWrite(req, (sb) => startDossier(sb, kindOf(b?.kind), id, b?.project_id ?? null, b?.request_key));
}
