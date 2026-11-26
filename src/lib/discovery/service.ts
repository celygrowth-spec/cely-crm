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

// Écritures du propriétaire ouvertes au connecteur Claude ----------------------------------------------------
// origin : « owner » (valeur dictée par moi) ou « claude » (proposition de Claude). overwrite = false : une valeur
// saisie par le client ou par moi n'est pas remplacée ; la fonction renvoie alors la valeur en place (status kept).

export type Origin = "client" | "owner" | "claude";
export type OwnerOrigin = "owner" | "claude";
type Current = { value?: string; unknown?: boolean; status?: string; origin: Origin; by: string | null; at: string };
export type SaveResult = { status: "saved" | "unchanged" | "kept"; origin?: Origin; current?: Current; replaced?: Current | null; fiche?: string | null };
export type TargetField = { field: string; current?: string; before?: string; origin: Origin };
export type TargetResult = { rev: number; changed: boolean; validation_dropped?: boolean; kept?: TargetField[]; replaced?: TargetField[] };

export const saveDiscoveryAnswer = (sb: SupabaseClient, projectId: string, a: { key: string; value: string; unknown?: boolean }, origin: OwnerOrigin, overwrite: boolean) =>
  rpc<SaveResult>(sb, "discovery_answer_save", { p_project: uuid.parse(projectId), p_key: a.key, p_value: a.value, p_unknown: a.unknown ?? false, p_origin: origin, p_overwrite: overwrite });

export const saveDiscoveryStep = (sb: SupabaseClient, projectId: string, step: string, status: "done" | "none" | "later" | null, origin: OwnerOrigin, overwrite: boolean) =>
  rpc<SaveResult>(sb, "discovery_step_save", { p_project: uuid.parse(projectId), p_step: step, p_status: status, p_origin: origin, p_overwrite: overwrite });

export const markDiscoverySent = (sb: SupabaseClient, projectId: string, sent: boolean, origin: OwnerOrigin) =>
  rpc<{ status: "saved" | "unchanged"; sent_at?: string | null; sent_origin?: Origin; sent_by?: string | null }>(sb, "discovery_mark_sent", { p_project: uuid.parse(projectId), p_sent: sent, p_origin: origin });

export const saveDiscoveryTargetGuarded = (sb: SupabaseClient, projectId: string, position: number, data: unknown, origin: OwnerOrigin, overwrite: boolean) =>
  rpc<TargetResult>(sb, "discovery_target_save", {
    p_project: uuid.parse(projectId), p_position: z.number().int().min(1).max(3).parse(position), p_data: targetSchema.parse(data), p_origin: origin, p_overwrite: overwrite,
  });

export const attachDiscoveryFile = (sb: SupabaseClient, projectId: string, step: string, fileId: string, account: string | null, origin: OwnerOrigin) =>
  rpc<{ status: "saved" | "unchanged"; id: string; name?: string }>(sb, "discovery_file_attach", { p_project: uuid.parse(projectId), p_step: step, p_file: uuid.parse(fileId), p_account: account, p_origin: origin });

export const detachDiscoveryFile = (sb: SupabaseClient, discoveryFileId: string) =>
  rpc<{ status: "saved"; name: string | null }>(sb, "discovery_file_detach", { p_id: uuid.parse(discoveryFileId) });

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
