import "server-only";
// Passage planifié « contenus » : Programmé dont la date est passée → Publié (le site le voit déjà dès la date, la
// base le calcule à la lecture), puis envoi au site des rafraîchissements dus (nouvelles demandes et reprises).
import type { SupabaseClient } from "@supabase/supabase-js";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { flushRevalidations } from "./revalidate";

export async function contentsJob(sb: SupabaseClient) {
  const key = serverRpcKey();
  const { data, error } = await sb.rpc("cms_promote_due_server", { p_server_key: key });
  if (error) throw new Error("Passage des articles programmés impossible (clé serveur ?)");
  const flush = await flushRevalidations(sb, key);
  if (flush.failed) throw new Error("Le site n'a pas pu être rafraîchi : nouvel essai automatique au prochain passage.");
  return { publies: Number(data ?? 0), rafraichissements: flush.sent };
}
