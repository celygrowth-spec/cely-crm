"use client";

import { AlertTriangle } from "lucide-react";
import { Badge, Button } from "./ui";

type Candidate = { company_id: string; name: string; website?: string | null; archived?: boolean; strength: "exact" | "similar"; reasons: string[] };

/** Affiche les fiches candidates, la raison du rapprochement, et laisse décider. */
export function DuplicateNotice({
  candidates,
  onOpen,
  onForce,
  forceLabel = "Ce n'est pas la même entreprise : créer quand même",
  pending,
}: {
  candidates: Candidate[];
  onOpen: (id: string) => void;
  onForce: () => void;
  forceLabel?: string;
  pending?: boolean;
}) {
  const strong = candidates.some((c) => c.strength === "exact");
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
        <AlertTriangle size={16} className="text-warning" />
        {strong ? "Cette entreprise semble déjà exister" : "Fiches ressemblantes à vérifier"}
      </p>
      <ul className="mt-2 space-y-2">
        {candidates.map((c) => (
          <li key={c.company_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white px-3 py-2">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-semibold">
                {c.name}
                <Badge tone={c.strength === "exact" ? "danger" : "warning"}>{c.strength === "exact" ? "Correspondance forte" : "À vérifier"}</Badge>
                {c.archived && <Badge>Archivée</Badge>}
              </p>
              <p className="text-xs text-muted">{c.reasons.join(" · ")}</p>
            </div>
            <Button size="sm" onClick={() => onOpen(c.company_id)}>Ouvrir / compléter</Button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="ghost" onClick={onForce} disabled={pending}>{forceLabel}</Button>
      </div>
    </div>
  );
}
