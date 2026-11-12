"use server";

// Corbeille : actions serveur (propriétaire connecté). Les droits et la cohérence sont imposés en base.
import { run } from "@/lib/action";
import { trashPreview, trashPurge, trashPut, trashRestore } from "@/lib/trash/service";

export async function trashPreviewAction(kind: string, id: string) {
  return run((sb) => trashPreview(sb, kind, id));
}

export async function trashPutAction(kind: string, id: string) {
  return run((sb) => trashPut(sb, kind, id));
}

export async function trashRestoreAction(trashId: string, withParent = false) {
  return run((sb) => trashRestore(sb, trashId, withParent));
}

export async function trashPurgeAction(trashId: string) {
  return run((sb) => trashPurge(sb, trashId));
}
