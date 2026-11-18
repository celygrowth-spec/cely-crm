// Onboarding de l'offre découverte, côté CRM (session du propriétaire, ou connecteur Claude en lecture).
// Toutes les règles (droits, validation retirée, fichiers) sont appliquées en base par les fonctions discovery_*.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import type { DiscoveryAdmin, DiscoveryView } from "./types";

const uuid = z.uuid("Identifiant invalide");
const BUCKET = "company-files";
/** Liens de téléchargement des dépôts (blacklists, archives) : courts. */
export const DOWNLOAD_TTL_SECONDS = 60;

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}

export const discoveryAdmin = (sb: SupabaseClient, projectId: string) => rpc<DiscoveryAdmin>(sb, "discovery_admin", { p_project: uuid.parse(projectId) });
export const discoveryPreview = (sb: SupabaseClient, projectId: string) => rpc<DiscoveryView>(sb, "discovery_preview", { p_project: uuid.parse(projectId) });

export async function discoveryEnabled(sb: SupabaseClient, projectId: string): Promise<boolean> {
  const { data } = await sb.from("discovery_onboardings").select("enabled").eq("project_id", projectId).maybeSingle();
  return !!data?.enabled;
}

export const setDiscoveryEnabled = (sb: SupabaseClient, projectId: string, enabled: boolean) =>
  rpc<{ enabled: boolean }>(sb, "discovery_set_enabled", { p_project: uuid.parse(projectId), p_enabled: enabled });

export const settingsSchema = z.object({ lemlist_invite_email: z.union([z.literal(""), z.email("Adresse email invalide").max(254)]) });
export async function saveDiscoverySettings(sb: SupabaseClient, input: unknown) {
  const s = settingsSchema.parse(input);
  await rpc(sb, "discovery_settings_save", { p_lemlist_invite_email: s.lemlist_invite_email });
}

export const targetSchema = z.object({
  name: z.string().max(120), sector: z.string().max(300), company_size: z.string().max(120),
  roles: z.string().max(500), geography: z.string().max(300), notes: z.string().max(2000),
}).partial();
export const saveDiscoveryTarget = (sb: SupabaseClient, projectId: string, position: number, data: unknown) =>
  rpc<{ rev: number; changed: boolean; validation_dropped?: boolean }>(sb, "discovery_target_save", {
    p_project: uuid.parse(projectId), p_position: z.number().int().min(1).max(3).parse(position), p_data: targetSchema.parse(data),
  });

/** Lien de téléchargement court d'un dépôt d'onboarding (le chemin de stockage ne quitte jamais le serveur). */
export async function discoveryFileUrl(sb: SupabaseClient, projectId: string, discoveryFileId: string) {
  const { data, error } = await sb.from("discovery_files").select("file:company_files!inner(storage_path, display_name, status)")
    .eq("id", uuid.parse(discoveryFileId)).eq("project_id", uuid.parse(projectId)).maybeSingle();
  if (error) throw new CrmError(friendlyError(error));
  const f = (data as { file: { storage_path: string; display_name: string; status: string } | { storage_path: string; display_name: string; status: string }[] } | null)?.file;
  const file = Array.isArray(f) ? f[0] : f;
  if (!file || file.status !== "ready") throw new CrmError("Fichier introuvable.");
  const signed = await sb.storage.from(BUCKET).createSignedUrl(file.storage_path, DOWNLOAD_TTL_SECONDS, { download: file.display_name });
  if (signed.error || !signed.data) throw new CrmError("Lien temporaire impossible à créer.");
  return signed.data.signedUrl;
}
