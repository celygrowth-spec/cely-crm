"use client";

// Bibliothèque de fichiers d'un projet, commune au portail et à l'administration. Les droits viennent du
// serveur (canManage par fichier) ; l'interface ne fait que refléter ce qui est autorisé.
import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ChevronRight, Download, Eye, File, FileImage, FileText, Folder, FolderPlus, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { ACCEPT_ATTR, FORMATS_LABEL, MAX_FILE_BYTES, formatBytes, isAllowedType } from "@/lib/crm/file-rules";
import { Button, Input, Modal, Select } from "@/components/ui";

export type LibFolder = { id: string; name: string; parent_id: string | null };
export type LibFile = { id: string; name: string; mime_type: string; size: number; folder_id: string | null; created_at: string; author: string; mine?: boolean };

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type FileAdapter = {
  start: (f: File, folder: string | null) => Promise<Result<{ file_id: string; signedUrl: string }>>;
  confirm: (fileId: string, folder: string | null) => Promise<Result<unknown>>;
  abort: (fileId: string) => Promise<Result<unknown>>;
  url: (id: string, download: boolean) => Promise<Result<{ url: string; preview?: boolean }>>;
  rename: (id: string, name: string) => Promise<Result<unknown>>;
  move: (id: string, folder: string | null) => Promise<Result<unknown>>;
  remove: (id: string) => Promise<Result<unknown>>;
  /** administration uniquement */
  unshare?: (id: string) => Promise<Result<unknown>>;
  createFolder?: (name: string, parent: string | null) => Promise<Result<unknown>>;
  deleteFolder?: (id: string) => Promise<Result<unknown>>;
};

type Upload = { key: string; name: string; progress: number; error?: string };
type Sort = "date" | "name" | "type" | "size";

const iconFor = (t: string) => (t.startsWith("image/") ? FileImage : t === "application/pdf" || t.startsWith("text/") ? FileText : File);
const typeLabel = (t: string) => (t === "application/pdf" ? "PDF" : t.startsWith("image/") ? "Image" : t.includes("word") ? "Word" : t.includes("sheet") || t.includes("excel") || t === "text/csv" ? "Tableur" : t.includes("presentation") || t.includes("powerpoint") ? "Présentation" : t === "application/zip" ? "Archive" : "Texte");

