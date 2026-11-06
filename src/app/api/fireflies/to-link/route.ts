// File « Appels à rattacher » : propriétaire uniquement, sans résumé ni transcription.
import { apiRead } from "@/lib/api";
import { listCallsToLink } from "@/lib/fireflies/links";

export async function GET() {
  return apiRead(listCallsToLink);
}
