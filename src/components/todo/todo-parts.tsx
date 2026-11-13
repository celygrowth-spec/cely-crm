"use client";

// To do list : éléments partagés entre la page Productivité › To do list et la fiche (cache, coche, urgence, fiche liée).
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { updateTodoAction } from "@/app/todo-actions";
import { attempt } from "@/lib/client/query";
import { URGENCIES, URGENCY_LABEL, type TodoItem, type Urgency } from "@/lib/todo/types";
import { useCrm } from "../app-shell";
import { cn } from "../ui";

/** Clé du cache : toute la liste ; les tâches d'une fiche sont sous ["todo", "fiche", id]. */
export const TODO_KEY = ["todo"] as const;

export const URGENCY_STYLE: Record<Urgency, string> = {
  urgent: "border-danger/30 bg-danger/10 text-danger",
  moyen: "border-amber-200 bg-amber-50 text-warning",
  pas_urgent: "border-line bg-surface text-muted",
};

/** Enregistre une modification ; met le cache à jour seulement après la réponse de la base (jamais de faux succès). */
export function useTodoUpdate() {
  const qc = useQueryClient();
  return async (id: string, patch: Parameters<typeof updateTodoAction>[1]) => {
    const r = await attempt(() => updateTodoAction(id, patch));
    if (!r.ok) {
      toast.error(r.error);
      return null;
    }
    qc.setQueryData<TodoItem[]>(TODO_KEY, (old) => old?.map((t) => (t.id === id ? r.data : t)));
    qc.invalidateQueries({ queryKey: TODO_KEY });
    qc.invalidateQueries({ queryKey: ["company-todo"] });
    return r.data;
  };
}

/** Case à cocher : termine ou rouvre la tâche. Désactivée pendant l'enregistrement (double clic sans effet). */
export function TodoCheck({ todo, onDone }: { todo: TodoItem; onDone?: (t: TodoItem) => void }) {
  const update = useTodoUpdate();
  const [busy, setBusy] = useState(false);
  const done = !!todo.done_at;
  return (
    <input
      type="checkbox"
      checked={done}
      disabled={busy}
      aria-label={done ? `Rouvrir « ${todo.title} »` : `Terminer « ${todo.title} »`}
      className="size-4 shrink-0 cursor-pointer accent-violet-strong disabled:cursor-wait"
      onChange={async () => {
        if (busy) return;
        setBusy(true);
        const r = await update(todo.id, { done: !done });
        setBusy(false);
        if (r) {
          onDone?.(r);
          toast.success(done ? "Tâche rouverte" : "Tâche terminée");
        }
      }}
    />
  );
}

export function UrgencySelect({ value, onChange, disabled, className, label = "Urgence" }: { value: Urgency; onChange: (u: Urgency) => void; disabled?: boolean; className?: string; label?: string }) {
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value as Urgency)}
      className={cn("h-7 shrink-0 rounded-full border px-2 font-label text-[11px] font-semibold focus:ring-2 focus:ring-violet/20 focus:outline-none", URGENCY_STYLE[value], className)}
    >
      {URGENCIES.map((u) => <option key={u} value={u}>{URGENCY_LABEL[u]}</option>)}
    </select>
  );
}

/** Nom de la fiche liée, cliquable : ouvre la fiche. Fiche à la corbeille : nom illisible, signalé sans lien. */
export function CompanyLink({ todo }: { todo: TodoItem }) {
  const { openCompany, prefetchCompany } = useCrm();
  if (!todo.company_id) return null;
  if (!todo.company_name) return <span className="text-xs text-muted italic">Fiche à la corbeille</span>;
  return (
    <button
      type="button"
      onClick={() => openCompany(todo.company_id!, { name: todo.company_name! })}
      onMouseEnter={() => prefetchCompany(todo.company_id!)}
      className="max-w-48 truncate text-xs font-semibold text-violet-strong hover:underline"
      title={`Ouvrir la fiche ${todo.company_name}`}
    >
      {todo.company_name}
      {todo.company_archived && <span className="ml-1 font-normal text-muted">(archivée)</span>}
    </button>
  );
}
