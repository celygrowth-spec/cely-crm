"use client";

import { useState } from "react";
import { toast } from "sonner";
import { formatAmount } from "@/lib/format";
import { RecordDealClosing } from "./deal-closing";
import { useCrm } from "./app-shell";
import { useMoveCompany } from "./use-move-company";
import type { RecordCtx } from "./company-record";
import { Button, Field, Input, Select } from "./ui";

export function RecordDeal({ ctx }: { ctx: RecordCtx }) {
  const { pipelines } = useCrm();
  const c = ctx.detail.company;
  const [amount, setAmount] = useState(c.amount?.toString() ?? "");
  const [closeDate, setCloseDate] = useState(c.expected_close_date ?? "");
  const move = useMoveCompany(ctx);

  async function saveDeal() {
    const n = amount.trim() ? Number(amount.replace(/\s/g, "").replace(",", ".")) : null;
    if (n != null && (Number.isNaN(n) || n < 0)) return toast.error("Montant invalide");
    ctx.patch({ amount: n, expected_close_date: closeDate || null });
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
          <Field label="Issue">
            <div className="flex h-9 items-center"><RecordDealClosing ctx={ctx} /></div>
          </Field>
        )}
      </div>
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
