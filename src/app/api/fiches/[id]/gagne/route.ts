// « Gagné » : la vente et son projet sont enregistrés tout de suite ; la préparation suit, après la réponse.
// Un double clic ou une nouvelle tentative retrouvent la même vente et le même projet.
import { after, type NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { activeClosing, prepare, requestAnalysis, winDeal } from "@/lib/projects/onboarding";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => activeClosing(sb, id));
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiWrite(req, async (sb) => {
    const r = await winDeal(sb, id);
    after(async () => {
      // un échec est enregistré sur le projet (relançable depuis le projet) ; la vente reste acquise
      try {
        await prepare(sb, r.project_id);
        await requestAnalysis(sb, r.project_id);
      } catch {
        // déjà enregistré par prepare
      }
    });
    return r;
  });
}
