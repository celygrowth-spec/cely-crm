import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireOwner } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Exécute une action serveur : session vérifiée (les droits sont appliqués par RLS et
 * assert_owner), gestion d'erreur explicite. Une erreur n'est jamais présentée comme un succès.
 * Aucune revalidation ici : le client met à jour son cache de façon ciblée (useSync).
 * Revalider tout l'arbre à chaque action rendait chaque clic aussi lent qu'un chargement de page.
 */
export async function run<T>(fn: (sb: SupabaseClient) => Promise<T>): Promise<ActionResult<T>> {
  const { supabase } = await requireOwner();
  try {
    const data = await fn(supabase);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof CrmError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: "L'action a échoué de façon inattendue. Rechargez la page pour vérifier l'état, puis réessayez." };
  }
}
