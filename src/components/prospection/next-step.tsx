"use client";

// Suite après « Intéressé » ou « RDV obtenu » (Q04) : la fiche ne doit jamais sortir de toutes les listes.
// Trois choix : une tâche de suivi (par défaut), une étape du pipeline, ou un rendez-vous déjà planifié (la base
// vérifie alors qu'il existe un rendez-vous à venir ou une tâche ouverte, sinon elle refuse avec une explication).
import { addDaysISO, todayISO } from "@/lib/format";
import type { NextStep } from "@/lib/prospection/service";
import { useCrm } from "../app-shell";
import { Field, Input, Select, cn } from "../ui";

export type NextChoice = { mode: "task" | "stage" | "existing"; stage: string; title: string; due: string };

export function defaultNext(outcome: "interested" | "meeting", companyName: string): NextChoice {
  return outcome === "meeting"
    ? { mode: "task", stage: "", title: `Préparer le rendez-vous avec ${companyName}`, due: addDaysISO(todayISO(), 1) }
    : { mode: "task", stage: "", title: `Relancer ${companyName}`, due: addDaysISO(todayISO(), 3) };
}

export const toNextStep = (c: NextChoice): NextStep | null =>
  c.mode === "task" ? { task: { title: c.title, due_date: c.due } } : c.mode === "stage" && c.stage ? { stage_id: c.stage } : null;

export function NextStepFields({ value, onChange, outcome }: { value: NextChoice; onChange: (c: NextChoice) => void; outcome: "interested" | "meeting" }) {
  const { pipelines } = useCrm();
  const modes = [
    ["task", "Tâche de suivi"],
    ["stage", "Étape du pipeline"],
    ["existing", outcome === "meeting" ? "Rendez-vous déjà planifié" : "Suite déjà prévue"],
  ] as const;
  return (
    <fieldset className="space-y-2 rounded-lg border border-line p-2" data-next-step>
      <legend className="px-1 font-label text-xs font-semibold text-muted">Et ensuite ?</legend>
      <div role="radiogroup" aria-label="Suite" className="flex flex-wrap gap-1">
        {modes.map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={value.mode === k} onClick={() => onChange({ ...value, mode: k })}
            className={cn("rounded-md border px-2 py-1 text-xs", value.mode === k ? "border-violet bg-violet-soft font-semibold" : "border-line")}>{l}</button>
        ))}
      </div>
      {value.mode === "task" && (
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Field label="Tâche"><Input value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} maxLength={300} aria-label="Tâche de suivi" /></Field>
          <Field label="Pour le"><Input type="date" value={value.due} onChange={(e) => onChange({ ...value, due: e.target.value })} aria-label="Échéance de la tâche" /></Field>
        </div>
      )}
      {value.mode === "stage" && (
        <Select value={value.stage} onChange={(e) => onChange({ ...value, stage: e.target.value })} className="h-8 text-xs" aria-label="Pipeline et étape">
          <option value="">Choisir une étape…</option>
          {pipelines.map((pl) => (
            <optgroup key={pl.id} label={pl.name}>
              {pl.stages.map((s) => <option key={s.id} value={s.id}>{pl.name} › {s.name}</option>)}
            </optgroup>
          ))}
        </Select>
      )}
      {value.mode === "existing" && (
        <p className="text-xs text-muted">Accepté seulement si la fiche a déjà un rendez-vous à venir, une tâche ouverte ou une étape de pipeline.</p>
      )}
    </fieldset>
  );
}
