import "server-only";
// Base sans les migrations du CMS (preview reliée à une base non migrée, par exemple) : les écrans affichent un
// message clair au lieu d'une erreur.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function cmsMissingTables(sb: SupabaseClient): Promise<boolean> {
  const { error } = await sb.from("cms_entries").select("id").limit(1);
  return !!error && (error.code === "PGRST205" || error.code === "42P01" || /cms_entries/.test(error.message) && /not (exist|find)|introuvable/i.test(error.message));
}
