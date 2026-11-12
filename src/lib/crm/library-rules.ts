// Règles partagées navigateur / serveur de la bibliothèque générale (dossiers, fichiers, prompts).
// Les fichiers vivent dans le bucket privé de la bibliothèque de diagnostic : mêmes types, même taille maximale.
export { LIBRARY_ACCEPT, MAX_LIBRARY_BYTES, libraryType } from "./diagnostic-rules";

export const DIAGNOSTIC_FOLDER_NAME = "Bibliothèque diagnostic";
export const MAX_FOLDER_NAME = 120;
export const MAX_ITEM_NAME = 200;
export const MAX_PROMPT_CHARS = 200000;
/** Fichiers envoyés en même temps lors d'un dépôt multiple (les autres attendent leur tour). */
export const UPLOAD_CONCURRENCY = 3;

export type LibraryFolder = { id: string; parent_id: string | null; name: string; system_key: "diagnostic" | null; created_at: string; updated_at: string };
export type LibraryItem = {
  id: string;
  folder_id: string;
  kind: "file" | "prompt";
  display_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  updated_at: string;
};
export type LibraryPrompt = { id: string; folder_id: string; display_name: string; content: string; updated_at: string };
export type Library = { folders: LibraryFolder[]; items: LibraryItem[] };

/** Chemin de la racine jusqu'au dossier (inclus). Une boucle de données ne fait jamais tourner à l'infini. */
export function folderPath(folders: LibraryFolder[], id: string | null): LibraryFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const out: LibraryFolder[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur && out.length < 50 && !out.includes(cur)) {
    out.unshift(cur);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return out;
}

export const pathLabel = (folders: LibraryFolder[], id: string | null) => folderPath(folders, id).map((f) => f.name).join(" › ");

/** Le dossier et tous ses sous-dossiers. */
export function subtreeIds(folders: LibraryFolder[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) { out.add(f.id); grew = true; }
  }
  return out;
}

/** Destinations possibles pour déplacer un dossier : ni lui-même, ni un de ses sous-dossiers, ni son parent actuel. */
export function folderMoveTargets(folders: LibraryFolder[], id: string): { id: string | null; label: string }[] {
  const self = folders.find((f) => f.id === id);
  const banned = subtreeIds(folders, id);
  const list = folders.filter((f) => !banned.has(f.id) && f.id !== self?.parent_id).map((f) => ({ id: f.id as string | null, label: pathLabel(folders, f.id) }));
  list.sort((a, b) => a.label.localeCompare(b.label, "fr", { numeric: true }));
  return self?.parent_id ? [{ id: null, label: "Racine de la bibliothèque" }, ...list] : list;
}

/** Destinations possibles pour un élément : tous les dossiers sauf celui où il se trouve. */
export function itemMoveTargets(folders: LibraryFolder[], current: string): { id: string; label: string }[] {
  return folders
    .filter((f) => f.id !== current)
    .map((f) => ({ id: f.id, label: pathLabel(folders, f.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, "fr", { numeric: true }));
}

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Recherche par nom sur toute la bibliothèque (accents et casse ignorés, tous les mots requis). */
export function searchLibrary(lib: Library, q: string): { folders: LibraryFolder[]; items: LibraryItem[] } {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return { folders: [], items: [] };
  const hit = (name: string) => { const n = fold(name); return words.every((w) => n.includes(w)); };
  return { folders: lib.folders.filter((f) => hit(f.name)), items: lib.items.filter((i) => hit(i.display_name)) };
}

/** Nombre d'éléments d'un dossier, sous-dossiers compris. */
export function countItems(lib: Library, id: string): number {
  const ids = subtreeIds(lib.folders, id);
  return lib.items.filter((i) => ids.has(i.folder_id)).length;
}

/** Nom de fichier sûr pour télécharger un prompt en texte. */
export const promptFileName = (title: string) =>
  `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "prompt"}.txt`;
