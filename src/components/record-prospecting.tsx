"use client";

// Prospection sur la fiche : participations aux campagnes (même données que la campagne et « Aujourd'hui »).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Zap } from "lucide-react";
import { setDoNotContactAction } from "@/app/prospection-actions";
import { ExecBadge, OutcomeBadge, StepIcon } from "./prospection/bits";
import { relativeDay, todayISO } from "@/lib/format";
import type { StepType } from "@/lib/prospection/steps";
import type { RecordCtx } from "./company-record";
import { Button } from "./ui";

export function RecordProspecting({ ctx }: { ctx: RecordCtx }) {
  const router = useRouter();
  const { participants, company } = ctx.detail;
  const today = todayISO();
  return (
    <div className="space-y-2">
      {company.do_not_contact ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm">
          <Ban size={14} className="text-danger" />
          <span><strong>Ne plus contacter</strong>{company.do_not_contact_reason ? ` : ${company.do_not_contact_reason}` : ""} — aucune nouvelle activation possible.</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={async () => { const r = await setDoNotContactAction(company.id, false); if (!r.ok) return toast.error(r.error); await ctx.reload(); router.refresh(); }}>Retirer</Button>
        </div>
      ) : null}
      {!participants.length && <p className="text-sm text-muted">Cette fiche ne fait partie d&apos;aucune campagne.</p>}
      {participants.map((p) => {
        const steps = p.campaign.steps.filter((s) => (s.version ?? 1) === p.sequence_version).sort((a, b) => a.position - b.position);
        const step = steps.find((s) => s.position === p.current_step);
        const active = p.status === "a_contacter" || p.status === "en_cours";
        return (
          <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            {step?.step_type && <StepIcon type={step.step_type as StepType} size={11} />}
            <Link href={`/prospection/campagnes/${p.campaign.id}/prospects`} className="font-semibold hover:text-violet-strong">{p.campaign.name}</Link>
            <span className="text-xs text-muted">{step ? `étape ${step.position}/${steps.length} : ${step.name}` : "séquence terminée"}</span>
            <ExecBadge status={p.status} />
            <OutcomeBadge outcome={p.outcome} />
            {p.next_due_date && active && <span className={p.next_due_date < today ? "text-xs font-bold text-danger" : "text-xs text-muted"}>{relativeDay(p.next_due_date)}</span>}
            {active && p.campaign.status === "active" && p.next_due_date && p.next_due_date <= today && (
              <Link href={`/prospection/focus?depart=${p.id}`} className="ml-auto inline-flex items-center gap-1 rounded-md bg-ink px-2 py-1 text-xs font-semibold text-white"><Zap size={11} /> Traiter</Link>
            )}
            {p.stop_reason && p.status === "arrete" && <span className="w-full text-xs text-muted">{p.stop_reason}</span>}
          </div>
        );
      })}
      {!company.do_not_contact && (
        <button
          className="text-xs text-muted hover:text-danger"
          onClick={async () => {
            const reason = prompt("Marquer « Ne plus contacter » ? Toute prospection sera arrêtée. Motif (facultatif) :");
            if (reason === null) return;
            const r = await setDoNotContactAction(company.id, true, reason);
            if (!r.ok) return toast.error(r.error);
            toast.success("Marquée « Ne plus contacter »");
            await ctx.reload();
          }}
        >
          Marquer « Ne plus contacter »
        </button>
      )}
    </div>
  );
}