export function FileLibrary({ folders, files, adapter, canUpload, canManage, onChanged, readOnlyNote }: {
  folders: LibFolder[]; files: LibFile[]; adapter: FileAdapter; canUpload: boolean; canManage: (f: LibFile) => boolean; onChanged: () => void; readOnlyNote?: string;
}) {
  const [folder, setFolder] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("date");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string; type: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const current = folders.find((f) => f.id === folder) ?? null;
  const parent = current?.parent_id ? folders.find((f) => f.id === current.parent_id) ?? null : null;
  const subfolders = folders.filter((f) => f.parent_id === folder);
  const search = q.trim().toLowerCase();
  const shown = useMemo(() => {
    const list = files.filter((f) => (search ? f.name.toLowerCase().includes(search) : f.folder_id === folder));
    const by: Record<Sort, (a: LibFile, b: LibFile) => number> = {
      date: (a, b) => b.created_at.localeCompare(a.created_at),
      name: (a, b) => a.name.localeCompare(b.name, "fr", { numeric: true }),
      type: (a, b) => typeLabel(a.mime_type).localeCompare(typeLabel(b.mime_type)) || a.name.localeCompare(b.name),
      size: (a, b) => b.size - a.size,
    };
    return list.sort(by[sort]);
  }, [files, folder, search, sort]);

  const setU = (key: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function uploadOne(file: File) {
    const key = crypto.randomUUID();
    setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
    if (!isAllowedType(file.type)) return setU(key, { error: "Format non autorisé" });
    if (file.size > MAX_FILE_BYTES) return setU(key, { error: "Plus de 25 Mo" });
    const s = await adapter.start(file, folder);
    if (!s.ok) return setU(key, { error: s.error });
    const sent = await new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", s.data.signedUrl);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.upload.onprogress = (e) => e.lengthComputable && setU(key, { progress: e.loaded / e.total });
      xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => resolve(false);
      xhr.send(file);
    });
    if (!sent) {
      await adapter.abort(s.data.file_id); // aucun fichier fantôme
      return setU(key, { error: "Transfert interrompu, réessayez" });
    }
    const c = await adapter.confirm(s.data.file_id, folder);
    if (!c.ok) return setU(key, { error: c.error });
    setUploads((u) => u.filter((x) => x.key !== key));
    onChanged();
  }
  function addFiles(list: FileList | null) {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 20)) void uploadOne(f);
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (canUpload) addFiles(e.dataTransfer.files);
  };

  async function act(p: Promise<Result<unknown>>, msg: string) {
    const r = await p;
    if (!r.ok) return toast.error(r.error);
    toast.success(msg);
    onChanged();
  }
  async function open(f: LibFile, download: boolean) {
    const r = await adapter.url(f.id, download);
    if (!r.ok) return toast.error(r.error);
    if (!download && r.data.preview !== false && (f.mime_type === "application/pdf" || f.mime_type.startsWith("image/"))) setPreview({ url: r.data.url, name: f.name, type: f.mime_type });
    else window.open(r.data.url, "_blank", "noopener,noreferrer");
  }

  return (
    <div onDragOver={(e) => { if (canUpload) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      className={cn("rounded-2xl border bg-white p-4 transition-colors", drag ? "border-violet bg-violet-soft/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Dossiers" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <button type="button" onClick={() => setFolder(null)} className={cn("font-semibold", folder ? "text-violet-strong hover:underline" : "text-ink")}>Tous les fichiers</button>
          {parent && <><ChevronRight size={14} className="text-muted" /><button type="button" onClick={() => setFolder(parent.id)} className="font-semibold text-violet-strong hover:underline">{parent.name}</button></>}
          {current && <><ChevronRight size={14} className="text-muted" /><span className="truncate font-semibold text-ink">{current.name}</span></>}
        </nav>
        <div className="relative">
          <Search size={14} className="absolute top-2.5 left-2.5 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className="w-44 pl-8" aria-label="Rechercher un fichier" />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-36" aria-label="Trier par">
          <option value="date">Plus récents</option><option value="name">Nom</option><option value="type">Type</option><option value="size">Taille</option>
        </Select>
        {adapter.createFolder && (!current || !current.parent_id) && <Button onClick={() => setNewFolder("")}><FolderPlus size={14} /> Dossier</Button>}
        {canUpload && <Button variant="primary" onClick={() => input.current?.click()}><Upload size={14} /> Déposer</Button>}
        <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {readOnlyNote && <p className="mt-2 text-xs text-muted">{readOnlyNote}</p>}
      {canUpload && <p className="mt-2 text-xs text-muted">Glissez-déposez vos fichiers ici · {FORMATS_LABEL}</p>}

      {newFolder !== null && (
        <form className="mt-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (newFolder.trim()) { await act(adapter.createFolder!(newFolder.trim(), folder), "Dossier créé"); setNewFolder(null); } }}>
          <Input autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} placeholder="Nom du dossier" maxLength={80} aria-label="Nom du dossier" className="w-64" />
          <Button type="submit" variant="primary">Créer</Button><Button variant="ghost" onClick={() => setNewFolder(null)}>Annuler</Button>
        </form>
      )}

      {uploads.length > 0 && (
        <ul className="mt-3 space-y-1.5" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.key} className="rounded-lg border border-line px-3 py-2 text-sm">
              <div className="flex items-center gap-2"><span className="flex-1 truncate">{u.name}</span>
                {u.error ? <><span className="text-xs text-danger">{u.error}</span><button type="button" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))} aria-label="Retirer"><X size={14} /></button></> : <span className="text-xs text-muted">{Math.round(u.progress * 100)} %</span>}
              </div>
              {!u.error && <div className="mt-1 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}><div className="progress-bar h-full w-full bg-violet" style={{ transform: `scaleX(${u.progress})` }} /></div>}
            </li>
          ))}
        </ul>
      )}

      {!search && subfolders.length > 0 && (
        <ul className="mt-3 grid gap-2 sm:grid-cols-3">
          {subfolders.map((f) => (
            <li key={f.id} className="flex items-center gap-1 rounded-lg border border-line px-3 py-2 hover:border-violet">
              <button type="button" onClick={() => setFolder(f.id)} className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-ink"><Folder size={16} className="text-violet-strong" /> {f.name}
                <span className="text-xs font-normal text-muted">{files.filter((x) => x.folder_id === f.id).length}</span></button>
              {adapter.deleteFolder && <button type="button" aria-label={`Supprimer le dossier ${f.name}`} title="Supprimer le dossier (les fichiers restent, à la racine)" onClick={() => confirm(`Supprimer le dossier « ${f.name} » ? Les fichiers qu'il contient restent dans le projet.`) && act(adapter.deleteFolder!(f.id), "Dossier supprimé")} className="text-muted hover:text-danger"><Trash2 size={13} /></button>}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left font-label text-xs text-muted"><tr><th className="py-1.5 font-semibold">Nom</th><th className="font-semibold">Type</th><th className="font-semibold">Taille</th><th className="font-semibold">Déposé par</th><th className="font-semibold">Date</th>{search && <th className="font-semibold">Dossier</th>}<th /></tr></thead>
          <tbody className="divide-y divide-line">
            {shown.map((f) => {
              const Icon = iconFor(f.mime_type);
              const manage = canManage(f);
              return (
                <tr key={f.id} className="group">
                  <td className="py-2 pr-2">
                    {renaming?.id === f.id ? (
                      <form className="flex gap-1" onSubmit={async (e) => { e.preventDefault(); await act(adapter.rename(f.id, renaming.name), "Fichier renommé"); setRenaming(null); }}>
                        <Input autoFocus value={renaming.name} maxLength={200} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} className="h-8" aria-label="Nouveau nom" />
                        <Button size="sm" type="submit">OK</Button>
                      </form>
                    ) : (
                      <button type="button" onClick={() => open(f, false)} className="flex items-center gap-2 text-left font-semibold text-ink hover:text-violet-strong"><Icon size={16} className="shrink-0 text-muted" /> <span className="break-all">{f.name}</span></button>
                    )}
                  </td>
                  <td className="text-muted">{typeLabel(f.mime_type)}</td>
                  <td className="text-muted tabular-nums">{formatBytes(f.size)}</td>
                  <td className="text-muted">{f.mine ? "Vous" : f.author}</td>
                  <td className="text-muted">{formatDateTime(f.created_at)}</td>
                  {search && <td className="text-muted">{folders.find((x) => x.id === f.folder_id)?.name ?? "—"}</td>}
                  <td className="py-2 text-right whitespace-nowrap">
                    {(f.mime_type === "application/pdf" || f.mime_type.startsWith("image/")) && <button type="button" onClick={() => open(f, false)} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Aperçu de ${f.name}`}><Eye size={15} /></button>}
                    <button type="button" onClick={() => open(f, true)} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Télécharger ${f.name}`}><Download size={15} /></button>
                    {manage && (
                      <>
                        <button type="button" onClick={() => setRenaming({ id: f.id, name: f.name })} className="rounded p-1.5 text-muted hover:bg-surface hover:text-ink" aria-label={`Renommer ${f.name}`}><Pencil size={14} /></button>
                        {folders.length > 0 && (
                          <select value={f.folder_id ?? ""} onChange={(e) => act(adapter.move(f.id, e.target.value || null), "Fichier déplacé")} className="ml-1 h-7 rounded border border-line bg-white px-1 text-xs" aria-label={`Déplacer ${f.name}`}>
                            <option value="">Racine</option>
                            {folders.map((x) => <option key={x.id} value={x.id}>{x.parent_id ? "— " : ""}{x.name}</option>)}
                          </select>
                        )}
                        {adapter.unshare && <button type="button" onClick={() => confirm(`Retirer « ${f.name} » du projet ? Le document reste dans la fiche CRM.`) && act(adapter.unshare!(f.id), "Retiré du projet")} className="ml-1 rounded px-1.5 py-1 text-xs font-semibold text-muted hover:bg-surface hover:text-ink">Retirer du projet</button>}
                        <button type="button" onClick={() => confirm(adapter.unshare ? `Supprimer définitivement « ${f.name} » ? Il disparaît aussi de la fiche CRM et de tout autre projet.` : `Supprimer votre dépôt « ${f.name} » ?`) && act(adapter.remove(f.id), "Fichier supprimé")} className="rounded p-1.5 text-muted hover:bg-danger/5 hover:text-danger" aria-label={`Supprimer ${f.name}`}><Trash2 size={14} /></button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 && <p className="py-8 text-center text-sm text-muted">{search ? "Aucun fichier ne correspond." : subfolders.length ? "Aucun fichier à ce niveau." : canUpload ? "Aucun fichier pour l'instant. Déposez vos documents ici." : "Aucun fichier partagé pour l'instant."}</p>}
      </div>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? "Aperçu"} wide>
        {preview && (preview.type.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element -- lien temporaire signé, hors optimisation d'images
          ? <img src={preview.url} alt={preview.name} className="mx-auto max-h-[70vh] rounded-lg object-contain" />
          : <iframe src={preview.url} title={preview.name} className="h-[70vh] w-full rounded-lg border border-line" />)}
      </Modal>
    </div>
  );
}
