// Corbeille : opérations partagées par l'interface et le connecteur Claude. Toute la logique (éléments liés,
// tout-ou-rien, invisibilité, purge) est en base ; ici : validation et retrait des fichiers du stockage.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { TRASH_KINDS, daysLeft, type RestoreResult, type TrashItem, type TrashKind, type TrashPreview } from "./types";

const uuid = z.uuid("Identifiant invalide");
const kindSchema = z.enum(TRASH_KINDS, "Type d'élément inconnu");
const BUCKET = "company-files";

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}

function parse(kind: string, id: string): [TrashKind, string] {
  const k = kindSchema.safeParse(kind);
  if (!k.success) throw new CrmError("Type d'élément inconnu.");
  const i = uuid.safeParse(id);
  if (!i.success) throw new CrmError("Identifiant invalide.");
  return [k.data, i.data];
}

/** Ce qui partira avec l'élément (fenêtre de confirmation). */
export async function trashPreview(sb: SupabaseClient, kind: string, id: string): Promise<TrashPreview> {
  const [k, i] = parse(kind, id);
  const r = await rpc<TrashPreview>(sb, "trash_preview", { p_kind: k, p_id: i });
  return { ...r, warnings: r.warnings ?? [], summary: r.summary ?? {} };
}

/** Met l'élément et ses liés à la corbeille, en une seule opération. Un double clic renvoie le même élément. */
export async function trashPut(sb: SupabaseClient, kind: string, id: string) {
  const [k, i] = parse(kind, id);
  return rpc<{ trash_id: string; already: boolean; label: string; kind: TrashKind; summary?: Record<string, number> }>(sb, "trash_put", { p_kind: k, p_id: i });
}

export async function trashRestore(sb: SupabaseClient, trashId: string, withParent = false): Promise<RestoreResult> {
  return rpc<RestoreResult>(sb, "trash_restore", { p_trash: uuid.parse(trashId), p_with_parent: withParent });
}

export async function listTrash(sb: SupabaseClient): Promise<TrashItem[]> {
  const { data, error } = await sb.from("trash_items")
    .select("id, kind, label, context, summary, actor, deleted_at, purge_after, purge_error")
    .order("deleted_at", { ascending: false }).limit(500);
  if (error) throw new CrmError(friendlyError(error));
  const now = Date.now();
  return ((data ?? []) as Omit<TrashItem, "days_left">[]).map((i) => ({ ...i, days_left: daysLeft(i.purge_after, now) }));
}

/**
 * Retire du stockage les fichiers en attente (session du propriétaire). Un fichier déjà absent compte comme
 * retiré. Renvoie le nombre de fichiers encore en attente (réessayés par la tâche planifiée).
 */
export async function removeQueuedFiles(sb: SupabaseClient, paths: string[]): Promise<{ removed: number; pending: number }> {
  if (!paths.length) return { removed: 0, pending: 0 };
  let removed = 0;
  let pending = 0;
  for (let k = 0; k < paths.length; k += 100) {
    const batch = paths.slice(k, k + 100);
    const { error } = await sb.storage.from(BUCKET).remove(batch);
    if (error) {
      pending += batch.length;
      await sb.rpc("trash_files_done", { p_paths: batch, p_error: error.message });
    } else {
      removed += batch.length;
      const done = await sb.rpc("trash_files_done", { p_paths: batch, p_error: null });
      if (done.error) console.error(done.error);
    }
  }
  return { removed, pending };
}

/** Suppression définitive (seconde confirmation dans l'interface) : élément, liés, puis fichiers stockés. */
export async function trashPurge(sb: SupabaseClient, trashId: string) {
  const r = await rpc<{ purged: boolean; files: string[] }>(sb, "trash_purge", { p_trash: uuid.parse(trashId) });
  const files = await removeQueuedFiles(sb, r.files ?? []);
  return { purged: r.purged, filesRemoved: files.removed, filesPending: files.pending };
}
