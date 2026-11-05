"use client";

import { cn } from "@/lib/cn";
import { TASK_STATUS_LABELS, type TaskStatus } from "@/lib/projects/types";

export type TaskFilter = { status: TaskStatus | "late" | "open" | "all"; meeting: string };

/** Filtres simples : statut, en retard, point associé. */
export function TaskFilters({ value, onChange, meetings, counts }: {
  value: TaskFilter; onChange: (f: TaskFilter) => void; meetings: { id: string; title: string }[]; counts: Record<string, number>;
}) {
  const chips: { key: TaskFilter["status"]; label: string }[] = [
    { key: "open", label: "Ouvertes" },
    ...(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((k) => ({ key: k, label: TASK_STATUS_LABELS[k] })),
    { key: "late", label: "En retard" },
    { key: "all", label: "Toutes" },
  ];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-pressed={value.status === c.key}
          onClick={() => onChange({ ...value, status: c.key })}
          className={cn("rounded-full border px-3 py-1 text-xs font-semibold", value.status === c.key ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-violet")}
        >
          {c.label} <span className="opacity-60">{counts[c.key] ?? 0}</span>
        </button>
      ))}
      {meetings.length > 0 && (
        <select value={value.meeting} onChange={(e) => onChange({ ...value, meeting: e.target.value })} className="ml-auto h-8 rounded-lg border border-line bg-white px-2 text-xs" aria-label="Point associé">
          <option value="">Tous les points</option>
          {meetings.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
      )}
    </div>
  );
}

export function applyTaskFilter<T extends { status: TaskStatus; due_date: string | null }>(rows: T[], f: TaskFilter, today: string, meetingOf: (t: T) => string | null) {
  const late = (t: T) => t.status !== "termine" && !!t.due_date && t.due_date < today;
  const pass = (t: T, s: TaskFilter["status"]) => s === "all" || (s === "open" ? t.status !== "termine" : s === "late" ? late(t) : t.status === s);
  const counts: Record<string, number> = {};
  for (const s of ["open", "a_faire", "en_cours", "bloque", "termine", "late", "all"] as const) counts[s] = rows.filter((t) => pass(t, s) && (!f.meeting || meetingOf(t) === f.meeting)).length;
  return { rows: rows.filter((t) => pass(t, f.status) && (!f.meeting || meetingOf(t) === f.meeting)), counts, late };
}
