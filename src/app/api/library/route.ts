// Bibliothèque générale : dossiers, fichiers et prompts. Route plutôt que server actions : un dépôt multiple
// enchaîne de nombreux appels qui ne doivent pas attendre les uns après les autres.
import type { NextRequest } from "next/server";
import { apiRead, apiWrite } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";
import * as lib from "@/lib/crm/library";

export const GET = (req: NextRequest) => {
  const prompt = req.nextUrl.searchParams.get("prompt");
  return apiRead<unknown>((sb) => (prompt ? lib.getPrompt(sb, prompt) : lib.listLibrary(sb)));
};

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  return apiWrite(req, async (sb) => {
    switch (b?.op) {
      case "folder_create": return lib.createFolder(sb, b.parent ?? null, b.name);
      case "folder_rename": return lib.renameFolder(sb, b.id, b.name);
      case "folder_move": return lib.moveFolder(sb, b.id, b.parent ?? null);
      case "folder_delete": return lib.deleteFolder(sb, b.id, typeof b.confirmed === "number" ? b.confirmed : null);
      case "file_start": return lib.startFile(sb, { folder: b.folder ?? null, name: b.name, size: b.size });
      case "file_confirm": return lib.confirmFile(sb, b.id);
      case "file_url": return lib.fileUrl(sb, b.id, b.download === true);
      case "prompt_create": return lib.createPrompt(sb, b.folder, b.title, b.content ?? "");
      case "prompt_update": return lib.updatePrompt(sb, b.id, b.title, b.content ?? "");
      case "item_rename": return lib.renameItem(sb, b.id, b.name);
      case "item_move": return lib.moveItem(sb, b.id, b.folder);
      case "item_delete": return lib.deleteItem(sb, b.id);
      default: throw new CrmError("Opération inconnue");
    }
  });
}
