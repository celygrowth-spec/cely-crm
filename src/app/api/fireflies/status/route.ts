// État de l'import pour l'écran de suivi : propriétaire uniquement, sans aucune transcription.
import { apiRead } from "@/lib/api";
import { firefliesStatus } from "@/lib/fireflies/reads";

export async function GET() {
  return apiRead(firefliesStatus);
}
