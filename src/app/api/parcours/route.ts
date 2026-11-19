// Parcours des clients : l'état qui donne à chaque fiche sa prochaine action principale (fiche, Pipeline, Appels, Agenda).
import { apiRead } from "@/lib/api";
import { listJourney } from "@/lib/journey/service";

export async function GET() {
  return apiRead((sb) => listJourney(sb));
}
