"use client";

// Dans un projet issu d'une vente : suivi de la vente (même état que la carte Ventes). Le détail de la
// préparation, les points à compléter et les slides d'onboarding sont dans « Préparer l'onboarding » (onglet Général).
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2, RotateCcw } from "lucide-react";
import { retryPrepAction, setSaleStageAction } from "@/app/sales-actions";
import { attempt } from "@/lib/client/query";
import { STAGES, STAGE_LABELS, missingItems, type SaleRow, type SaleStage } from "@/lib/sales/rules";
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
        <p className="mt-2 text-sm" data-prep-items>
          {missing.length
            ? <>{missing.length === 1 ? "1 point bloque" : `${missing.length} points bloquent`} le démarrage : <Link href={`/projets/${projectId}`} className="font-semibold text-violet-strong hover:underline">Préparer l&apos;onboarding</Link></>
            : <>Prêt à démarrer · <Link href={`/projets/${projectId}`} className="font-semibold text-violet-strong hover:underline">Préparer l&apos;onboarding</Link></>}
          {items.length > 0 && <span className="text-muted"> ({items.filter((i) => i.done).length}/{items.length} points traités)</span>}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {r.stage === "devis_contrat" && <Button size="sm" variant="primary" disabled={busy} onClick={() => void stage("onboarding")}>Documents validés : passer en Onboarding</Button>}
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
