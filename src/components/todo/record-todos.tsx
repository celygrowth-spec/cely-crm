"use client";

// Fiche › Aperçu : tâches ouvertes de la To do list liées à cette fiche, à cocher sur place.
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { apiGet } from "@/lib/client/query";
import { URGENCY_LABEL, sortOpen, type TodoItem } from "@/lib/todo/types";
import { Badge } from "../ui";
import { TodoCheck } from "./todo-parts";

const TONE = { urgent: "danger", moyen: "warning", pas_urgent: "neutral" } as const;

export function RecordTodos({ companyId }: { companyId: string }) {
  const q = useQuery({
    queryKey: ["company-todo", companyId],
    queryFn: ({ signal }) => apiGet<TodoItem[]>(`/api/todo?fiche=${companyId}`, signal),
  });
  const open = sortOpen((q.data ?? []).filter((t) => !t.done_at));
  if (q.isError) return <p role="alert" className="text-sm text-danger">To do list : {q.error.message}</p>;
  if (!open.length) return null;
  return (
    <section aria-label="To do list" data-record-todos>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="font-label text-xs font-bold tracking-wide text-muted uppercase">To do list · {open.length}</h3>
        <Link href="/productivite/todo" className="text-xs font-semibold text-violet-strong hover:underline">Ouvrir la To do list</Link>
      </div>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {open.map((t) => (
          <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
            <TodoCheck todo={t} />
            <span className="min-w-0 flex-1 truncate">{t.title}</span>
            <Badge tone={TONE[t.urgency]}>{URGENCY_LABEL[t.urgency]}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
