"use client";

// Tâches du projet côté administrateur : création rapide, édition en cellule, visibilité explicite.
import { useState } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Plus } from "lucide-react";
import { createTaskAction, updateTaskAction } from "@/app/projets-actions";
import { EmptyState } from "@/components/ui";
import { cn } from "@/lib/cn";
import { attempt } from "@/lib/client/query";
import { formatDate, formatDateTime } from "@/lib/format";
import { TASK_STATUS_LABELS, TASK_STATUS_STYLES, type AdminTask, type TaskStatus } from "@/lib/projects/types";
import { TaskGrid, type GridColumn } from "@/components/projects/task-grid";
import { TaskFilters, applyTaskFilter, type TaskFilter } from "@/components/projects/task-filters";
import { AdminTaskDrawer } from "@/components/projects/task-drawer";

type Opt = { id: string; name: string };

export function AdminTasks({ projectId, initial, today, members, meetings, initialMeeting, openTask }: {
  projectId: string; initial: AdminTask[]; today: string; members: Opt[]; meetings: { id: string; title: string }[]; initialMeeting: string; openTask: string | null;
}) {
  const [tasks, setTasks] = useState(initial);
  const [filter, setFilter] = useState<TaskFilter>({ status: "open", meeting: initialMeeting });
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(openTask);
  const { rows, counts, late } = applyTaskFilter(tasks, filter, today, (t) => t.meeting_id);

  const assigneeValue = (t: AdminTask) => (t.assignee_kind === "owner" ? "owner" : t.assignee_person_id ?? "team");
  const assigneeLabel = (t: AdminTask) => (t.assignee_kind === "owner" ? "Moi" : t.assignee_person_id ? members.find((m) => m.id === t.assignee_person_id)?.name ?? "Contact" : "Équipe client");

  async function patch(t: AdminTask, p: Partial<AdminTask>) {
    const before = tasks;
    setTasks(tasks.map((x) => (x.id === t.id ? { ...x, ...p } : x))); // mise à jour locale immédiate
    const r = await attempt(() => updateTaskAction(t.id, p as never));
    if (!r.ok) {
      setTasks(before);
      toast.error(r.error);
      return false;
    }
    setTasks((cur) => cur.map((x) => (x.id === t.id ? r.data : x)));
    return true;
  }

  const columns: GridColumn<AdminTask>[] = [
    { key: "title", label: "Tâche", width: 300, value: (t) => t.title, editor: "text", render: (t) => <span className={cn("truncate", t.status === "termine" && "text-muted line-through")}>{t.title}</span> },
    {
      key: "assignee", label: "Responsable", width: 150, value: assigneeValue, editor: "select", sortValue: assigneeLabel,
      options: () => [{ value: "owner", label: "Moi" }, { value: "team", label: "Équipe client" }, ...members.map((m) => ({ value: m.id, label: m.name }))],
      render: assigneeLabel,
    },
    {
      key: "status", label: "Statut", width: 120, value: (t) => t.status, editor: "select",
      options: () => (Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => ({ value: s, label: TASK_STATUS_LABELS[s] })),
      render: (t) => <span className={cn("rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", TASK_STATUS_STYLES[t.status])}>{TASK_STATUS_LABELS[t.status]}</span>,
    },
    {
      key: "due", label: "Échéance", width: 120, value: (t) => t.due_date ?? "", editor: "date",
      render: (t) => t.due_date ? <span className={cn(late(t) && "font-semibold text-warning")}>{formatDate(t.due_date)}</span> : <span className="text-muted/60">—</span>,
    },
    {
      key: "meeting", label: "Point associé", width: 190, value: (t) => t.meeting_id ?? "", editor: "select", sortValue: (t) => meetings.find((m) => m.id === t.meeting_id)?.title ?? "",
      options: () => [{ value: "", label: "Aucun" }, ...meetings.map((m) => ({ value: m.id, label: m.title }))],
      render: (t) => meetings.find((m) => m.id === t.meeting_id)?.title ?? <span className="text-muted/60">—</span>,
    },
    {
      key: "visible", label: "Client", width: 90, value: (t) => (t.visible_to_client ? "1" : "0"), editor: "select", editable: (t) => t.assignee_kind === "owner",
      options: () => [{ value: "1", label: "Visible" }, { value: "0", label: "Interne" }],
      render: (t) => t.visible_to_client ? <span className="inline-flex items-center gap-1 text-violet-strong"><Eye size={13} /> Visible</span> : <span className="inline-flex items-center gap-1 text-muted"><EyeOff size={13} /> Interne</span>,
    },
    { key: "updated", label: "Mise à jour", width: 140, value: (t) => t.updated_at, render: (t) => <span className="text-xs text-muted">{formatDateTime(t.updated_at)}{t.updated_by_kind === "client" && " · client"}</span> },
  ];

  async function commit(t: AdminTask, key: string, value: string) {
    if (key === "title") return value.trim() ? patch(t, { title: value.trim() }) : false;
    if (key === "status") {
      if (value === "bloque") { setOpen(t.id); return patch(t, { status: "bloque", blocked_reason: t.blocked_reason ?? "À préciser" }); }
      return patch(t, { status: value as TaskStatus });
    }
    if (key === "due") return patch(t, { due_date: value || null });
    if (key === "meeting") return patch(t, { meeting_id: value || null });
    if (key === "visible") return patch(t, { visible_to_client: value === "1" });
    if (key === "assignee") {
      return patch(t, value === "owner" ? { assignee_kind: "owner", assignee_person_id: null } : { assignee_kind: "client", assignee_person_id: value === "team" ? null : value, visible_to_client: true });
    }
    return false;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    const r = await attempt(() => createTaskAction(projectId, { title, meeting_id: filter.meeting || null, assignee_kind: "owner", visible_to_client: false }));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    setTasks([...tasks, r.data]);
    setTitle("");
  }

  return (
    <div className="max-w-6xl">
      <TaskFilters value={filter} onChange={setFilter} meetings={meetings} counts={counts} />
      <TaskGrid
        ariaLabel="Tâches du projet"
        rows={rows}
        columns={columns}
        onCommit={commit}
        onOpen={(t) => setOpen(t.id)}
        empty={<div className="p-6"><EmptyState title="Aucune tâche ici" description="Ajoutez une tâche ci-dessous. Par défaut elle est interne ; attribuez-la au client pour qu'il la voie et la fasse avancer." /></div>}
        footer={
          <form onSubmit={add} className="flex items-center gap-2 border-t border-line bg-surface/60 px-2.5 py-1.5">
            <Plus size={14} className="text-muted" />
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} placeholder="Nouvelle tâche (Entrée pour ajouter) — interne par défaut" className="h-8 flex-1 bg-transparent text-sm outline-none" aria-label="Nouvelle tâche" />
          </form>
        }
      />
      <p className="mt-2 text-xs text-muted">Astuce : flèches pour naviguer, Entrée pour modifier, Échap pour annuler. Une date dépassée ne termine jamais une tâche.</p>
      <AdminTaskDrawer
        taskId={open}
        onClose={() => setOpen(null)}
        onChanged={(t) => setTasks((cur) => cur.map((x) => (x.id === t.id ? t : x)))}
        onDeleted={(id) => { setTasks((cur) => cur.filter((x) => x.id !== id)); setOpen(null); }}
      />
    </div>
  );
}
