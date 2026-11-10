"use client";

// Dans un projet issu d'une vente : l'onboarding se fait ici. Même état que la carte Ventes (un seul état partagé),
// éléments à compléter avec le bon écran, slides d'onboarding confiées à Claude quand tout est prêt.
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Check, Circle, ExternalLink, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { retryPrepAction, setSaleStageAction } from "@/app/sales-actions";
import { attempt } from "@/lib/client/query";
import { claudeLink } from "@/lib/crm/diagnostic-rules";
import { STAGES, STAGE_LABELS, missingItems, onboardingPrompt, type SaleRow, type SaleStage } from "@/lib/sales/rules";
import { Button, cn } from "@/components/ui";
import { useSaleSync, useSale } from "./win-sale";

export function ProjectSalePanel({ projectId, companyId }: { projectId: string; companyId: string }) {
  const sale = useSale(companyId);
  const r = sale.data;
  if (!r || !r.sale_id || r.project_id !== projectId || r.sale_state !== "won" || !r.stage || r.stage === "termine") return null;
  return <Panel r={r} projectId={projectId} />;
}

function Panel({ r, projectId }: { r: SaleRow; projectId: string }) {
  const saleSync = useSaleSync();
  const [busy, setBusy] = useState(false);
  const items = r.prep?.items ?? [];
  const missing = missingItems(r);
  const preparing = r.prep_state === "pending" || r.prep_state === "running";

  async function act(fn: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string) {
    setBusy(true);
    const res = await attempt(fn);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error);
    saleSync(r.company_id);
    toast.success(done);
  }
  const stage = (s: SaleStage) => act(() => setSaleStageAction(r.sale_id!, s), `Suivi : ${STAGE_LABELS[s]}`);

  return (
    <section className="mb-4 rounded-xl border border-violet-line bg-violet-soft/40 p-3" aria-label="Onboarding de la vente" data-project-sale>
      <div className="flex flex-wrap items-center gap-1.5">
        <ol className="flex flex-wrap items-center gap-1" aria-label="Suivi de la vente">
          {STAGES.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              {i > 0 && <span className="text-xs text-muted" aria-hidden>›</span>}
              <span aria-current={r.stage === s.key ? "step" : undefined} className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", r.stage === s.key ? "bg-ink text-white" : "text-muted")}>{s.label}</span>
            </li>
          ))}
        </ol>
        <Link href="/ventes" className="ml-auto text-xs font-semibold text-violet-strong hover:underline">Voir dans Ventes</Link>
      </div>

      {preparing ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-muted"><Loader2 size={14} className="animate-spin" /> Préparation à partir de la proposition, de Fireflies et du diagnostic…</p>
      ) : r.prep_state === "failed" ? (
        <p className="mt-2 text-sm text-danger">Préparation interrompue{r.prep_error ? ` : ${r.prep_error}` : ""}. La vente et le projet sont enregistrés.</p>
      ) : (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2" data-prep-items>
          {items.map((i) => (
            <li key={i.key} className="flex items-start gap-1.5 text-sm">
              {i.done ? <Check size={14} className="mt-0.5 shrink-0 text-success" /> : <Circle size={14} className={cn("mt-0.5 shrink-0", i.required ? "text-warning" : "text-muted")} />}
              <span className={cn(i.done && "text-muted")}>
                {i.label}{!i.required && !i.done && <span className="text-muted"> (facultatif)</span>}
                {!i.done && i.href && <Link href={i.href} className="ml-1 font-semibold text-violet-strong hover:underline">Compléter</Link>}
                {!i.done && i.hint && <span className="block text-xs text-muted">{i.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.stage === "devis_contrat" && <Button size="sm" variant="primary" disabled={busy} onClick={() => void stage("onboarding")}>Documents validés : passer en Onboarding</Button>}
        {r.stage === "onboarding" && !preparing && missing.length === 0 && r.prep_state === "ready" && (
          <a href={claudeLink(onboardingPrompt(projectId))} target="_blank" rel="noreferrer noopener" className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-ink px-3 text-xs font-semibold text-white hover:bg-violet-strong" data-onboarding-slides>
            <Sparkles size={13} /> Générer les slides d&apos;onboarding <ExternalLink size={11} />
          </a>
        )}
        {r.stage === "onboarding" && missing.length > 0 && !preparing && <span className="text-xs font-semibold text-warning">{missing.length} élément{missing.length > 1 ? "s" : ""} à compléter avant les slides</span>}
        {r.stage !== "en_mission" && <Button size="sm" disabled={busy} onClick={() => void stage("en_mission")}>Démarrer la mission</Button>}
        {r.stage === "en_mission" && <Button size="sm" disabled={busy} onClick={() => void stage("termine")}>Terminer la mission</Button>}
        {!preparing && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => retryPrepAction(r.sale_id!), "Préparation mise à jour")}>
            <RotateCcw size={12} /> {r.prep_state === "failed" ? "Reprendre la préparation" : "Actualiser"}
          </Button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">Les contenus préparés restent privés (note interne) : rien n&apos;est visible du client avant votre partage.</p>
    </section>
  );
}
