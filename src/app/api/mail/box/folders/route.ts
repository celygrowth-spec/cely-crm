// Boîte Gmail (lot M02) : dossiers et libellés avec leurs compteurs, lus dans l'index.
import { apiRead } from "@/lib/api";
import { listFolders } from "@/lib/mail/box";

export async function GET() {
  return apiRead((sb) => listFolders(sb));
}
