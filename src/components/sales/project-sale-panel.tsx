"use client";

// Dans un projet issu d'une vente : où en est le suivi (même état que la carte Ventes). La préparation de
// l'onboarding (éléments, demandes au client, slides) est juste en dessous, dans « Préparer l'onboarding » :
// une seule source, project_onboarding (K10).
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { setSaleStageAction } from "@/app/sales-actions";
import { attempt } from "@/lib/client/query";
import { STAGES, STAGE_LABELS, type SaleRow, type SaleStage } from "@/lib/sales/rules";
import { Button, cn } from "@/components/ui";
import { useSaleSync, useSale } from "./win-sale";

export function ProjectSalePanel({ projectId, companyId }: { projectId: string; companyId: string }) {
  const sale = useSale(companyId);
  const r = sale.data;
  if (!r || !r.sale_id || r.project_id !== projectId || r.sale_state !== "won" || !r.stage || r.stage === "termine") return null;
  return <Panel r={r} />;
}

/** Recul d'un projet en cours : la base le refuse sans confirmation explicite (Q11). null = annulé. */
export async function moveSaleStage(saleId: string, stage: SaleStage): Promise<{ ok: true } | { ok: false; error: string } | null> {
  const r = await attempt(() => setSaleStageAction(saleId, stage));
  if (r.ok) return { ok: true };
  if (!/demande votre confirmation/.test(r.error)) return r;
  if (!window.confirm(`${r.error}\n\nConfirmer ?`)) return null;
  const again = await attempt(() => setSaleStageAction(saleId, stage, true));
  return again.ok ? { ok: true } : again;
}

function Panel({ r }: { r: SaleRow }) {
  const saleSync = useSaleSync();
  const [busy, setBusy] = useState(false);
  async function stage(s: SaleStage) {
    setBusy(true);
    const res = await moveSaleStage(r.sale_id!, s);
    setBusy(false);
    if (!res) return;
    if (!res.ok) return void toast.error(res.error);
    saleSync(r.company_id);
    toast.success(`Suivi : ${STAGE_LABELS[s]}`);
  }
  return (
    <section className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-violet-line bg-violet-soft/40 px-3 py-2" aria-label="Suivi de la vente" data-project-sale>
      <ol className="flex flex-wrap items-center gap-1" aria-label="Étapes du suivi">
        {STAGES.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1">
            {i > 0 && <span className="text-xs text-muted" aria-hidden>›</span>}
            <span aria-current={r.stage === s.key ? "step" : undefined} className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", r.stage === s.key ? "bg-ink text-white" : "text-muted")}>{s.label}</span>
          </li>
        ))}
      </ol>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {r.stage === "devis_contrat" && <Button size="sm" variant="primary" disabled={busy} onClick={() => void stage("onboarding")}>Documents confirmés : Onboarding</Button>}
        {r.stage === "onboarding" && <Button size="sm" disabled={busy} onClick={() => void stage("en_mission")}>Démarrer la mission</Button>}
        {r.stage === "en_mission" && <Button size="sm" disabled={busy} onClick={() => void stage("termine")}>Terminer la mission</Button>}
        <Link href="/ventes" className="text-xs font-semibold text-violet-strong hover:underline">Voir dans Ventes</Link>
      </div>
    </section>
  );
}
