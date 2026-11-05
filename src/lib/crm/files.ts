// Fichiers des fiches : contenu dans le bucket privé `company-files`, métadonnées en base.
// L'envoi se fait directement du navigateur vers Storage via une URL signée à usage unique.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "./service";
import { FILE_CATEGORIES, MAX_FILE_BYTES, isAllowedType } from "./file-rules";

const BUCKET = "company-files";
const uuid = z.uuid("Identifiant invalide");

export type CompanyFile = {
  id: string;
  company_id: string;
  display_name: string;
  category: string | null;
  mime_type: string;
  size_bytes: number;
  status: "pending" | "ready" | "deleting";
  created_at: string;
};
const COLUMNS = "id, company_id, display_name, category, mime_type, size_bytes, status, created_at";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}

/** Liste une fiche. Les transferts abandonnés depuis plus de 24 h sont nettoyés au passage. */
export async function listFiles(sb: SupabaseClient, companyId: string): Promise<CompanyFile[]> {
  uuid.parse(companyId);
  const rows = check(
    await sb.from("company_files").select(`${COLUMNS}, storage_path, uploaded_by_kind`).eq("company_id", companyId).order("created_at", { ascending: false }),
  ) as (CompanyFile & { storage_path: string; uploaded_by_kind?: string })[];
  const limit = Date.now() - 24 * 3600_000;
  // transferts abandonnés depuis 24 h, et dépôts supprimés par un client dont l'objet n'a pas pu être retiré
  const orphans = rows.filter((f) => (f.status === "pending" && Date.parse(f.created_at) < limit) || (f.status === "deleting" && f.uploaded_by_kind === "client"));
  if (orphans.length) {
    await sb.storage.from(BUCKET).remove(orphans.map((o) => o.storage_path));
    await sb.from("company_files").delete().in("id", orphans.map((o) => o.id));
  }
  // le chemin de stockage ne quitte jamais le serveur
  return rows
    .filter((f) => f.status !== "pending" && !(f.status === "deleting" && f.uploaded_by_kind === "client"))
    .map((f) => ({ id: f.id, company_id: f.company_id, display_name: f.display_name, category: f.category, mime_type: f.mime_type, size_bytes: f.size_bytes, status: f.status, created_at: f.created_at }));
}

/** Crée la pièce jointe « en attente » et l'URL signée d'envoi : limites contrôlées côté serveur. */
export async function startUpload(sb: SupabaseClient, input: { companyId: string; name: string; type: string; size: number; category?: string | null }) {
  uuid.parse(input.companyId);
  if (input.size <= 0) throw new CrmError("Ce fichier est vide.");
  if (input.size > MAX_FILE_BYTES) throw new CrmError("Fichier trop volumineux (25 Mo maximum).");
  if (!isAllowedType(input.type)) throw new CrmError("Format non autorisé.");
  const id = crypto.randomUUID();
  const ext = (input.name.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1] ?? "bin").toLowerCase();
  const path = `${input.companyId}/${id}.${ext}`; // nom de stockage unique, distinct du nom affiché
  check(
    await sb.from("company_files").insert({
      id,
      company_id: input.companyId,
      storage_path: path,
      display_name: input.name.slice(0, 200),
      category: FILE_CATEGORIES.includes(input.category as never) ? input.category : null,
      mime_type: input.type,
      size_bytes: input.size,
    }),
  );
  const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    await sb.from("company_files").delete().eq("id", id);
    throw new CrmError(`Préparation de l'envoi impossible : ${error?.message ?? "réponse vide"}`);
  }
  return { id, signedUrl: data.signedUrl };
}

/** Le transfert est terminé : on vérifie que l'objet existe vraiment avant de rendre la pièce visible. */
export async function confirmUpload(sb: SupabaseClient, id: string): Promise<CompanyFile> {
  uuid.parse(id);
  const row = check(await sb.from("company_files").select("storage_path").eq("id", id).maybeSingle()) as { storage_path: string } | null;
  if (!row) throw new CrmError("Pièce jointe introuvable.");
  const probe = await sb.storage.from(BUCKET).createSignedUrl(row.storage_path, 10);
  if (probe.error) throw new CrmError("Le fichier n'a pas été reçu par le stockage.");
  return check(await sb.from("company_files").update({ status: "ready" }).eq("id", id).select(COLUMNS).single()) as CompanyFile;
}

/** Transfert échoué : aucune pièce fantôme, aucun fichier orphelin. */
export async function abortUpload(sb: SupabaseClient, id: string) {
  uuid.parse(id);
  const row = check(await sb.from("company_files").select("storage_path, status").eq("id", id).maybeSingle()) as { storage_path: string; status: string } | null;
  if (!row || row.status !== "pending") return;
  await sb.storage.from(BUCKET).remove([row.storage_path]);
  check(await sb.from("company_files").delete().eq("id", id));
}

export async function updateFile(sb: SupabaseClient, id: string, patch: { display_name?: string; category?: string | null }) {
  uuid.parse(id);
  const p: Record<string, unknown> = {};
  if (patch.display_name !== undefined) {
    const n = patch.display_name.trim();
    if (!n || n.length > 200) throw new CrmError("Nom invalide (1 à 200 caractères).");
    p.display_name = n;
  }
  if (patch.category !== undefined) {
    if (patch.category && !FILE_CATEGORIES.includes(patch.category as never)) throw new CrmError("Catégorie inconnue.");
    p.category = patch.category || null;
  }
  return check(await sb.from("company_files").update(p).eq("id", id).select(COLUMNS).single()) as CompanyFile;
}

/** Suppression en deux temps : marquée, objet retiré, ligne retirée. Un échec reste réessayable. */
export async function deleteFile(sb: SupabaseClient, id: string) {
  uuid.parse(id);
  const row = check(await sb.from("company_files").update({ status: "deleting" }).eq("id", id).select("storage_path").maybeSingle()) as { storage_path: string } | null;
  if (!row) throw new CrmError("Pièce jointe introuvable.");
  const { error } = await sb.storage.from(BUCKET).remove([row.storage_path]);
  if (error) throw new CrmError(`Le fichier n'a pas pu être retiré du stockage : ${error.message}. Réessayez.`);
  check(await sb.from("company_files").delete().eq("id", id));
}

/** Accès temporaire authentifié (5 minutes). */
export async function fileUrl(sb: SupabaseClient, id: string, download: boolean) {
  uuid.parse(id);
  const row = check(await sb.from("company_files").select("storage_path, display_name").eq("id", id).eq("status", "ready").maybeSingle()) as { storage_path: string; display_name: string } | null;
  if (!row) throw new CrmError("Pièce jointe introuvable.");
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(row.storage_path, 300, download ? { download: row.display_name } : undefined);
  if (error || !data) throw new CrmError("Lien temporaire impossible à créer.");
  return data.signedUrl;
}
