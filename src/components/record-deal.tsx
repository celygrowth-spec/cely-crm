"use client";

import { useState } from "react";
import { toast } from "sonner";
import { moveCompanyAction, setDealStatusAction } from "@/app/actions";
import { DEAL_STATUS_LABELS, formatAmount } from "@/lib/format";
import { useCrm } from "./app-shell";
import type { RecordCtx } from "./company-record";
import { Badge, Button, Field, Input, Select } from "./ui";

export function RecordDeal({ ctx }: { ctx: RecordCtx }) {
  const { pipelines } = useCrm();
  const c = ctx.detail.company;
  const [amount, setAmount] = useState(c.amount?.toString() ?? "");
  const [closeDate, setCloseDate] = useState(c.expected_close_date ?? "");
  const [lostReason, setLostReason] = useState(c.lost_reason ?? "");
  const [askLost, setAskLost] = useState(false);
  const activeFollowups = ctx.detail.participants.filter((p) => ["a_contacter", "en_cours", "a_repondu"].includes(p.status)).length;


  async function move(stageId: string) {
    const entering = !c.pipeline_id && stageId;
    let stop = true;
    if (entering && activeFollowups > 0) {
      stop = confirm(
        `Cette fiche a ${activeFollowups} relance(s) de prospection active(s).\n\nOK : les arrêter (recommandé)\nAnnuler : les conserver`,
      );
    }
    const pipeline = pipelines.find((p) => p.stages.some((st) => st.id === stageId)) ?? null;
    const stage = pipeline?.stages.find((st) => st.id === stageId) ?? null;
    let stopped = 0;
    const ok = await ctx.mutate(
      {
        stage_id: stage?.id ?? null,
        pipeline_id: pipeline?.id ?? null,
        stage: stage ? { id: stage.id, name: stage.name } : null,
        pipeline: pipeline ? { id: pipeline.id, name: pipeline.name } : null,
        deal_status: "open",
      },
      async () => {
        const res = await moveCompanyAction(c.id, stageId || null, stop);
        if (!res.ok) return res;
        stopped = res.data.stopped_followups ?? 0;
        return { ok: true };
      },
    );
    if (ok && stopped) {
      toast.info(`${stopped} relance(s) de prospection arrêtée(s). L'historique reste consultable.`);
      ctx.reload();
    }
  }

  async function saveDeal() {
    const n = amount.trim() ? Number(amount.replace(/\s/g, "").replace(",", ".")) : null;
    if (n != null && (Number.isNaN(n) || n < 0)) return toast.error("Montant invalide");
    ctx.patch({ amount: n, expected_close_date: closeDate || null });
  }

  async function setStatus(s: "open" | "won" | "lost") {
    setAskLost(false);
    ctx.mutate({ deal_status: s, lost_reason: s === "lost" ? lostReason || null : c.lost_reason }, async () => {
      const res = await setDealStatusAction(c.id, s, s === "lost" ? lostReason : undefined);
      return res.ok ? { ok: true } : res;
    });
  }

  const dirty = amount !== (c.amount?.toString() ?? "") || closeDate !== (c.expected_close_date ?? "");

  return (
    <div className="space-y-3 rounded-xl border border-line p-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="Pipeline et étape">
          {pipelines.length ? (
            <Select value={c.stage_id ?? ""} onChange={(e) => move(e.target.value)}>
              <option value="">Hors pipeline</option>
              {pipelines.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.stages.map((s) => <option key={s.id} value={s.id}>{p.name} › {s.name}</option>)}
                </optgroup>
              ))}
            </Select>
          ) : (
            <p className="text-sm text-muted">Aucun pipeline. Créez-en un dans l&apos;onglet Pipelines.</p>
          )}
        </Field>
        {c.pipeline_id && (
          <Field label="Statut commercial">
            <div className="flex h-9 items-center gap-1.5">
              <Badge tone={c.deal_status === "won" ? "success" : c.deal_status === "lost" ? "danger" : "violet"}>{DEAL_STATUS_LABELS[c.deal_status]}</Badge>
              {c.deal_status === "open" ? (
                <>
                  <Button size="sm" onClick={() => setStatus("won")}>Gagné</Button>
                  <Button size="sm" onClick={() => setAskLost(true)}>Perdu</Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setStatus("open")}>Rouvrir</Button>
              )}
            </div>
          </Field>
        )}
      </div>
      {askLost && (
        <div className="flex flex-wrap items-end gap-2 rounded-lg bg-surface p-2">
          <Field label="Motif de perte (facultatif)" className="flex-1">
            <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} autoFocus />
          </Field>
          <Button size="sm" variant="danger" onClick={() => setStatus("lost")}>Marquer comme perdu</Button>
          <Button size="sm" variant="ghost" onClick={() => setAskLost(false)}>Annuler</Button>
        </div>
      )}
      {c.deal_status === "lost" && c.lost_reason && <p className="text-sm text-muted">Motif de perte : {c.lost_reason}</p>}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Montant potentiel (€)">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={c.amount ? formatAmount(c.amount) : "—"} />
        </Field>
        <Field label="Closing estimé">
          <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
        </Field>
        <Button size="sm" variant="primary" className="h-9" onClick={saveDeal} disabled={!dirty}>Enregistrer</Button>
      </div>
    </div>
  );
}
