// Bibliothèque générale : dossiers, fichiers et prompts. Utilisée par la route /api/library et par le connecteur
// MCP (lecture seule). Les droits sont appliqués en base (RLS, fonctions library_*) et dans le stockage privé ;
// ce module ne fait que valider les saisies et enchaîner base et stockage.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, fetchAll, friendlyError } from "./service";
import { confirmLibraryUpload, deleteLibraryFile, libraryFileUrl } from "./diagnostic";
import { LIBRARY_BUCKET } from "./diagnostic-rules";
import {
  MAX_FOLDER_NAME, MAX_ITEM_NAME, MAX_LIBRARY_BYTES, MAX_PROMPT_CHARS, libraryType, pathLabel, subtreeIds,
  type Library, type LibraryFolder, type LibraryItem, type LibraryPrompt,
} from "./library-rules";

const uuid = z.uuid("Identifiant invalide");
const FOLDER_COLUMNS = "id, parent_id, name, system_key, created_at, updated_at";
const ITEM_COLUMNS = "id, folder_id, kind, display_name, mime_type, size_bytes, created_at, updated_at";
const folderName = z.string().trim().min(1, "Nom de dossier obligatoire.").max(MAX_FOLDER_NAME, `Nom trop long (${MAX_FOLDER_NAME} caractères au maximum).`);
const itemName = z.string().trim().min(1, "Nom obligatoire.").max(MAX_ITEM_NAME, `Nom trop long (${MAX_ITEM_NAME} caractères au maximum).`);
const promptContent = z.string().max(MAX_PROMPT_CHARS, "Contenu trop long (200 000 caractères au maximum).");

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}
const rpc = async <T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>) => check<T>(await sb.rpc(fn, args));

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/** Toute la bibliothèque, sans le contenu des prompts (lu à la demande). Les envois inachevés n'apparaissent pas. */
export async function listLibrary(sb: SupabaseClient): Promise<Library> {
  const [folders, items] = await Promise.all([
    fetchAll<LibraryFolder>((a, b) => sb.from("library_folders").select(FOLDER_COLUMNS).order("name").order("id").range(a, b)),
    fetchAll<LibraryItem>((a, b) => sb.from("diagnostic_library_files").select(ITEM_COLUMNS).eq("status", "ready").order("display_name").order("id").range(a, b)),
  ]);
  if (folders.error || items.error) throw new CrmError(folders.error ?? items.error ?? "Lecture impossible");
  return { folders: folders.data, items: items.data };
}

export async function getPrompt(sb: SupabaseClient, id: string): Promise<LibraryPrompt> {
  const row = check<LibraryPrompt | null>(
    await sb.from("diagnostic_library_files").select("id, folder_id, display_name, content, updated_at").eq("id", uuid.parse(id)).eq("kind", "prompt").maybeSingle(),
  );
  if (!row) throw new CrmError("Prompt introuvable.");
  return row;
}

// ---------------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------------

export const createFolder = (sb: SupabaseClient, parent: string | null, name: string) =>
  rpc<string>(sb, "library_folder_create", { p_parent: parent ? uuid.parse(parent) : null, p_name: folderName.parse(name) });

export const renameFolder = (sb: SupabaseClient, id: string, name: string) =>
  rpc<null>(sb, "library_folder_rename", { p_folder: uuid.parse(id), p_name: folderName.parse(name) });

export const moveFolder = (sb: SupabaseClient, id: string, parent: string | null) =>
  rpc<null>(sb, "library_folder_move", { p_folder: uuid.parse(id), p_parent: parent ? uuid.parse(parent) : null });

export type FolderCounts = { items: number; folders: number };
export type FolderDeleteResult = { confirm: FolderCounts } | { deleted: true; counts: FolderCounts; storageFailed: number };

/**
 * Suppression définitive d'un dossier et de son contenu. `confirmedItems` est le nombre annoncé à l'utilisateur :
 * s'il ne correspond plus au contenu réel, rien n'est supprimé et le nouveau décompte est renvoyé.
 * Les objets de stockage sont retirés ensuite ; un échec est signalé (fichiers devenus invisibles, sans accès possible).
 */
export async function deleteFolder(sb: SupabaseClient, id: string, confirmedItems: number | null): Promise<FolderDeleteResult> {
  const r = await rpc<{ confirm?: FolderCounts; deleted?: true; counts?: FolderCounts; paths?: string[] }>(sb, "library_folder_delete", {
    p_folder: uuid.parse(id),
    p_confirmed_items: confirmedItems === null ? null : z.number().int().min(0).parse(confirmedItems),
  });
  if (r.confirm) return { confirm: r.confirm };
  const paths = r.paths ?? [];
  let storageFailed = 0;
  for (let i = 0; i < paths.length; i += 100) {
    const chunk = paths.slice(i, i + 100);
    const { error } = await sb.storage.from(LIBRARY_BUCKET).remove(chunk);
    if (error) storageFailed += chunk.length;
  }
  return { deleted: true, counts: r.counts ?? { items: 0, folders: 0 }, storageFailed };
}

