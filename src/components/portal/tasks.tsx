"use client";

// « Mes tâches » du portail : même tableau que l'administration, mais seules les cellules autorisées par la
// base sont modifiables (statut des tâches attribuées). Les autres tâches visibles sont consultables.
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";
import { TASK_STATUS_LABELS, TASK_STATUS_STYLES, type PortalTask, type TaskStatus } from "@/lib/projects/types";
import { TaskGrid, type GridColumn } from "@/components/projects/task-grid";
import { TaskFilters, applyTaskFilter, type TaskFilter } from "@/components/projects/task-filters";
import { Comments, LinksView } from "@/components/projects/task-drawer";
import { Button, Input, Modal, Skeleton } from "@/components/ui";
import { QueryProvider } from "@/lib/client/query";

/** Lecture du portail : une session expirée renvoie vers la saisie du code (jamais vers la connexion administrateur). */
export async function portalGet<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { accept: "application/json" }, cache: "no-store" });
  const body = await res.json().catch(() => null);
  if (res.status === 401) {
    window.location.replace("/portail");
    throw new Error("Session expirée");
  }
  if (!res.ok) throw new Error(body?.error ?? "Chargement impossible");
  return body as T;
}

async function post(payload: unknown): Promise<{ ok: true; data: PortalTask } | { ok: false; error: string; session?: boolean }> {
  try {
    const res = await fetch("/api/portail/taches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: j.error ?? "Enregistrement impossible", session: j.session === false ? false : undefined };
    return { ok: true, data: j as PortalTask };
  } catch {
    return { ok: false, error: "Connexion impossible : rien n'a été enregistré." };
  }
}

export function PortalTasks(props: { initial: PortalTask[]; today: string; showProject: boolean; meetingFilter?: string }) {
  return <QueryProvider><Inner {...props} /></QueryProvider>;
}

function Inner({ initial, today, showProject, meetingFilter }: { initial: PortalTask[]; today: string; showProject: boolean; meetingFilter?: string }) {
  const [tasks, setTasks] = useState(initial);
  const [filter, setFilter] = useState<TaskFilter>({ status: "open", meeting: meetingFilter ?? "" });
  const [open, setOpen] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<PortalTask | null>(null);
  const meetings = [...new Map(tasks.filter((t) => t.meeting).map((t) => [t.meeting!.id, { id: t.meeting!.id, title: `${t.meeting!.title} · ${formatDate(t.meeting!.starts_at)}` }])).values()];
  const { rows, counts, late } = applyTaskFilter(tasks, filter, today, (t) => t.meeting?.id ?? null);

  async function setStatus(t: PortalTask, status: TaskStatus, reason: string | null = null) {
    const before = tasks;
    setTasks(tasks.map((x) => (x.id === t.id ? { ...x, status, blocked_reason: reason } : x)));
    const r = await post({ op: "status", task: t.id, status, blocked_reason: reason });
    if (!r.ok) {
      setTasks(before);
      toast.error(r.error);
      if (r.session === false) window.location.replace("/portail");
      return false;
    }
    setTasks((cur) => cur.map((x) => (x.id === t.id ? { ...x, ...r.data } : x)));
    toast.success("Enregistré");
    return true;
  }

  const columns: GridColumn<PortalTask>[] = [
    { key: "title", label: "Tâche", width: 280, value: (t) => t.title, render: (t) => <span className={cn("truncate", t.status === "termine" && "text-muted line-through")}>{t.title}</span> },
    ...(showProject ? [{ key: "project", label: "Projet", width: 150, value: (t: PortalTask) => t.project_name }] : []),
    { key: "assignee", label: "Responsable", width: 140, value: (t) => t.assignee.name, render: (t) => <span className={cn(t.assignee.kind === "me" && "font-semibold text-violet-strong")}>{t.assignee.kind === "me" ? "Vous" : t.assignee.name}</span> },
    {
      key: "status", label: "Statut", width: 130, value: (t) => t.status, editor: "select", editable: (t) => t.can_edit,
      options: () => (Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => ({ value: s, label: TASK_STATUS_LABELS[s] })),
      render: (t) => (
        <span className="inline-flex items-center gap-1">
          <span className={cn("rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", TASK_STATUS_STYLES[t.status])}>{TASK_STATUS_LABELS[t.status]}</span>
          {!t.can_edit && <Lock size={11} className="text-muted/70" aria-label="Consultation seule" />}
        </span>
      ),
    },
    { key: "due", label: "Échéance", width: 115, value: (t) => t.due_date ?? "", render: (t) => t.due_date ? <span className={cn(late(t) && "font-semibold text-warning")}>{formatDate(t.due_date)}</span> : <span className="text-muted/60">—</span> },
    { key: "meeting", label: "Point associé", width: 170, value: (t) => t.meeting?.title ?? "", render: (t) => t.meeting ? <Link href={`/portail/p/${t.project_id}/points/${t.meeting.id}`} className="text-violet-strong hover:underline" onClick={(e) => e.stopPropagation()}>{t.meeting.title}</Link> : <span className="text-muted/60">—</span> },
    { key: "updated", label: "Mise à jour", width: 140, value: (t) => t.updated_at, render: (t) => <span className="text-xs text-muted">{formatDateTime(t.updated_at)}</span> },
  ];

  return (
    <div>
      <TaskFilters value={filter} onChange={setFilter} meetings={meetings} counts={counts} />
      {/* mobile : cartes ; écran large : tableau */}
      <ul className="space-y-2 md:hidden">
        {rows.map((t) => (
          <li key={t.id} className="rounded-xl border border-line bg-white p-3">
            <button type="button" className="w-full text-left" onClick={() => setOpen(t.id)}>
              <p className={cn("font-semibold text-ink", t.status === "termine" && "text-muted line-through")}>{t.title}</p>
              <p className="text-xs text-muted">{t.assignee.kind === "me" ? "Vous" : t.assignee.name}{t.due_date && ` · échéance ${formatDate(t.due_date)}`}{showProject && ` · ${t.project_name}`}</p>
            </button>
            <div className="mt-2 flex items-center gap-2">
              {t.can_edit ? (
                <select value={t.status} onChange={(e) => (e.target.value === "bloque" ? setBlocking(t) : setStatus(t, e.target.value as TaskStatus))} className="h-9 rounded-lg border border-line bg-white px-2 text-sm" aria-label={`Statut de ${t.title}`}>
                  {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
                </select>
              ) : <span className={cn("rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", TASK_STATUS_STYLES[t.status])}>{TASK_STATUS_LABELS[t.status]}</span>}
              {late(t) && <span className="text-xs font-semibold text-warning">En retard</span>}
            </div>
          </li>
        ))}
        {rows.length === 0 && <li className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">Rien à afficher avec ce filtre.</li>}
      </ul>
      <div className="hidden md:block">
        <TaskGrid
          ariaLabel="Mes tâches"
          rows={rows}
          columns={columns}
          onOpen={(t) => setOpen(t.id)}
          onCommit={async (t, key, value) => {
            if (key !== "status") return false;
            if (value === "bloque") { setBlocking(t); return false; }
            return setStatus(t, value as TaskStatus);
          }}
          empty={<p className="p-6 text-center text-sm text-muted">Rien à afficher avec ce filtre.</p>}
        />
        <p className="mt-2 text-xs text-muted">Vous pouvez changer le statut des tâches qui vous sont attribuées (flèches, puis Entrée). Les autres sont affichées pour information.</p>
      </div>
      <BlockModal task={blocking} onClose={() => setBlocking(null)} onConfirm={async (t, reason) => { if (await setStatus(t, "bloque", reason)) setBlocking(null); }} />
      <Modal open={!!open} onClose={() => setOpen(null)} title="Tâche" wide>
        {open && <Detail id={open} onStatus={(t, s) => (s === "bloque" ? setBlocking(t) : setStatus(t, s))} />}
      </Modal>
    </div>
  );
}

function BlockModal({ task, onClose, onConfirm }: { task: PortalTask | null; onClose: () => void; onConfirm: (t: PortalTask, reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <Modal open={!!task} onClose={onClose} title="Qu'est-ce qui bloque ?">
      {task && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onConfirm(task, reason.trim()); }}>
          <p className="text-sm text-muted">« {task.title} » — quelques mots suffisent, ils seront visibles par Cely Growth.</p>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Ex. : j'attends la validation de la direction" aria-label="Explication du blocage" />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={onClose}>Annuler</Button><Button type="submit" variant="primary" disabled={!reason.trim()}>Marquer comme bloquée</Button></div>
        </form>
      )}
    </Modal>
  );
}

function Detail({ id, onStatus }: { id: string; onStatus: (t: PortalTask, s: TaskStatus) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["portal-task", id], queryFn: ({ signal }) => portalGet<PortalTask>(`/api/portail/taches/${id}`, signal) });
  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (q.isError || !q.data) return <p className="text-sm text-danger">{q.error?.message ?? "Tâche introuvable."}</p>;
  const t = q.data;
  return (
    <div className="space-y-4">
      <div>
        <p className="font-display text-lg font-bold text-ink">{t.title}</p>
        <p className="text-xs text-muted">{t.project_name} · {t.assignee.kind === "me" ? "attribuée à vous" : `responsable : ${t.assignee.name}`}{t.due_date && ` · échéance ${formatDate(t.due_date)}`}</p>
      </div>
      {t.can_edit ? (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Statut">
          {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => (
            <button key={s} type="button" aria-pressed={t.status === s} onClick={async () => { await onStatus(t, s); void qc.invalidateQueries({ queryKey: ["portal-task", id] }); }} className={cn("rounded-full border px-3 py-1 text-xs font-semibold", t.status === s ? "border-ink bg-ink text-white" : "border-line hover:border-violet")}>
              {TASK_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
      ) : <p className="text-sm"><span className={cn("rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", TASK_STATUS_STYLES[t.status])}>{TASK_STATUS_LABELS[t.status]}</span> <span className="text-xs text-muted">· consultation seule</span></p>}
      {t.status === "bloque" && t.blocked_reason && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-warning">Bloqué : {t.blocked_reason}</p>}
      {t.description && <p className="text-sm whitespace-pre-line text-ink">{t.description}</p>}
      <LinksView links={t.links ?? []} />
      {t.can_edit && <TaskUpload task={t} onDone={() => void qc.invalidateQueries({ queryKey: ["portal-task", id] })} />}
      <Comments comments={t.comments ?? []} onAdd={async (body) => {
        const r = await post({ op: "comment", task: t.id, body });
        if (!r.ok) { toast.error(r.error); return false; }
        void qc.invalidateQueries({ queryKey: ["portal-task", id] });
        return true;
      }} />
    </div>
  );
}

/**
 * Q08 : déposer un fichier directement sur la demande. Le fichier rejoint les documents du projet, rattaché à la
 * tâche ; la demande d'onboarding correspondante passe « répondue » pour Cely Growth.
 */
function TaskUpload({ task, onDone }: { task: PortalTask; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  async function send(file: File) {
    if (file.size > 25 * 1024 * 1024) return toast.error("Fichier trop lourd (25 Mo maximum).");
    setBusy(true);
    const call = async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/portail/fichiers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Dépôt impossible");
      return j;
    };
    try {
      const s = (await call({ op: "start", project: task.project_id, folder: null, task: task.id, name: file.name, type: file.type, size: file.size })) as { file_id: string; signedUrl: string };
      const put = await fetch(s.signedUrl, { method: "PUT", headers: { "content-type": file.type }, body: file });
      if (!put.ok) { await call({ op: "abort", file: s.file_id }).catch(() => undefined); throw new Error("Transfert interrompu, réessayez."); }
      await call({ op: "confirm", file: s.file_id });
      toast.success("Fichier déposé : Cely Growth est prévenu.");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Dépôt impossible");
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:border-violet", busy && "pointer-events-none opacity-50")} data-task-upload>
      {busy ? "Envoi…" : "Déposer un fichier"}
      <input type="file" className="sr-only" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void send(f); }} />
    </label>
  );
}
