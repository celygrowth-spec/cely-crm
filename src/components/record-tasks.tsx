"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { createTaskAction, postponeTaskAction, setTaskDoneAction } from "@/app/actions";
import { attempt } from "@/lib/client/query";
import type { Person, Task } from "@/lib/crm/types";
import { addDaysISO, personName, relativeDay, todayISO } from "@/lib/format";
import { Badge, Button, Field, Input, Select, cn } from "./ui";

/** Formulaire de création : ouvert au clic, il se referme une fois la tâche enregistrée. */
export function TaskForm({ companyId, people, onDone }: { companyId: string; people: Person[]; onDone: () => void | Promise<void> }) {
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(addDaysISO(todayISO(), 1));
  const [personId, setPersonId] = useState("");
  const [pending, setPending] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const res = await attempt(() => createTaskAction({ company_id: companyId, title, due_date: due, person_id: personId || null }));
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    await onDone();
  }

  return (
    <form onSubmit={add} className="grid gap-3 sm:grid-cols-2">
      <Field label="Tâche" className="sm:col-span-2">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Relancer Paul" required />
      </Field>
      <Field label="Échéance"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} required /></Field>
      {people.length > 0 && (
        <Field label="Personne">
          <Select value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">—</option>
            {people.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
          </Select>
        </Field>
      )}
      <div className="flex justify-end sm:col-span-2">
        <Button type="submit" variant="primary" disabled={pending || !title.trim()}><Plus size={14} /> Créer la tâche</Button>
      </div>
    </form>
  );
}

/** Terminer ou reporter une tâche : retour visuel immédiat, confirmé ensuite par le serveur. */
export function useTaskActions(task: Pick<Task, "id" | "due_date">, onChanged: () => void | Promise<void>) {
  const [done, setDone] = useState(false);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const today = todayISO();
  const due = movedTo ?? task.due_date;

  async function complete() {
    setDone(true);
    const res = await attempt(() => setTaskDoneAction(task.id, true));
    if (!res.ok) {
      setDone(false);
      return toast.error(res.error, { action: { label: "Réessayer", onClick: complete } });
    }
    toast.success("Tâche terminée", {
      action: { label: "Annuler", onClick: async () => { setDone(false); const r = await attempt(() => setTaskDoneAction(task.id, false)); if (!r.ok) toast.error(r.error); await onChanged(); } },
    });
    await onChanged();
  }
  async function postpone(days: number | string) {
    const d = typeof days === "number" ? addDaysISO(today > due ? today : due, days) : days;
    setMovedTo(d);
    const res = await attempt(() => postponeTaskAction(task.id, d));
    if (!res.ok) {
      setMovedTo(null);
      return toast.error(res.error);
    }
    await onChanged();
  }
  return { done, due, late: due < today, today, complete, postpone };
}

export function PostponeButtons({ onPostpone }: { onPostpone: (days: number | string) => void }) {
  return (
    <div className="flex items-center gap-1">
      <Button size="sm" variant="ghost" onClick={() => onPostpone(1)}>+1 j</Button>
      <Button size="sm" variant="ghost" onClick={() => onPostpone(7)}>+1 sem.</Button>
      <input
        type="date"
        aria-label="Reporter à une date"
        className="h-7 w-8 cursor-pointer rounded-md border border-line text-transparent focus:w-32 focus:text-ink"
        onChange={(e) => e.target.value && onPostpone(e.target.value)}
      />
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
  const { done, due, late, today, complete, postpone } = useTaskActions(task, onChanged);

  return (
    <div className={cn("row-in flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 transition-opacity duration-150", done && "opacity-50")}>
      <input type="checkbox" className="size-4 accent-violet-600" checked={done} onChange={complete} disabled={done} aria-label="Terminer la tâche" />
      <div className="min-w-0 flex-1">
        <p className={cn("line-clamp-2 text-sm font-semibold", done && "line-through")}>{task.title}</p>
        <p className="text-xs text-muted">
          {companyLabel && <button onClick={onOpenCompany} className="font-semibold text-ink hover:text-violet-strong">{companyLabel}</button>}
          {companyLabel && personLabel && " · "}
          {personLabel}
        </p>
      </div>
      <Badge tone={late ? "danger" : due === today ? "violet" : "neutral"} className={cn(late && "font-bold")}>
        {late ? "En retard · " : ""}{relativeDay(due)}
      </Badge>
      <PostponeButtons onPostpone={postpone} />
    </div>
  );
}