// ---------------------------------------------------------------------------
// Éléments
// ---------------------------------------------------------------------------

/** Prépare l'envoi d'un fichier : type déduit de l'extension, taille contrôlée, nom libre choisi par la base. */
export async function startFile(sb: SupabaseClient, input: { folder: string | null; name: string; size: number }) {
  const name = itemName.parse(input.name);
  const type = libraryType(name);
  if (!type) throw new CrmError("Format non autorisé.");
  const size = z.number().int().parse(input.size);
  if (size <= 0) throw new CrmError("Ce fichier est vide.");
  if (size > MAX_LIBRARY_BYTES) throw new CrmError("Fichier trop volumineux (25 Mo maximum).");
  const ext = name.split(".").pop()!.toLowerCase();
  const row = await rpc<{ id: string; name: string; path: string }>(sb, "library_file_start", {
    p_folder: input.folder ? uuid.parse(input.folder) : null, p_name: name, p_mime: type, p_size: size, p_ext: ext,
  });
  const { data, error } = await sb.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(row.path);
  if (error || !data) {
    await sb.from("diagnostic_library_files").delete().eq("id", row.id);
    throw new CrmError("Préparation de l'envoi impossible. Réessayez.");
  }
  return { id: row.id, name: row.name, signedUrl: data.signedUrl, type };
}

export const confirmFile = (sb: SupabaseClient, id: string) => confirmLibraryUpload(sb, uuid.parse(id));
/** Supprime un élément (fichier ou prompt) ; sert aussi à abandonner un envoi. */
export const deleteItem = (sb: SupabaseClient, id: string) => deleteLibraryFile(sb, uuid.parse(id));
export const fileUrl = (sb: SupabaseClient, id: string, download: boolean) => libraryFileUrl(sb, id, download);

export const renameItem = (sb: SupabaseClient, id: string, name: string) =>
  rpc<null>(sb, "library_item_rename", { p_id: uuid.parse(id), p_name: itemName.parse(name) });

export const moveItem = (sb: SupabaseClient, id: string, folder: string) =>
  rpc<null>(sb, "library_item_move", { p_id: uuid.parse(id), p_folder: uuid.parse(folder) });

export const createPrompt = (sb: SupabaseClient, folder: string, title: string, content: string) =>
  rpc<string>(sb, "library_prompt_create", { p_folder: uuid.parse(folder), p_title: itemName.parse(title), p_content: promptContent.parse(content) });

export const updatePrompt = (sb: SupabaseClient, id: string, title: string, content: string) =>
  rpc<null>(sb, "library_prompt_update", { p_id: uuid.parse(id), p_title: itemName.parse(title), p_content: promptContent.parse(content) });

// ---------------------------------------------------------------------------
// Connecteur MCP : vues en lecture seule, chemins lisibles
// ---------------------------------------------------------------------------

export async function mcpFolders(sb: SupabaseClient) {
  const lib = await listLibrary(sb);
  return lib.folders
    .map((f) => ({
      id: f.id,
      nom: f.name,
      chemin: pathLabel(lib.folders, f.id),
      dossier_parent_id: f.parent_id,
      dossier_diagnostic: f.system_key === "diagnostic",
      elements: lib.items.filter((i) => i.folder_id === f.id).length,
    }))
    .sort((a, b) => a.chemin.localeCompare(b.chemin, "fr", { numeric: true }));
}

export async function mcpItems(sb: SupabaseClient, opts: { folderId?: string; recursive?: boolean; query?: string; limit: number; offset: number }) {
  const lib = await listLibrary(sb);
  let items = lib.items;
  if (opts.folderId) {
    const id = uuid.parse(opts.folderId);
    if (!lib.folders.some((f) => f.id === id)) throw new CrmError("Dossier introuvable.");
    const ids = opts.recursive ? subtreeIds(lib.folders, id) : new Set([id]);
    items = items.filter((i) => ids.has(i.folder_id));
  }
  const words = (opts.query ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    items = items.filter((i) => {
      const n = i.display_name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      return words.every((w) => n.includes(w));
    });
  }
  const page = items.slice(opts.offset, opts.offset + opts.limit);
  return {
    total: items.length,
    elements: page.map((i) => ({
      id: i.id,
      type: i.kind === "prompt" ? "prompt" : "fichier",
      nom: i.display_name,
      dossier_id: i.folder_id,
      chemin: pathLabel(lib.folders, i.folder_id),
      ...(i.kind === "file" ? { format: i.mime_type, taille_octets: i.size_bytes } : {}),
      modifie_le: i.updated_at,
    })),
    suite: opts.offset + page.length < items.length ? { offset: opts.offset + page.length } : null,
  };
}

export async function mcpPrompt(sb: SupabaseClient, id: string) {
  const p = await getPrompt(sb, id);
  const lib = await listLibrary(sb);
  return { id: p.id, titre: p.display_name, chemin: pathLabel(lib.folders, p.folder_id), modifie_le: p.updated_at, contenu: p.content };
}
