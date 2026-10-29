import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth";
import { CrmError } from "@/lib/crm/service";

export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Exécute une action serveur : contrôle d'accès, gestion d'erreur explicite et
 * rafraîchissement des pages. Une erreur n'est jamais présentée comme un succès.
 */
export async function run<T>(fn: (sb: SupabaseClient) => Promise<T>, opts: { revalidate?: boolean } = {}): Promise<ActionResult<T>> {
  const { supabase } = await requireOwner();
  try {
    const data = await fn(supabase);
    if (opts.revalidate !== false) revalidatePath("/", "layout");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof CrmError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: "L'action a échoué de façon inattendue. Rechargez la page pour vérifier l'état, puis réessayez." };
  }
}
