"use client";

// Fichiers de la fiche. Les envois vont directement du navigateur vers le stockage privé (URL signée),
// sans passer par le serveur Next ; ils continuent si l'on ferme la fiche ou change d'écran.
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, Eye, File as FileIcon, FileImage, FileSpreadsheet, FileText, Loader2, Pencil, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { deleteFileAction, updateFileAction } from "@/app/actions";
import { apiGet, attempt } from "@/lib/client/query";
import type { CompanyFile } from "@/lib/crm/files";
import { ACCEPT_ATTR, FILE_CATEGORIES, FORMATS_LABEL, MAX_FILE_BYTES, formatBytes, isAllowedType, isPreviewable } from "@/lib/crm/file-rules";
import { formatDate } from "@/lib/format";
import { Button, Input, Modal, Select, Skeleton, cn } from "./ui";

// ---------------------------------------------------------------------------
// File d'envoi : indépendante de l'affichage de la fiche
// ---------------------------------------------------------------------------

type Upload = { key: string; companyId: string; file: File; progress: number; state: "uploading" | "error"; error?: string; xhr?: XMLHttpRequest; fileId?: string };
let uploads: Upload[] = [];
const listeners = new Set<() => void>();
const emit = () => { uploads = [...uploads]; listeners.forEach((l) => l()); };
const set = (key: string, patch: Partial<Upload>) => { uploads = uploads.map((u) => (u.key === key ? { ...u, ...patch } : u)); emit(); };
const remove = (key: string) => { uploads = uploads.filter((u) => u.key !== key); emit(); };
const useUploads = (companyId: string) => {
  const all = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => uploads, () => uploads);
  return all.filter((u) => u.companyId === companyId);
};

type OpResult<T> = { ok: true; data: T } | { ok: false; error: string };
function fileOp<T>(body: Record<string, unknown>): Promise<OpResult<T>> {
  return attempt(async () => {
    const res = await fetch("/api/files", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as OpResult<T>;
  });
}

function fail(key: string, message: string) {
  set(key, { state: "error", error: message, progress: 0, xhr: undefined });
}

async function runUpload(key: string, qc: QueryClient) {
  const u = uploads.find((x) => x.key === key);
  if (!u) return;
  set(key, { state: "uploading", progress: 0, error: undefined });
  const start = await fileOp<{ id: string; signedUrl: string }>({ op: "start", companyId: u.companyId, name: u.file.name, type: u.file.type, size: u.file.size });
  if (!start.ok) return fail(key, start.error);
  const fileId = start.data.id;
  // annulé pendant la préparation : rien ne doit partir ni rester en attente
  if (!uploads.some((x) => x.key === key)) {
    await fileOp({ op: "abort", id: fileId });
    return;
  }
  set(key, { fileId });

  const sent = await new Promise<boolean>((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", start.data.signedUrl);
    xhr.setRequestHeader("Content-Type", u.file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && set(key, { progress: e.loaded / e.total });
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    set(key, { xhr });
    xhr.send(u.file);
  });
  if (!sent) {
    // pas de pièce jointe fantôme : la ligne « en attente » et l'éventuel objet partiel sont retirés
    await fileOp({ op: "abort", id: fileId });
    if (uploads.some((x) => x.key === key)) fail(key, "Transfert interrompu. Vérifiez votre connexion puis réessayez.");
    return;
  }
  const done = await fileOp<CompanyFile>({ op: "confirm", id: fileId });
  if (!done.ok) {
    await fileOp({ op: "abort", id: fileId });
    return fail(key, done.error);
  }
  remove(key);
  qc.setQueryData<CompanyFile[]>(["company-files", u.companyId], (l) => [done.data, ...(l ?? [])]);
}

function enqueue(companyId: string, files: File[], qc: QueryClient) {
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) { toast.error(`« ${file.name} » dépasse 25 Mo.`); continue; }
    if (!isAllowedType(file.type)) { toast.error(`« ${file.name} » : format non autorisé.`); continue; }
    const key = crypto.randomUUID();
    uploads = [...uploads, { key, companyId, file, progress: 0, state: "uploading" }];
    emit();
    runUpload(key, qc);
  }
}

