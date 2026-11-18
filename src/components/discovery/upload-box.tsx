"use client";

// Dépôt de fichiers d'une étape (blacklist, archives LinkedIn, autres documents) : progression visible, reprise après
// coupure, message clair en cas d'échec. Les réponses déjà saisies ne dépendent pas des envois (rien n'est perdu).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileArchive, FileText, RotateCw, Trash2, Upload, WifiOff, X } from "lucide-react";
import { formatBytes } from "@/lib/crm/file-rules";
import { STEP_FILES, acceptedFor, type UploadStep } from "@/lib/discovery/files";
import type { DiscoveryFile } from "@/lib/discovery/types";
import type { FlowApi } from "./flow-api";
import { UploadError, fingerprint, rememberUpload, savedUpload, uploadFile } from "./uploader";
import s from "./flow.module.css";

type Job = { key: string; file: File; account: string | null; sent: number; state: "uploading" | "retrying" | "failed" | "done"; message?: string; retryIn?: number; ctrl: AbortController };

export function UploadBox({ api, projectId, step, files, account, multiple, onChanged, onActive, disabled }: {
  api: FlowApi; projectId: string; step: UploadStep; files: DiscoveryFile[]; account?: string | null; multiple?: boolean;
  onChanged: (uploaded: boolean) => void; onActive?: (active: boolean) => void; disabled?: boolean;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const rules = STEP_FILES[step];
  const active = jobs.some((j) => j.state === "uploading" || j.state === "retrying");

  useEffect(() => { onActive?.(active); }, [active, onActive]);
  // quitter la page pendant un envoi : le navigateur demande confirmation (l'envoi pourra reprendre ensuite)
  useEffect(() => {
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [active]);

  const patch = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  async function run(job: Job) {
    const key = job.key;
    patch(key, { state: "uploading", message: undefined, ctrl: job.ctrl });
    const resumeKey = fingerprint(projectId, step, job.file);
    const saved = savedUpload(resumeKey);
    let t = saved ? await api.fileResume(saved.file_id) : null;
    if (!t || !t.ok) {
      t = await api.fileStart(step, job.file.name, job.file.size, job.account);
      if (!t.ok) return patch(key, { state: "failed", message: t.error });
      rememberUpload(resumeKey, { file_id: t.data.file_id, location: null, at: Date.now() });
    }
    const ticket = t.data;
    try {
      await uploadFile(job.file, ticket, {
        onProgress: (sent) => patch(key, { sent, state: "uploading", retryIn: undefined }),
        onRetry: (_n, delay) => patch(key, { state: "retrying", retryIn: Math.round(delay / 1000) }),
      }, job.ctrl.signal, resumeKey);
    } catch (e) {
      if (e instanceof DOMException) return; // annulé
      const msg = e instanceof UploadError && e.message !== "network" ? e.message : "L'envoi n'a pas abouti (connexion interrompue).";
      return patch(key, { state: "failed", message: `${msg} Tes réponses sont enregistrées ; relance l'envoi, il reprendra où il s'est arrêté.` });
    }
    // confirmation : l'objet doit exister côté stockage ; quelques essais si le réseau hoquette
    for (let i = 0; i < 4; i++) {
      const c = await api.fileConfirm(ticket.file_id);
      if (c.ok) {
        rememberUpload(resumeKey, null);
        patch(key, { state: "done", sent: job.file.size });
        onChanged(true);
        window.setTimeout(() => setJobs((js) => js.filter((j) => j.key !== key)), 1600);
        return;
      }
      if (!c.network) return patch(key, { state: "failed", message: c.error });
      await new Promise((r) => window.setTimeout(r, 1500 * (i + 1)));
    }
    patch(key, { state: "failed", message: "Le fichier est arrivé mais la confirmation a échoué. Réessaie dans un instant." });
  }

  function add(list: FileList | null) {
    setError(null);
    if (!list?.length || disabled) return;
    if (step === "linkedin" && !account?.trim()) return setError("Indique d'abord à qui appartient ce compte LinkedIn.");
    for (const file of Array.from(list).slice(0, multiple ? 10 : 1)) {
      if (!acceptedFor(step, file.name)) { setError(`« ${file.name} » : format non accepté (${rules.label}).`); continue; }
      if (file.size > rules.max) { setError(`« ${file.name} » est trop lourd (${rules.label}).`); continue; }
      if (file.size === 0) { setError(`« ${file.name} » est vide.`); continue; }
      const job: Job = { key: crypto.randomUUID(), file, account: account?.trim() || null, sent: 0, state: "uploading", ctrl: new AbortController() };
      setJobs((js) => [...js, job]);
      void run(job);
    }
    if (input.current) input.current.value = "";
  }

  async function cancel(j: Job) {
    j.ctrl.abort();
    const saved = savedUpload(fingerprint(projectId, step, j.file));
    if (saved) await api.fileAbort(saved.file_id);
    rememberUpload(fingerprint(projectId, step, j.file), null);
    setJobs((js) => js.filter((x) => x.key !== j.key));
  }

  async function remove(f: DiscoveryFile) {
    if (!window.confirm(`Retirer « ${f.name} » de l'onboarding ?`)) return;
    const r = await api.fileRemove(f.id);
    if (!r.ok) return setError(r.error);
    onChanged(false);
  }

  async function download(f: DiscoveryFile) {
    const r = await api.fileUrl(f.id);
    if (!r.ok) return setError(r.error);
    window.location.assign(r.data.url);
  }

  return (
    <div className="space-y-3" data-upload={step}>
      <div
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
        className={`rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-colors ${drag ? "border-violet-500 bg-violet-50" : "border-violet-200 bg-white/70"}`}
      >
        <input ref={input} type="file" className="sr-only" accept={rules.accept} multiple={multiple} onChange={(e) => add(e.target.files)} disabled={disabled} data-upload-input />
        <button type="button" disabled={disabled} onClick={() => input.current?.click()} className="inline-flex items-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-base font-bold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50">
          <Upload size={18} aria-hidden /> {multiple ? "Choisir des fichiers" : "Choisir le fichier"}
        </button>
        <p className="mt-2 text-sm text-muted"><span className="hidden sm:inline">ou glisse-le ici · </span>{rules.label}</p>
      </div>
      {error && <p className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800" role="alert"><AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden /> {error}</p>}

      {jobs.map((j) => {
        const pct = j.file.size ? Math.min(100, Math.round((j.sent / j.file.size) * 100)) : 0;
        return (
          <div key={j.key} className="rounded-xl bg-white p-3 shadow-sm ring-1 ring-violet-100" data-upload-job={j.state}>
            <div className="flex items-center gap-2 text-sm">
              <FileArchive size={16} className="shrink-0 text-violet-600" aria-hidden />
              <span className="min-w-0 flex-1 truncate font-semibold">{j.account ? `${j.account} · ` : ""}{j.file.name}</span>
              <span className="shrink-0 text-xs text-muted tabular-nums">{formatBytes(j.sent)} / {formatBytes(j.file.size)}</span>
              {j.state !== "done" && <button type="button" onClick={() => cancel(j)} className="rounded p-1 text-muted hover:bg-surface" aria-label="Annuler l'envoi"><X size={14} /></button>}
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-violet-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Envoi de ${j.file.name}`}>
              <div className={`${s.progress} h-full rounded-full ${j.state === "failed" ? "bg-red-400" : j.state === "retrying" ? "bg-amber-400" : j.state === "done" ? "bg-emerald-500" : "bg-violet-600"}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1.5 text-xs text-muted" aria-live="polite">
              {j.state === "uploading" && <>{pct} % · garde cette page ouverte</>}
              {j.state === "retrying" && <span className={`${s.pulse} inline-flex items-center gap-1 text-amber-700`}><WifiOff size={12} aria-hidden /> Connexion perdue : je reprends {j.retryIn ? `dans ${j.retryIn} s` : "dès son retour"}, sans repartir de zéro.</span>}
              {j.state === "done" && <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} aria-hidden /> Reçu !</span>}
              {j.state === "failed" && (
                <span className="flex flex-wrap items-center gap-2 text-red-700" role="alert">
                  {j.message}
                  <button type="button" onClick={() => { const job = { ...j, ctrl: new AbortController() }; setJobs((js) => js.map((x) => (x.key === j.key ? job : x))); void run(job); }}
                    className="inline-flex items-center gap-1 rounded-lg bg-red-100 px-2 py-1 font-semibold hover:bg-red-200" data-upload-retry>
                    <RotateCw size={12} aria-hidden /> Reprendre l&apos;envoi
                  </button>
                </span>
              )}
            </p>
          </div>
        );
      })}

      {files.length > 0 && (
        <ul className="space-y-1.5" data-upload-files>
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm">
              <CheckCircle2 size={16} className="shrink-0 text-emerald-600" aria-hidden />
              <button type="button" onClick={() => download(f)} className="min-w-0 flex-1 truncate text-left font-semibold hover:underline" title="Télécharger">
                {f.account ? `${f.account} · ` : ""}{f.name}
              </button>
              <span className="shrink-0 text-xs text-muted">{formatBytes(f.size)}{f.mine === false && f.by ? ` · ${f.by}` : ""}</span>
              {f.mine && !disabled && <button type="button" onClick={() => remove(f)} className="rounded p-1 text-muted hover:bg-white" aria-label={`Retirer ${f.name}`}><Trash2 size={14} /></button>}
              {!f.mine && <FileText size={14} className="shrink-0 text-muted" aria-hidden />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
