"use client";

// Bibliothèque de fichiers d'un projet, commune au portail et à l'administration. Les droits viennent du
// serveur (canManage par fichier, dossiers renvoyés par la base) ; l'interface ne fait que refléter ce qui
// est autorisé. Toute action qui rendrait visible un document interne est confirmée ici ET en base.
import { useMemo, useRef, useState, type DragEvent } from "react";
import { toast } from "sonner";
import { ChevronRight, Download, Eye, EyeOff, File, FileImage, FileText, Folder, FolderPlus, Lock, Pencil, Search, Trash2, Upload, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { ACCEPT_ATTR, FORMATS_LABEL, MAX_FILE_BYTES, formatBytes, isAllowedType } from "@/lib/crm/file-rules";
import { Button, Input, Modal, Select } from "@/components/ui";

/** visible / upload : réglages du dossier (administration) ; côté portail, seuls les dossiers partagés existent. */
export type LibFolder = { id: string; name: string; parent_id: string | null; visible?: boolean; upload?: boolean };
export type LibFile = { id: string; name: string; mime_type: string; size: number; folder_id: string | null; created_at: string; author: string; mine?: boolean; internal?: boolean };

type Result<T> = { ok: true; data: T } | { ok: false; error: string };
/** Réponse d'une action qui peut exposer des documents internes : rien n'est fait tant que ce n'est pas confirmé. */
export type Confirmable = { confirm?: number };

export type FileAdapter = {
  start: (f: File, folder: string | null) => Promise<Result<{ file_id: string; signedUrl: string }>>;
  confirm: (fileId: string, folder: string | null) => Promise<Result<unknown>>;
  abort: (fileId: string) => Promise<Result<unknown>>;
  url: (id: string, download: boolean) => Promise<Result<{ url: string; preview?: boolean }>>;
  rename: (id: string, name: string) => Promise<Result<unknown>>;
  move: (id: string, folder: string | null, confirm: boolean) => Promise<Result<Confirmable>>;
  remove: (id: string) => Promise<Result<unknown>>;
  /** administration uniquement */
  unshare?: (id: string) => Promise<Result<unknown>>;
  saveFolder?: (f: { id: string | null; name: string; parent: string | null; visible: boolean; upload: boolean }, confirm: boolean) => Promise<Result<Confirmable>>;
  deleteFolder?: (id: string, target: string | null, confirm: boolean) => Promise<Result<Confirmable>>;
};

type Upload = { key: string; name: string; progress: number; error?: string };
type Sort = "date" | "name" | "type" | "size";
type FolderForm = { id: string | null; name: string; parent: string | null; visible: boolean; upload: boolean };

const iconFor = (t: string) => (t.startsWith("image/") ? FileImage : t === "application/pdf" || t.startsWith("text/") ? FileText : File);
const typeLabel = (t: string) => (t === "application/pdf" ? "PDF" : t.startsWith("image/") ? "Image" : t.includes("word") ? "Word" : t.includes("sheet") || t.includes("excel") || t === "text/csv" ? "Tableur" : t.includes("presentation") || t.includes("powerpoint") ? "Présentation" : t === "application/zip" ? "Archive" : "Texte");
const plural = (n: number, s: string) => `${n} ${s}${n > 1 ? "s" : ""}`;

/** Dossier visible du client : lui-même et son parent partagés (la racine l'est toujours). */
export function folderVisible(folders: LibFolder[], id: string | null): boolean {
  if (!id) return true;
  const f = folders.find((x) => x.id === id);
  if (!f) return false;
  if (f.visible === false) return false;
  return f.parent_id ? folderVisible(folders, f.parent_id) : true;
}

export function FileLibrary({ folders, files, adapter, canUpload, canManage, onChanged, readOnlyNote }: {
  folders: LibFolder[]; files: LibFile[]; adapter: FileAdapter; canUpload: boolean; canManage: (f: LibFile) => boolean; onChanged: () => void; readOnlyNote?: string;
}) {
  const admin = !!adapter.saveFolder;
  const [folder, setFolder] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("date");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const [preview, setPreview] = useState<{ url: string; name: string; type: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState<FolderForm | null>(null);
  const [removing, setRemoving] = useState<{ folder: LibFolder; target: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const current = folders.find((f) => f.id === folder) ?? null;
  const parent = current?.parent_id ? folders.find((f) => f.id === current.parent_id) ?? null : null;
  const subfolders = folders.filter((f) => f.parent_id === folder);
  // portail : dépôt seulement là où il est ouvert ; administration : partout
  const uploadHere = canUpload && (admin || !current || current.upload !== false);
  const moveTargets = admin ? folders : folders.filter((f) => f.upload !== false);
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
  const countIn = (id: string) => files.filter((x) => x.folder_id === id || folders.some((s) => s.parent_id === id && s.id === x.folder_id)).length;

  const setU = (key: string, p: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...p } : x)));

  async function uploadOne(file: File, target: string | null) {
    const key = crypto.randomUUID();
    setUploads((u) => [...u, { key, name: file.name, progress: 0 }]);
    if (!isAllowedType(file.type)) return setU(key, { error: "Format non autorisé" });
    if (file.size > MAX_FILE_BYTES) return setU(key, { error: "Plus de 25 Mo" });
    const s = await adapter.start(file, target);
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
    const c = await adapter.confirm(s.data.file_id, target);
    if (!c.ok) return setU(key, { error: c.error });
    setUploads((u) => u.filter((x) => x.key !== key));
    onChanged();
  }
  function addFiles(list: FileList | null) {
    if (!list || !uploadHere) return;
    for (const f of Array.from(list).slice(0, 20)) void uploadOne(f, folder);
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    addFiles(e.dataTransfer.files);
  };

  async function act(p: Promise<Result<unknown>>, msg: string) {
    const r = await p;
    if (!r.ok) { toast.error(r.error); return false; }
    toast.success(msg);
    onChanged();
    return true;
  }
  /** Exécute une action ; si elle exposerait des documents internes, demande une confirmation explicite puis la rejoue. */
  async function exposing(run: (confirm: boolean) => Promise<Result<Confirmable>>, question: (n: number) => string, msg: string) {
    const r = await run(false);
    if (!r.ok) { toast.error(r.error); return false; }
    if (r.data.confirm) {
      if (!window.confirm(question(r.data.confirm))) { toast.info("Rien n'a été modifié."); return false; }
      return act(run(true), msg);
    }
    toast.success(msg);
    onChanged();
    return true;
  }
  const exposeQuestion = (n: number) => `${plural(n, "document")} interne${n > 1 ? "s" : ""} deviendr${n > 1 ? "ont" : "a"} visible${n > 1 ? "s" : ""} et téléchargeable${n > 1 ? "s" : ""} par le client. Confirmer ?`;

  async function open(f: LibFile, download: boolean) {
    const r = await adapter.url(f.id, download);
    if (!r.ok) return toast.error(r.error);
    if (!download && r.data.preview !== false && (f.mime_type === "application/pdf" || f.mime_type.startsWith("image/"))) setPreview({ url: r.data.url, name: f.name, type: f.mime_type });
    else window.open(r.data.url, "_blank", "noopener,noreferrer");
  }

  async function submitFolder() {
    if (!form || !form.name.trim() || !adapter.saveFolder) return;
    const ok = await exposing((c) => adapter.saveFolder!({ ...form, name: form.name.trim(), upload: form.visible && form.upload }, c), exposeQuestion, form.id ? "Dossier mis à jour" : "Dossier créé");
    if (ok) setForm(null);
  }
  async function submitRemove() {
    if (!removing || !adapter.deleteFolder) return;
    const target = removing.target === "" ? null : removing.target;
    const ok = await exposing((c) => adapter.deleteFolder!(removing.folder.id, target, c), exposeQuestion, "Dossier supprimé");
    if (ok) {
      if (folder === removing.folder.id || current?.parent_id === removing.folder.id) setFolder(null);
      setRemoving(null);
    }
  }
  function askRemove(f: LibFolder) {
    if (countIn(f.id) === 0) {
      if (confirm(`Supprimer le dossier « ${f.name} » ? Il est vide.`)) void exposing((c) => adapter.deleteFolder!(f.id, null, c), exposeQuestion, "Dossier supprimé");
      return;
    }
    setRemoving({ folder: f, target: "" });
  }
  const folderLabel = (f: LibFolder) => `${f.parent_id ? "— " : ""}${f.name}${admin && !folderVisible(folders, f.id) ? " · interne" : ""}`;

  return (
    <div onDragOver={(e) => { if (uploadHere) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      className={cn("rounded-2xl border bg-white p-4 transition-colors", drag ? "border-violet bg-violet-soft/40" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Chemin" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
          <button type="button" onClick={() => setFolder(null)} className={cn("font-semibold", folder ? "text-violet-strong hover:underline" : "text-ink")} aria-current={folder ? undefined : "page"}>Fichiers</button>
          {parent && <><ChevronRight size={14} className="shrink-0 text-muted" aria-hidden /><button type="button" onClick={() => setFolder(parent.id)} className="truncate font-semibold text-violet-strong hover:underline">{parent.name}</button></>}
          {current && <><ChevronRight size={14} className="shrink-0 text-muted" aria-hidden /><span className="truncate font-semibold text-ink" aria-current="page">{current.name}</span></>}
          {admin && current && <FolderTag visible={folderVisible(folders, current.id)} upload={current.upload} />}
        </nav>
        <div className="relative">
          <Search size={14} className="absolute top-2.5 left-2.5 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className="w-40 pl-8 sm:w-44" aria-label="Rechercher un fichier" />
        </div>
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-36" aria-label="Trier par">
          <option value="date">Plus récents</option><option value="name">Nom</option><option value="type">Type</option><option value="size">Taille</option>
        </Select>
        {admin && current && <Button onClick={() => setForm({ id: current.id, name: current.name, parent: current.parent_id, visible: current.visible !== false, upload: !!current.upload })}><Pencil size={14} /> Dossier</Button>}
        {admin && (!current || !current.parent_id) && (
          <Button onClick={() => setForm({ id: null, name: "", parent: folder, visible: true, upload: false })}><FolderPlus size={14} /> {current ? "Nouveau sous-dossier" : "Nouveau dossier"}</Button>
        )}
        {uploadHere && <Button variant="primary" onClick={() => input.current?.click()}><Upload size={14} /> Déposer{current ? ` dans « ${current.name} »` : ""}</Button>}
        <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {readOnlyNote && <p className="mt-2 text-xs text-muted">{readOnlyNote}</p>}
      {uploadHere ? <p className="mt-2 text-xs text-muted">Glissez-déposez vos fichiers ici · {FORMATS_LABEL}</p>
        : canUpload && current && <p className="mt-2 text-xs text-muted">Ce dossier est en consultation : téléchargez librement, le dépôt n&apos;y est pas ouvert.</p>}

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
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {subfolders.map((f) => (
            <li key={f.id} className="flex items-center gap-1 rounded-lg border border-line px-3 py-2 hover:border-violet">
              <button type="button" onClick={() => setFolder(f.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-semibold text-ink">
                <Folder size={16} className="shrink-0 text-violet-strong" aria-hidden /> <span className="truncate">{f.name}</span>
                <span className="text-xs font-normal text-muted">{countIn(f.id)}</span>
                {!admin && f.upload && <span className="ml-auto shrink-0 rounded-full bg-violet-soft px-1.5 py-0.5 text-[10px] font-semibold text-violet-strong">Dépôt ouvert</span>}
              </button>
              {admin && <FolderTag visible={folderVisible(folders, f.id)} upload={f.upload} compact />}
              {admin && (
                <>
                  <button type="button" aria-label={`Modifier le dossier ${f.name}`} title="Renommer, partage, dépôt" onClick={() => setForm({ id: f.id, name: f.name, parent: f.parent_id, visible: f.visible !== false, upload: !!f.upload })} className="rounded p-1 text-muted hover:text-ink"><Pencil size={13} /></button>
                  <button type="button" aria-label={`Supprimer le dossier ${f.name}`} title="Supprimer le dossier" onClick={() => askRemove(f)} className="rounded p-1 text-muted hover:text-danger"><Trash2 size={13} /></button>
                </>
              )}
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
                      <span className="flex items-center gap-2">
                        <button type="button" onClick={() => open(f, false)} className="flex items-center gap-2 text-left font-semibold text-ink hover:text-violet-strong"><Icon size={16} className="shrink-0 text-muted" /> <span className="break-all">{f.name}</span></button>
                        {admin && f.internal && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-muted" title="Rangé dans un dossier interne : invisible du client"><Lock size={10} aria-hidden /> Interne</span>}
                      </span>
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
                        {moveTargets.length > 0 && (
                          <select value={f.folder_id ?? ""} onChange={async (e) => {
                            const el = e.currentTarget;
                            const target = el.value || null; // lu tout de suite : la liste peut être réinitialisée pendant la confirmation
                            // refus ou erreur : la liste revient à l'emplacement réel du fichier
                            if (!(await exposing((c) => adapter.move(f.id, target, c), exposeQuestion, "Fichier déplacé"))) el.value = f.folder_id ?? "";
                          }} className="ml-1 h-7 max-w-40 rounded border border-line bg-white px-1 text-xs" aria-label={`Déplacer ${f.name}`}>
                            <option value="">Racine du projet</option>
                            {moveTargets.map((x) => <option key={x.id} value={x.id}>{folderLabel(x)}</option>)}
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
        {shown.length === 0 && <p className="py-8 text-center text-sm text-muted">{search ? "Aucun fichier ne correspond." : subfolders.length ? "Aucun fichier à ce niveau." : uploadHere ? "Aucun fichier pour l'instant. Déposez vos documents ici." : current ? "Ce dossier est vide." : "Aucun fichier partagé pour l'instant."}</p>}
      </div>

      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? "Modifier le dossier" : form?.parent ? "Nouveau sous-dossier" : "Nouveau dossier"}>
        {form && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submitFolder(); }}>
            <label className="block text-sm font-semibold text-ink">Nom
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Factures, Contrats, Briefs, Livrables…" maxLength={80} required className="mt-1" />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={form.visible} onChange={(e) => setForm({ ...form, visible: e.target.checked, upload: e.target.checked && form.upload })} />
              <span><span className="font-semibold text-ink">Visible du client</span><br /><span className="text-xs text-muted">Les contacts du projet voient ce dossier et téléchargent ses fichiers. Décoché : dossier interne, jamais visible.</span></span>
            </label>
            <label className={cn("flex items-start gap-2 text-sm", !form.visible && "opacity-50")}>
              <input type="checkbox" className="mt-0.5" disabled={!form.visible} checked={form.visible && form.upload} onChange={(e) => setForm({ ...form, upload: e.target.checked })} />
              <span><span className="font-semibold text-ink">Le client peut y déposer des fichiers</span><br /><span className="text-xs text-muted">Sinon, le dossier est en consultation seule pour lui.</span></span>
            </label>
            {form.parent && !folderVisible(folders, form.parent) && form.visible && <p className="rounded-lg bg-surface px-3 py-2 text-xs text-muted">Le dossier parent est interne : ce sous-dossier restera invisible tant que le parent n&apos;est pas partagé.</p>}
            <p className="text-xs text-muted">Un dossier « Factures » sert seulement à ranger les documents que vous choisissez de partager : il ne donne aucun accès au module Finance.</p>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setForm(null)}>Annuler</Button><Button type="submit" variant="primary">{form.id ? "Enregistrer" : "Créer"}</Button></div>
          </form>
        )}
      </Modal>

      <Modal open={!!removing} onClose={() => setRemoving(null)} title={removing ? `Supprimer « ${removing.folder.name} »` : "Supprimer"}>
        {removing && (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void submitRemove(); }}>
            <p className="text-sm text-ink">Ce dossier contient {plural(countIn(removing.folder.id), "fichier")}{folders.some((s) => s.parent_id === removing.folder.id) ? " (sous-dossier compris)" : ""}. Où les déplacer avant de supprimer le dossier ?</p>
            <Select value={removing.target} onChange={(e) => setRemoving({ ...removing, target: e.target.value })} aria-label="Destination des fichiers">
              <option value="">Racine du projet (visible du client)</option>
              {folders.filter((x) => x.id !== removing.folder.id && x.parent_id !== removing.folder.id).map((x) => <option key={x.id} value={x.id}>{folderLabel(x)}</option>)}
            </Select>
            <p className="text-xs text-muted">Aucun fichier n&apos;est supprimé. Si la destination rend visibles des documents internes, une confirmation vous sera demandée.</p>
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setRemoving(null)}>Annuler</Button><Button type="submit" variant="danger">Déplacer et supprimer</Button></div>
          </form>
        )}
      </Modal>

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? "Aperçu"} wide>
        {preview && (preview.type.startsWith("image/")
          // eslint-disable-next-line @next/next/no-img-element -- lien temporaire signé, hors optimisation d'images
          ? <img src={preview.url} alt={preview.name} className="mx-auto max-h-[70vh] rounded-lg object-contain" />
          : <iframe src={preview.url} title={preview.name} className="h-[70vh] w-full rounded-lg border border-line" />)}
      </Modal>
    </div>
  );
}

function FolderTag({ visible, upload, compact }: { visible: boolean; upload?: boolean; compact?: boolean }) {
  const label = visible ? (upload ? "Visible du client · dépôt ouvert" : "Visible du client") : "Interne";
  return (
    <span title={label} className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", visible ? "bg-violet-soft text-violet-strong" : "bg-surface text-muted")}>
      {visible ? <Eye size={10} aria-hidden /> : <EyeOff size={10} aria-hidden />}
      {compact ? (visible ? (upload ? "Client · dépôt" : "Client") : "Interne") : label}
    </span>
  );
}