// ---------------------------------------------------------------------------
// Section de la fiche
// ---------------------------------------------------------------------------

export function RecordFiles({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const key = ["company-files", companyId];
  const { data: files, isLoading, isError, error, refetch } = useQuery({ queryKey: key, queryFn: ({ signal }) => apiGet<CompanyFile[]>(`/api/fiches/${companyId}/files`, signal) });
  const pending = useUploads(companyId);
  const [over, setOver] = useState(false);
  const [preview, setPreview] = useState<{ name: string; type: string; url: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); enqueue(companyId, [...e.dataTransfer.files], qc); }}
      className={cn("rounded-xl border border-dashed p-2 transition-colors", over ? "border-violet bg-violet-soft/50" : "border-line")}
    >
      <div className="flex flex-wrap items-center gap-2 px-1 py-1">
        <Button size="sm" onClick={() => input.current?.click()}><Upload size={13} /> Ajouter des fichiers</Button>
        <span className="text-xs text-muted">ou déposez-les ici · {FORMATS_LABEL}</span>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT_ATTR}
          className="sr-only"
          onChange={(e) => { enqueue(companyId, [...(e.target.files ?? [])], qc); e.target.value = ""; }}
        />
      </div>

      {isLoading && <Skeleton className="mt-1 h-12 w-full" />}
      {isError && <p className="px-1 py-2 text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>}

      <ul className="space-y-1">
        {pending.map((u) => (
          <li key={u.key} className="row-in rounded-lg bg-surface px-2 py-1.5 text-sm">
            <div className="flex items-center gap-2">
              {u.state === "error" ? <AlertTriangle size={14} className="text-danger" /> : <Loader2 size={14} className="animate-spin text-violet" />}
              <span className="min-w-0 flex-1 truncate">{u.file.name}</span>
              <span className="text-xs text-muted">{formatBytes(u.file.size)}</span>
              {u.state === "error" && <Button size="sm" onClick={() => runUpload(u.key, qc)}><RotateCcw size={12} /> Réessayer</Button>}
              <Button
                size="sm"
                variant="ghost"
                aria-label="Annuler ce transfert"
                onClick={() => {
                  u.xhr?.abort();
                  remove(u.key);
                }}
              >
                <X size={12} />
              </Button>
            </div>
            {u.state === "uploading" && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(u.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                <div className="progress-bar h-full w-full bg-violet" style={{ transform: `scaleX(${u.progress})` }} />
              </div>
            )}
            {u.error && <p className="mt-0.5 text-xs text-danger">{u.error}</p>}
          </li>
        ))}
        {files?.map((f) => <FileRow key={f.id} file={f} companyId={companyId} onPreview={setPreview} />)}
      </ul>
      {files && !files.length && !pending.length && <p className="px-1 py-2 text-sm text-muted">Aucun fichier sur cette fiche.</p>}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? "Aperçu"} wide>
        {preview && (preview.type === "application/pdf" ? (
          <iframe src={preview.url} title={preview.name} className="h-[70vh] w-full rounded-lg border border-line" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- URL signée temporaire, hors optimisation d'images
          <img src={preview.url} alt={preview.name} className="mx-auto max-h-[70vh] rounded-lg" loading="lazy" />
        ))}
      </Modal>
    </div>
  );
}

function KindIcon({ type: t }: { type: string }) {
  const cls = "shrink-0 text-violet-strong";
  if (t.startsWith("image/")) return <FileImage size={16} className={cls} aria-hidden />;
  if (t === "application/pdf" || t.includes("word") || t === "text/plain") return <FileText size={16} className={cls} aria-hidden />;
  if (t.includes("sheet") || t.includes("excel") || t === "text/csv") return <FileSpreadsheet size={16} className={cls} aria-hidden />;
  return <FileIcon size={16} className={cls} aria-hidden />;
}

