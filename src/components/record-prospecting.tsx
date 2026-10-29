"use client";

import Link from "next/link";
import { PARTICIPANT_STATUS_LABELS, relativeDay } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { ParticipantActions } from "./participant-actions";
import { Badge } from "./ui";

const statusTone = { a_contacter: "violet", en_cours: "violet", a_repondu: "success", termine: "neutral", arrete: "neutral" } as const;

export function RecordProspecting({ ctx }: { ctx: RecordCtx }) {
  const { participants, people, company } = ctx.detail;
  if (!participants.length) return <p className="text-sm text-muted">Cette fiche ne fait partie d&apos;aucune campagne.</p>;
  return (
    <div className="space-y-2">
      {participants.map((p) => {
        const steps = [...p.campaign.steps].sort((a, b) => a.position - b.position);
        const step = steps.find((s) => s.position === p.current_step);
        return (
          <div key={p.id} className="rounded-lg border border-line px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                <Link href={`/prospection/campagnes/${p.campaign.id}`} className="font-semibold hover:text-violet-strong">{p.campaign.name}</Link>
                <span className="text-muted"> · {step ? `étape ${step.position}/${steps.length} : ${step.name}` : "toutes les étapes réalisées"}</span>
              </p>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone[p.status]}>{PARTICIPANT_STATUS_LABELS[p.status]}</Badge>
                {p.next_due_date && <span className="text-xs text-muted">Relance : {relativeDay(p.next_due_date)}</span>}
              </div>
            </div>
            {p.stop_reason && p.status === "arrete" && <p className="mt-1 text-xs text-muted">{p.stop_reason}</p>}
            {!p.campaign.archived_at && (
              <div className="mt-2">
                <ParticipantActions
                  p={{ ...p, company_name: company.name, steps }}
                  people={people}
                  onChanged={ctx.reload}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
