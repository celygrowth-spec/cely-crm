import "server-only";
// Passage planifié « corbeille » : purge des éléments à la corbeille depuis 30 jours (clé serveur, sans session),
// puis retrait de leurs fichiers du stockage grâce à une autorisation temporaire posée par la base (même
// mécanisme que le portail client). Un fichier déjà absent compte comme retiré ; un échec est réessayé.
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverRpcKey } from "@/lib/appointments/secrets";

export async function trashJob(sb: SupabaseClient) {
  const { data, error } = await sb.rpc("trash_purge_due", { p_server_key: serverRpcKey(), p_limit: 50 });
  if (error) throw new Error(`Purge de la corbeille impossible : ${error.message}`);
  const r = data as { purged: number; failed: number; files: string[] };
  let removed = 0;
  let pending = 0;
  const files = r.files ?? [];
  for (let k = 0; k < files.length; k += 100) {
    const batch = files.slice(k, k + 100);
    const res = await sb.storage.from("company-files").remove(batch);
    const done = await sb.rpc("trash_files_done_server", { p_server_key: serverRpcKey(), p_paths: batch, p_error: res.error ? res.error.message : null });
    if (res.error || done.error) pending += batch.length;
    else removed += batch.length;
  }
  if (r.failed > 0) throw new Error(`${r.failed} élément(s) n'ont pas pu être purgés (voir la Corbeille) ; ${r.purged} purgé(s).`);
  return { purged: r.purged, files_removed: removed, files_pending: pending };
}