function FileRow({ file: f, companyId, onPreview }: { file: CompanyFile; companyId: string; onPreview: (p: { name: string; type: string; url: string }) => void }) {
  const qc = useQueryClient();
  const key = ["company-files", companyId];
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(f.display_name);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const patchLocal = (p: Partial<CompanyFile>) => qc.setQueryData<CompanyFile[]>(key, (l) => l?.map((x) => (x.id === f.id ? { ...x, ...p } : x)));

  async function save(p: { display_name?: string; category?: string | null }) {
    const before = f;
    patchLocal(p as Partial<CompanyFile>);
    const r = await attempt(() => updateFileAction(f.id, p));
    if (!r.ok) {
      patchLocal(before);
      toast.error(r.error, { action: { label: "Réessayer", onClick: () => save(p) } });
    }
  }
  async function open(download: boolean) {
    setBusy(true);
    const r = await fileOp<string>({ op: "url", id: f.id, download });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    if (!download && isPreviewable(f.mime_type)) onPreview({ name: f.display_name, type: f.mime_type, url: r.data });
    else window.location.href = r.data;
  }
  async function del() {
    setBusy(true);
    const r = await attempt(() => deleteFileAction(f.id));
    setBusy(false);
    if (!r.ok) {
      patchLocal({ status: "deleting" });
      setConfirming(false);
      return toast.error(r.error, { action: { label: "Réessayer", onClick: del } });
    }
    qc.setQueryData<CompanyFile[]>(key, (l) => l?.filter((x) => x.id !== f.id));
    toast.success("Fichier supprimé");
  }

  return (
    <li className="row-in rounded-lg px-2 py-1.5 hover:bg-surface">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <KindIcon type={f.mime_type} />
        {editing ? (
          <form
            className="flex min-w-40 flex-1 gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(false);
              if (name.trim() && name !== f.display_name) save({ display_name: name });
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7" autoFocus aria-label="Nom d'affichage" onKeyDown={(e) => e.key === "Escape" && setEditing(false)} />
            <Button size="sm" type="submit">OK</Button>
          </form>
        ) : (
          <button className="min-w-0 flex-1 truncate text-left font-semibold hover:text-violet-strong" onClick={() => open(false)} title={isPreviewable(f.mime_type) ? "Aperçu" : "Télécharger"}>
            {f.display_name}
          </button>
        )}
        <span className="text-xs text-muted">{formatBytes(f.size_bytes)} · {formatDate(f.created_at)}</span>
        <Select value={f.category ?? ""} onChange={(e) => save({ category: e.target.value || null })} className="h-7 w-auto text-xs" aria-label="Catégorie">
          <option value="">Catégorie</option>
          {FILE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <div className="flex">
          {isPreviewable(f.mime_type) && <Button size="sm" variant="ghost" onClick={() => open(false)} disabled={busy} aria-label="Aperçu"><Eye size={13} /></Button>}
          <Button size="sm" variant="ghost" onClick={() => open(true)} disabled={busy} aria-label="Télécharger"><Download size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={() => { setName(f.display_name); setEditing(true); }} aria-label="Renommer"><Pencil size={13} /></Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(true)} aria-label="Supprimer"><Trash2 size={13} /></Button>
        </div>
      </div>
      {f.status === "deleting" && !confirming && (
        <p className="mt-1 flex items-center gap-2 text-xs text-danger">
          Suppression inachevée. <button className="underline" onClick={del}>Réessayer</button>
        </p>
      )}
      {confirming && (
        <div className="mt-1 flex flex-wrap items-center gap-2 rounded-md bg-danger/5 px-2 py-1 text-xs">
          Supprimer définitivement « {f.display_name} » ?
          <Button size="sm" variant="danger" disabled={busy} onClick={del}>Supprimer</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Annuler</Button>
        </div>
      )}
    </li>
  );
}
