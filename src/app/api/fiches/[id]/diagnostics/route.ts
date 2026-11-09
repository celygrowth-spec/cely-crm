// Dossiers de diagnostic d'une fiche : lecture et création (un double clic renvoie le même dossier).
// Si la tâche Claude est configurée, la création la déclenche aussitôt.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { listDiagnostics, startDiagnostic } from "@/lib/crm/diagnostic";
import { triggerDiagnostic } from "@/lib/crm/diagnostic-trigger";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => listDiagnostics(sb, id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    const dossier = await startDiagnostic(sb, id, body?.request_key);
    return { id: dossier, ...(await triggerDiagnostic(sb, dossier, "start")) };
  });
}
