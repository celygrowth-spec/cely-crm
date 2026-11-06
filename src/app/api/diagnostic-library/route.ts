// Bibliothèque de diagnostic : prompt et fichiers communs à toutes les fiches.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import { confirmLibraryUpload, deleteLibraryFile, getLibrary, libraryFileUrl, setInstructions, startLibraryUpload } from "@/lib/crm/diagnostic";

export const GET = () => apiRead(getLibrary);

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    if (b?.op === "instructions") return setInstructions(sb, b.text);
    if (b?.op === "start") return startLibraryUpload(sb, b);
    if (b?.op === "confirm") return confirmLibraryUpload(sb, b.id);
    if (b?.op === "delete") return deleteLibraryFile(sb, b.id);
    if (b?.op === "url") return libraryFileUrl(sb, b.id, true);
    throw new CrmError("Opération inconnue");
  });
}
