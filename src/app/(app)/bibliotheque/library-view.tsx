"use client";

// Bibliothèque générale : dossiers et sous-dossiers, fichiers et prompts. Toutes les règles (noms en double,
// dossier diagnostic permanent, déplacement d'un dossier dans lui-même, droits) sont vérifiées en base ;
// l'écran les reflète et affiche le message exact en cas de refus.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ChevronRight, Copy, Download, File, FileImage, FileText, Folder, FolderInput, FolderPlus, Lock, NotebookPen, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { Button, Input, Modal, Select, Skeleton, Textarea, cn } from "@/components/ui";
import { apiGet, attempt } from "@/lib/client/query";
import { formatBytes } from "@/lib/crm/file-rules";
import { formatDateTime } from "@/lib/format";
import {
  LIBRARY_ACCEPT, MAX_FOLDER_NAME, MAX_ITEM_NAME, MAX_LIBRARY_BYTES, MAX_PROMPT_CHARS, UPLOAD_CONCURRENCY,
  countItems, folderMoveTargets, folderPath, itemMoveTargets, libraryType, pathLabel, promptFileName, searchLibrary,
  type Library, type LibraryFolder, type LibraryItem, type LibraryPrompt,
} from "@/lib/crm/library-rules";

const KEY = ["library"];
type Result<T> = { ok: true; data: T } | { ok: false; error: string };
type Counts = { items: number; folders: number };

const op = <T,>(body: Record<string, unknown>): Promise<Result<T>> =>
  attempt(async () => {
    const res = await fetch("/api/library", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Result<T>;
  });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const iconFor = (i: LibraryItem) => (i.kind === "prompt" ? NotebookPen : i.mime_type.startsWith("image/") ? FileImage : i.mime_type === "application/pdf" || i.mime_type.startsWith("text/") ? FileText : File);
const typeLabel = (i: LibraryItem) =>
  i.kind === "prompt" ? "Prompt" : i.mime_type === "application/pdf" ? "PDF" : i.mime_type.startsWith("image/") ? "Image" : i.mime_type.includes("word") ? "Word"
    : i.mime_type.includes("sheet") || i.mime_type === "text/csv" ? "Tableur" : i.mime_type.includes("presentation") ? "Présentation" : "Texte";

/** Copie fiable même quand le texte arrive après un appel réseau (Safari exige un ClipboardItem dans ce cas). */
async function copyText(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return true;
    }
    await navigator.clipboard.writeText(await text);
    return true;
  } catch {
    try { await navigator.clipboard.writeText(await text); return true; } catch { return false; }
  }
}

