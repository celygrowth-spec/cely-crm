"use client";

import { RefreshCw } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import type { BoxStatus } from "@/lib/mail/box-types";
import { useBoxSync } from "./use-box-sync";

export const BOX_TONE: Record<BoxStatus["state"], { label: string; tone: "violet" | "danger" | "neutral" }> = {
  none: { label: "Non connectée", tone: "neutral" },
  pending: { label: "En attente", tone: "neutral" },
  initial: { label: "Première lecture", tone: "neutral" },
  ready: { label: "À jour", tone: "violet" },
  error: { label: "À traiter", tone: "danger" },
};

/** État de la synchronisation de la boîte Gmail, avec la marche à suivre en cas d'échec. */
export function BoxStatusCard() {
  const { status: s, syncing, run } = useBoxSync();
  if (!s || s.state === "none") return null;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-bold">Boîte Gmail</h2>
        <Badge tone={BOX_TONE[s.state].tone}>{BOX_TONE[s.state].label}</Badge>
        <span className="flex-1" />
        <Button variant="secondary" onClick={() => run()} disabled={syncing}>
          <RefreshCw size={14} className={syncing ? "animate-spin" : undefined} /> {syncing ? "Synchronisation…" : "Synchroniser"}
        </Button>
      </div>
      <p role={s.state === "error" ? "alert" : undefined} className={`mt-2 text-sm ${s.state === "error" ? "text-danger" : "text-muted"}`}>{s.message}</p>
      <p className="mt-1 text-xs text-muted">
        {s.messages.toLocaleString("fr-FR")} message{s.messages > 1 ? "s" : ""} dans l&apos;index
        {s.last_sync_at ? ` · dernière synchronisation ${formatDateTime(s.last_sync_at)}` : ""}
      </p>
      <p className="mt-1 text-xs text-muted">Seuls l&apos;expéditeur, l&apos;objet, un extrait et les libellés sont conservés. Le contenu des messages reste dans Gmail.</p>
    </Card>
  );
}
