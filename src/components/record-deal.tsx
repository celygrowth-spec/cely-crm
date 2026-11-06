"use client";

import { useState } from "react";
import { toast } from "sonner";
import { setDealStatusAction } from "@/app/actions";
import { DEAL_STATUS_LABELS, formatAmount } from "@/lib/format";
import { useCrm } from "./app-shell";
import { useMoveCompany } from "./use-move-company";
import type { RecordCtx } from "./company-record";
import { Badge, Button, Field, Input, Select } from "./ui";

export function RecordDeal({ ctx }: { ctx: RecordCtx }) {
  const { pipelines } = useCrm();
  const c = ctx.detail.company;
  const [amount, setAmount] = useState(c.amount?.toString() ?? "");
  const [closeDate, setCloseDate] = useState(c.expected_close_date ?? "");
  const [lostReason, setLostReason] = useState(c.lost_reason ?? "");
  const [askLost, setAskLost] = useState(false);
  const move = useMoveCompany(ctx);

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
        <Field label="Date de signature estimée">
          <Input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
        </Field>
        <Button size="sm" variant="primary" className="h-9" onClick={saveDeal} disabled={!dirty}>Enregistrer</Button>
      </div>
    </div>
  );
}