function saveBlob(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type Upload = { key: string; name: string; progress: number; error?: string };
type PromptForm = { id: string | null; title: string; content: string; loading?: boolean };
type MoveForm = { kind: "folder" | "item"; id: string; name: string; target: string };
type FolderForm = { id: string | null; name: string };
type Removal = { folder: LibraryFolder; counts: Counts };

export function LibraryView({ initialFolder }: { initialFolder: string | null }) {
  const qc = useQueryClient();
  const { data, isError, error, refetch } = useQuery({ queryKey: KEY, queryFn: ({ signal }) => apiGet<Library>("/api/library", signal) });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [folderForm, setFolderForm] = useState<FolderForm | null>(null);
  const [promptForm, setPromptForm] = useState<PromptForm | null>(null);
  const [moveForm, setMoveForm] = useState<MoveForm | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const resolved = useRef(false);

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: KEY });
    void qc.invalidateQueries({ queryKey: ["diagnostic-library"] });
  }, [qc]);

  // dossier demandé dans l'adresse (?dossier=<id> ou ?dossier=diagnostic), une fois la bibliothèque chargée
  useEffect(() => {
    if (!data || resolved.current) return;
    resolved.current = true;
    const target = initialFolder === "diagnostic" ? data.folders.find((f) => f.system_key === "diagnostic")?.id : data.folders.find((f) => f.id === initialFolder)?.id;
    if (target) setFolderId(target);
  }, [data, initialFolder]);

  // un dossier supprimé ou introuvable ramène à la racine ; l'adresse suit le dossier ouvert
  const current = data?.folders.find((f) => f.id === folderId) ?? null;
  useEffect(() => {
    if (data && folderId && !current) setFolderId(null);
  }, [data, folderId, current]);
  useEffect(() => {
    if (!resolved.current) return;
    const url = new URL(window.location.href);
    if (folderId) url.searchParams.set("dossier", folderId);
    else url.searchParams.delete("dossier");
    window.history.replaceState(null, "", url.toString());
  }, [folderId]);

  const lib = useMemo<Library>(() => data ?? { folders: [], items: [] }, [data]);
  const crumbs = folderPath(lib.folders, folderId);
  const search = q.trim();
  const results = useMemo(() => searchLibrary(lib, search), [lib, search]);
  const subfolders = useMemo(
    () => lib.folders.filter((f) => f.parent_id === folderId).sort((a, b) => Number(!!b.system_key) - Number(!!a.system_key) || a.name.localeCompare(b.name, "fr", { numeric: true })),
    [lib.folders, folderId],
  );
  const items = useMemo(() => lib.items.filter((i) => i.folder_id === folderId).sort((a, b) => a.display_name.localeCompare(b.display_name, "fr", { numeric: true })), [lib.items, folderId]);

  /** Une action à la fois : un double clic ne lance jamais deux fois la même opération. */
  async function run<T>(p: () => Promise<Result<T>>, success?: string): Promise<T | undefined> {
    if (busy) return undefined;
    setBusy(true);
    try {
      const r = await p();
      if (!r.ok) { toast.error(r.error); return undefined; }
      if (success) toast.success(success);
      refresh();
      return r.data;
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- dépôt
  const setU = (key: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function uploadOne(file: File, key: string, folder: string): Promise<boolean> {
    if (!libraryType(file.name)) { setU(key, { error: "Format non autorisé" }); return false; }
    if (file.size <= 0) { setU(key, { error: "Fichier vide" }); return false; }
    if (file.size > MAX_LIBRARY_BYTES) { setU(key, { error: "Plus de 25 Mo" }); return false; }
    const s = await op<{ id: string; name: string; signedUrl: string; type: string }>({ op: "file_start", folder, name: file.name, size: file.size });
    if (!s.ok) { setU(key, { error: s.error }); return false; }
    const sent = await new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", s.data.signedUrl);
      xhr.setRequestHeader("Content-Type", s.data.type);
      xhr.upload.onprogress = (e) => e.lengthComputable && setU(key, { progress: e.loaded / e.total });
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => resolve(false);
      xhr.send(file);
    });
    const done = sent ? await op({ op: "file_confirm", id: s.data.id }) : ({ ok: false, error: "Transfert interrompu, réessayez" } as const);
    if (!done.ok) {
      await op({ op: "item_delete", id: s.data.id }); // aucun fichier fantôme
      setU(key, { error: done.error });
      return false;
    }
    setUploads((u) => u.filter((x) => x.key !== key));
    return true;
  }

  /** Dépôt multiple : envois en parallèle limité ; les réussis restent, les échecs sont listés avec leur raison. */
  async function addFiles(list: FileList | File[] | null) {
    if (!list || !current) return;
    const files = Array.from(list);
    if (!files.length) return;
    const folder = current.id;
    const queue = files.map((f) => ({ file: f, key: crypto.randomUUID() }));
    setUploads((u) => [...u, ...queue.map((x) => ({ key: x.key, name: x.file.name, progress: 0 }))]);
    let ok = 0;
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const job = queue[next++];
        if (await uploadOne(job.file, job.key, folder)) ok++;
        refresh();
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, worker));
    const failed = queue.length - ok;
    if (failed === 0) toast.success(`${plural(ok, "fichier ajouté", "fichiers ajoutés")}`);
    else toast.error(`${plural(ok, "fichier ajouté", "fichiers ajoutés")}, ${plural(failed, "échec")} : voir la liste`);
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (current) void addFiles(e.dataTransfer.files);
  };

  // ---------------------------------------------------------------- éléments
  async function download(i: LibraryItem) {
    if (i.kind === "prompt") {
      const r = await attempt(async () => ({ ok: true as const, data: await apiGet<LibraryPrompt>(`/api/library?prompt=${i.id}`) }));
      if (!r.ok) return toast.error(r.error);
      return saveBlob(promptFileName(r.data.display_name), r.data.content);
    }
    const r = await op<string>({ op: "file_url", id: i.id, download: true });
    if (!r.ok) return toast.error(r.error);
    window.location.assign(r.data);
  }
  async function open(i: LibraryItem) {
    if (i.kind === "prompt") return editPrompt(i);
    const r = await op<string>({ op: "file_url", id: i.id, download: false });
    if (!r.ok) return toast.error(r.error);
    window.open(r.data, "_blank", "noopener,noreferrer");
  }
  async function copyPrompt(id: string, known?: string) {
    const text = known !== undefined ? Promise.resolve(known) : apiGet<LibraryPrompt>(`/api/library?prompt=${id}`).then((p) => p.content);
    if (await copyText(text)) toast.success("Prompt copié dans le presse-papiers");
    else toast.error("Copie impossible : autorisez l'accès au presse-papiers ou copiez le texte à la main.");
  }
  async function editPrompt(i: LibraryItem) {
    setPromptForm({ id: i.id, title: i.display_name, content: "", loading: true });
    try {
      const p = await apiGet<LibraryPrompt>(`/api/library?prompt=${i.id}`);
      setPromptForm((f) => (f?.id === i.id ? { id: p.id, title: p.display_name, content: p.content } : f));
    } catch (e) {
      setPromptForm(null);
      toast.error(e instanceof Error ? e.message : "Chargement impossible");
    }
  }
  async function savePrompt() {
    if (!promptForm || promptForm.loading || (!current && !promptForm.id)) return;
    const title = promptForm.title.trim();
    if (!title) return toast.error("Donnez un titre au prompt.");
    const ok = promptForm.id
      ? await run(() => op({ op: "prompt_update", id: promptForm.id, title, content: promptForm.content }), "Prompt enregistré")
      : await run(() => op<string>({ op: "prompt_create", folder: current!.id, title, content: promptForm.content }), "Prompt créé");
    if (ok !== undefined) setPromptForm(null);
  }
  async function removeItem(i: LibraryItem) {
    if (!confirm(`Supprimer définitivement « ${i.display_name} » ? ${i.kind === "prompt" ? "Le texte" : "Le fichier"} ne pourra pas être récupéré.`)) return;
    await run(() => op({ op: "item_delete", id: i.id }), i.kind === "prompt" ? "Prompt supprimé" : "Fichier supprimé");
  }

  // ---------------------------------------------------------------- dossiers
  async function saveFolder() {
    if (!folderForm) return;
    const name = folderForm.name.trim();
    if (!name) return;
    const ok = folderForm.id
      ? await run(() => op({ op: "folder_rename", id: folderForm.id, name }), "Dossier renommé")
      : await run(() => op<string>({ op: "folder_create", parent: folderId, name }), "Dossier créé");
    if (ok !== undefined) setFolderForm(null);
  }
  async function askRemove(f: LibraryFolder) {
    const r = await run(() => op<{ confirm?: Counts }>({ op: "folder_delete", id: f.id, confirmed: null }));
    if (r?.confirm) setRemoval({ folder: f, counts: r.confirm });
  }
  async function confirmRemove() {
    if (!removal) return;
    const r = await run(() => op<{ confirm?: Counts; deleted?: true; storageFailed?: number }>({ op: "folder_delete", id: removal.folder.id, confirmed: removal.counts.items }));
    if (!r) return;
    if (r.confirm) {
      toast.info("Le contenu du dossier a changé : vérifiez le nouveau décompte.");
      return setRemoval({ ...removal, counts: r.confirm });
    }
    toast.success(`Dossier « ${removal.folder.name} » supprimé`);
    if (r.storageFailed) toast.error(`${plural(r.storageFailed, "fichier")} n'a pas pu être effacé du stockage : invisible et inaccessible, sans risque. Signalez-le si cela se répète.`);
    if (folderId && crumbs.some((c) => c.id === removal.folder.id)) setFolderId(removal.folder.parent_id);
    setRemoval(null);
  }
  async function submitMove() {
    if (!moveForm) return;
    const target = moveForm.target === "root" ? null : moveForm.target;
    if (moveForm.kind === "item" && !target) return;
    const ok = moveForm.kind === "folder"
      ? await run(() => op({ op: "folder_move", id: moveForm.id, parent: target }), "Dossier déplacé")
      : await run(() => op({ op: "item_move", id: moveForm.id, folder: target }), "Élément déplacé");
    if (ok !== undefined) setMoveForm(null);
  }
  async function submitRename(i: LibraryItem) {
    if (!renaming) return;
    const name = renaming.name.trim();
    if (!name || name === i.display_name) return setRenaming(null);
    const ok = await run(() => op({ op: "item_rename", id: i.id, name }), "Élément renommé");
    if (ok !== undefined) setRenaming(null);
  }

  if (isError) return <p className="text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>;
  if (!data) return <Skeleton className="h-96 w-full" />;

  const moveTargets = moveForm ? (moveForm.kind === "folder" ? folderMoveTargets(lib.folders, moveForm.id) : itemMoveTargets(lib.folders, lib.items.find((x) => x.id === moveForm.id)?.folder_id ?? "")) : [];

  const itemRow = (i: LibraryItem, showPath: boolean) => {
    const Icon = iconFor(i);
    return (
      <tr key={i.id}>
        <td className="py-2 pr-2">
          {renaming?.id === i.id ? (
            <form className="flex gap-1" onSubmit={(e) => { e.preventDefault(); void submitRename(i); }}>
              <Input autoFocus value={renaming.name} maxLength={MAX_ITEM_NAME} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} className="h-8" aria-label="Nouveau nom" />
              <Button size="sm" type="submit" disabled={busy}>OK</Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(null)} aria-label="Annuler"><X size={13} /></Button>
            </form>
          ) : (
            <button type="button" onClick={() => open(i)} className="flex items-center gap-2 text-left font-semibold text-ink hover:text-violet-strong">
              <Icon size={16} className={cn("shrink-0", i.kind === "prompt" ? "text-violet-strong" : "text-muted")} aria-hidden /> <span className="break-all">{i.display_name}</span>
            </button>
          )}
          {showPath && <button type="button" onClick={() => { setQ(""); setFolderId(i.folder_id); }} className="mt-0.5 block text-left text-xs text-muted hover:underline">{pathLabel(lib.folders, i.folder_id)}</button>}
        </td>
        <td className="text-muted">{typeLabel(i)}</td>
        <td className="text-muted tabular-nums">{i.kind === "file" ? formatBytes(i.size_bytes) : "—"}</td>
        <td className="hidden text-muted md:table-cell">{formatDateTime(i.updated_at)}</td>
        <td className="py-2 text-right whitespace-nowrap">
          {i.kind === "prompt" && <button type="button" onClick={() => copyPrompt(i.id)} className="rounded px-1.5 py-1 text-xs font-semibold text-violet-strong hover:bg-violet-soft" aria-label={`Copier ${i.display_name}`}><Copy size={13} className="mr-1 inline" aria-hidden />Copier</button>}
          <button type="button" onClick={() => download(i)} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Télécharger ${i.display_name}`} title="Télécharger"><Download size={15} /></button>
          <button type="button" onClick={() => setRenaming({ id: i.id, name: i.display_name })} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Renommer ${i.display_name}`} title="Renommer"><Pencil size={14} /></button>
          <button type="button" onClick={() => setMoveForm({ kind: "item", id: i.id, name: i.display_name, target: "" })} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Déplacer ${i.display_name}`} title="Déplacer"><FolderInput size={14} /></button>
          <button type="button" onClick={() => removeItem(i)} className="rounded p-1.5 text-muted hover:bg-danger/5 hover:text-danger" aria-label={`Supprimer ${i.display_name}`} title="Supprimer"><Trash2 size={14} /></button>
        </td>
      </tr>
    );
  };

  const folderCard = (f: LibraryFolder, showPath: boolean) => (
    <li key={f.id} className="flex items-center gap-1 rounded-lg border border-line bg-white px-3 py-2 hover:border-violet">
      <button type="button" onClick={() => { setQ(""); setFolderId(f.id); }} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold text-ink">
        <Folder size={16} className="shrink-0 text-violet-strong" aria-hidden />
        <span className="min-w-0"><span className="block truncate">{f.name}</span>{showPath && f.parent_id && <span className="block truncate text-xs font-normal text-muted">{pathLabel(lib.folders, f.parent_id)}</span>}</span>
        <span className="text-xs font-normal text-muted">{countItems(lib, f.id)}</span>
        {f.system_key && <Lock size={12} className="shrink-0 text-muted" aria-label="Dossier permanent" />}
      </button>
      {!f.system_key && (
        <>
          <button type="button" aria-label={`Renommer le dossier ${f.name}`} title="Renommer" onClick={() => setFolderForm({ id: f.id, name: f.name })} className="rounded p-1 text-muted hover:text-ink"><Pencil size={13} /></button>
          <button type="button" aria-label={`Déplacer le dossier ${f.name}`} title="Déplacer" onClick={() => setMoveForm({ kind: "folder", id: f.id, name: f.name, target: "" })} className="rounded p-1 text-muted hover:text-ink"><FolderInput size={13} /></button>
          <button type="button" aria-label={`Supprimer le dossier ${f.name}`} title="Supprimer" disabled={busy} onClick={() => askRemove(f)} className="rounded p-1 text-muted hover:text-danger"><Trash2 size={13} /></button>
        </>
      )}
    </li>
  );

  const table = (rows: LibraryItem[], showPath: boolean) => (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-left font-label text-xs text-muted"><tr><th className="py-1.5 font-semibold">Nom</th><th className="font-semibold">Type</th><th className="font-semibold">Taille</th><th className="hidden font-semibold md:table-cell">Modifié</th><th /></tr></thead>
        <tbody className="divide-y divide-line">{rows.map((i) => itemRow(i, showPath))}</tbody>
      </table>
    </div>
  );

  return (
    <div onDragOver={(e) => { if (current) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      className={cn("rounded-2xl border bg-white p-4 transition-colors", drag ? "border-violet bg-violet-soft/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Fil d'Ariane" className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm">
          <button type="button" onClick={() => { setQ(""); setFolderId(null); }} className={cn("font-semibold", folderId ? "text-violet-strong hover:underline" : "text-ink")} aria-current={folderId ? undefined : "page"}>Bibliothèque</button>
          {crumbs.map((c, n) => (
            <span key={c.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight size={14} className="shrink-0 text-muted" aria-hidden />
              {n === crumbs.length - 1
                ? <span className="truncate font-semibold text-ink" aria-current="page">{c.name}</span>
                : <button type="button" onClick={() => setFolderId(c.id)} className="truncate font-semibold text-violet-strong hover:underline">{c.name}</button>}
            </span>
          ))}
        </nav>
        <div className="relative">
          <Search size={14} className="absolute top-2.5 left-2.5 text-muted" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher dans toute la bibliothèque" className="w-56 pl-8 sm:w-64" aria-label="Rechercher par nom dans toute la bibliothèque" />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => setFolderForm({ id: null, name: "" })}><FolderPlus size={14} /> Nouveau dossier</Button>
        {current && <Button onClick={() => setPromptForm({ id: null, title: "", content: "" })}><NotebookPen size={14} /> Nouveau prompt</Button>}
        {current && <Button variant="primary" onClick={() => input.current?.click()}><Upload size={14} /> Ajouter des fichiers</Button>}
        <input ref={input} type="file" multiple accept={LIBRARY_ACCEPT} className="hidden" onChange={(e) => { void addFiles(e.target.files ? Array.from(e.target.files) : null); e.target.value = ""; }} />
        {current && !current.system_key && (
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setFolderForm({ id: current.id, name: current.name })}><Pencil size={13} /> Renommer</Button>
            <Button size="sm" variant="ghost" onClick={() => setMoveForm({ kind: "folder", id: current.id, name: current.name, target: "" })}><FolderInput size={13} /> Déplacer</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => askRemove(current)}><Trash2 size={13} /> Supprimer</Button>
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        {current
          ? current.system_key
            ? "Dossier permanent : Claude y lit les documents de chaque diagnostic (sous-dossiers compris). Glissez-déposez vos fichiers ici."
            : "Glissez-déposez vos fichiers ici · PDF, PowerPoint, Word, Excel, HTML, texte ou images · 25 Mo maximum par fichier."
          : "Ouvrez un dossier pour y ajouter des fichiers ou des prompts. Privée : jamais visible du portail client."}
      </p>

      {uploads.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-lg border border-line px-3 py-2 text-sm">
              <div className="flex items-center gap-2"><span className="flex-1 truncate">{u.name}</span>
                {u.error ? <><span className="text-xs text-danger">Échec : {u.error}</span><button type="button" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label={`Retirer ${u.name} de la liste`}><X size={14} /></button></> : <span className="text-xs text-muted">{Math.round(u.progress * 100)} %</span>}
              </div>
              {!u.error && <div className="mt-1 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`Envoi de ${u.name}`} aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div className="progress-bar h-full w-full bg-violet" style={{ transform: `scaleX(${u.progress})` }} /></div>}
            </li>
          ))}
        </ul>
      )}

      {search ? (
        <section className="mt-4" aria-label="Résultats de recherche">
          <h2 className="mb-2 text-sm font-semibold text-ink">{plural(results.folders.length + results.items.length, "résultat")} pour « {search} »</h2>
          {results.folders.length > 0 && <ul className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{results.folders.map((f) => folderCard(f, true))}</ul>}
          {results.items.length > 0 && table(results.items, true)}
          {results.folders.length + results.items.length === 0 && <p className="py-8 text-center text-sm text-muted">Aucun dossier ni élément ne porte ce nom.</p>}
        </section>
      ) : (
        <>
          {subfolders.length > 0 && <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{subfolders.map((f) => folderCard(f, false))}</ul>}
          {current && <div className="mt-4">{items.length > 0 ? table(items, false) : <p className="py-8 text-center text-sm text-muted">{subfolders.length ? "Aucun élément à ce niveau." : "Dossier vide. Ajoutez des fichiers ou créez un prompt."}</p>}</div>}
          {!current && subfolders.length === 0 && <p className="py-8 text-center text-sm text-muted">Aucun dossier pour l&apos;instant.</p>}
        </>
      )}

      <Modal open={!!folderForm} onClose={() => setFolderForm(null)} title={folderForm?.id ? "Renommer le dossier" : current ? `Nouveau dossier dans « ${current.name} »` : "Nouveau dossier"}>
        {folderForm && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void saveFolder(); }}>
            <label className="block text-sm font-semibold text-ink">Nom
              <Input autoFocus value={folderForm.name} onChange={(e) => setFolderForm({ ...folderForm, name: e.target.value })} placeholder="Prompts LinkedIn, Modèles de propositions…" maxLength={MAX_FOLDER_NAME} required className="mt-1" />
            </label>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setFolderForm(null)}>Annuler</Button><Button type="submit" variant="primary" disabled={busy || !folderForm.name.trim()}>{folderForm.id ? "Renommer" : "Créer"}</Button></div>
          </form>
        )}
      </Modal>

      <Modal open={!!promptForm} onClose={() => setPromptForm(null)} title={promptForm?.id ? "Modifier le prompt" : "Nouveau prompt"} wide>
        {promptForm && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void savePrompt(); }}>
            <label className="block text-sm font-semibold text-ink">Titre
              <Input autoFocus={!promptForm.id} value={promptForm.title} onChange={(e) => setPromptForm({ ...promptForm, title: e.target.value })} maxLength={MAX_ITEM_NAME} required className="mt-1" />
            </label>
            <label className="block text-sm font-semibold text-ink">Contenu
              <Textarea rows={16} value={promptForm.content} disabled={promptForm.loading} placeholder={promptForm.loading ? "Chargement…" : "Collez ou rédigez votre prompt"} onChange={(e) => setPromptForm({ ...promptForm, content: e.target.value })} maxLength={MAX_PROMPT_CHARS} className="mt-1 font-mono text-[13px]" />
            </label>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <span className="mr-auto text-xs text-muted">{promptForm.content.length.toLocaleString("fr-FR")} caractères</span>
              <Button variant="ghost" disabled={promptForm.loading || !promptForm.content} onClick={() => copyPrompt(promptForm.id ?? "", promptForm.content)}><Copy size={14} /> Copier</Button>
              <Button variant="ghost" onClick={() => setPromptForm(null)}>Annuler</Button>
              <Button type="submit" variant="primary" disabled={busy || promptForm.loading || !promptForm.title.trim()}>{promptForm.id ? "Enregistrer" : "Créer le prompt"}</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal open={!!moveForm} onClose={() => setMoveForm(null)} title={moveForm ? `Déplacer « ${moveForm.name} »` : "Déplacer"}>
        {moveForm && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submitMove(); }}>
            <Select autoFocus value={moveForm.target} onChange={(e) => setMoveForm({ ...moveForm, target: e.target.value })} aria-label="Destination">
              <option value="" disabled>Choisir la destination…</option>
              {moveTargets.map((t) => <option key={t.id ?? "root"} value={t.id ?? "root"}>{t.label}</option>)}
            </Select>
            {moveForm.kind === "folder" && <p className="text-xs text-muted">Un dossier ne peut pas être rangé dans lui-même ni dans un de ses sous-dossiers.</p>}
            {moveTargets.length === 0 && <p className="text-xs text-muted">Aucune autre destination possible. Créez d&apos;abord un dossier.</p>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setMoveForm(null)}>Annuler</Button><Button type="submit" variant="primary" disabled={busy || !moveForm.target}>Déplacer</Button></div>
          </form>
        )}
      </Modal>

      <Modal open={!!removal} onClose={() => setRemoval(null)} title={removal ? `Supprimer « ${removal.folder.name} » ?` : "Supprimer"}>
        {removal && (
          <div className="space-y-3">
            <p className="text-sm text-ink">
              {removal.counts.items === 0 && removal.counts.folders === 0
                ? "Ce dossier est vide."
                : `Ce dossier contient ${plural(removal.counts.items, "élément")}${removal.counts.folders ? ` et ${plural(removal.counts.folders, "sous-dossier")}` : ""}. Tout sera supprimé.`}
            </p>
            <p className="rounded-lg bg-danger/5 px-3 py-2 text-xs text-danger">Suppression définitive : il n&apos;y a pas encore de corbeille, rien ne pourra être récupéré.</p>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRemoval(null)}>Annuler</Button><Button variant="danger" disabled={busy} onClick={confirmRemove}>{removal.counts.items ? `Supprimer le dossier et ${plural(removal.counts.items, "élément")}` : "Supprimer le dossier"}</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
