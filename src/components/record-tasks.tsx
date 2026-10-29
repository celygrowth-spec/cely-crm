"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createTaskAction, postponeTaskAction, setTaskDoneAction } from "@/app/actions";
import type { Task } from "@/lib/crm/types";
import { addDaysISO, personName, relativeDay, todayISO } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { Badge, Button, Input, Select, cn } from "./ui";

export function RecordTasks({ ctx }: { ctx: RecordCtx }) {
  const { tasks, people, company } = ctx.detail;
  const open = tasks.filter((t) => !t.done_at);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(addDaysISO(todayISO(), 1));
  const [personId, setPersonId] = useState("");
  const [pending, setPending] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await createTaskAction({ company_id: company.id, title, due_date: due, person_id: personId || null });
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    setTitle("");
    await ctx.reload();
  }

  return (
    <div className="space-y-2">
      {open.map((t) => <TaskRow key={t.id} task={t} personLabel={personName(people.find((p) => p.id === t.person_id))} onChanged={ctx.reload} />)}
      {!open.length && <p className="text-sm text-muted">Aucune tâche à faire.</p>}
      <form onSubmit={add} className="flex flex-wrap gap-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Nouvelle tâche, ex. Relancer Paul" className="min-w-48 flex-1" />
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="w-40" required />
        {people.length > 0 && (
          <Select value={personId} onChange={(e) => setPersonId(e.target.value)} className="w-40" aria-label="Personne">
            <option value="">Personne —</option>
            {people.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
          </Select>
        )}
        <Button type="submit" disabled={pending || !title.trim()}><Plus size={14} /> Ajouter</Button>
      </form>
    </div>
  );
}

export function TaskRow({ task, personLabel, companyLabel, onChanged, onOpenCompany }: {
  task: Pick<Task, "id" | "title" | "due_date">;
  personLabel?: string;
  companyLabel?: string;
  onChanged: () => void | Promise<void>;
  onOpenCompany?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const today = todayISO();
  const late = task.due_date < today;

  async function done() {
    setBusy(true);
    const res = await setTaskDoneAction(task.id, true);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success("Tâche terminée", {
      action: { label: "Annuler", onClick: async () => { const r = await setTaskDoneAction(task.id, false); if (!r.ok) toast.error(r.error); await onChanged(); } },
    });
    await onChanged();
  }
  async function postpone(days: number | string) {
    const d = typeof days === "number" ? addDaysISO(today > task.due_date ? today : task.due_date, days) : days;
    const res = await postponeTaskAction(task.id, d);
    if (!res.ok) return toast.error(res.error);
    await onChanged();
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2">
      <input type="checkbox" className="size-4 accent-violet-600" onChange={done} disabled={busy} aria-label="Terminer la tâche" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{task.title}</p>
        <p className="text-xs text-muted">
          {companyLabel && <button onClick={onOpenCompany} className="font-semibold text-ink hover:text-violet-strong">{companyLabel}</button>}
          {companyLabel && personLabel && " · "}
          {personLabel}
        </p>
      </div>
      <Badge tone={late ? "danger" : task.due_date === today ? "violet" : "neutral"} className={cn(late && "font-bold")}>
        {late ? "En retard · " : ""}{relativeDay(task.due_date)}
      </Badge>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" onClick={() => postpone(1)}>+1 j</Button>
        <Button size="sm" variant="ghost" onClick={() => postpone(7)}>+1 sem.</Button>
        <input
          type="date"
          aria-label="Reporter à une date"
          className="h-7 w-8 cursor-pointer rounded-md border border-line text-transparent focus:w-32 focus:text-ink"
          onChange={(e) => e.target.value && postpone(e.target.value)}
        />
      </div>
    </div>
  );
}
