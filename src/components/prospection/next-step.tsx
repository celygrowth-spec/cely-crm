"use client";

// Suite après « Intéressé » ou « RDV obtenu » (Q04) : la fiche ne doit jamais sortir de toutes les listes.
// Trois choix : un élément de la To do list relié à la fiche (par défaut), une étape du pipeline, ou un rendez-vous déjà
// planifié (la base vérifie alors qu'il existe un rendez-vous à venir ou une To do ouverte, sinon elle refuse en expliquant).
import type { NextStep } from "@/lib/prospection/service";
import { useCrm } from "../app-shell";
import { Field, Input, Select, cn } from "../ui";

export type NextChoice = { mode: "task" | "stage" | "existing"; stage: string; title: string };

export function defaultNext(outcome: "interested" | "meeting", companyName: string): NextChoice {
  return outcome === "meeting"
    ? { mode: "task", stage: "", title: `Préparer le rendez-vous avec ${companyName}` }
    : { mode: "task", stage: "", title: `Relancer ${companyName}` };
}

export const toNextStep = (c: NextChoice): NextStep | null =>
  c.mode === "task" ? { task: { title: c.title } } : c.mode === "stage" && c.stage ? { stage_id: c.stage } : null;

export function NextStepFields({ value, onChange, outcome }: { value: NextChoice; onChange: (c: NextChoice) => void; outcome: "interested" | "meeting" }) {
  const { pipelines } = useCrm();
  const modes = [
    ["task", "To do list"],
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
        <Field label="À ajouter à la To do list"><Input value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} maxLength={300} aria-label="Élément de To do list" /></Field>
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
        <p className="text-xs text-muted">Accepté seulement si la fiche a déjà un rendez-vous à venir, une To do ouverte ou une étape de pipeline.</p>
      )}
    </fieldset>
  );
}
