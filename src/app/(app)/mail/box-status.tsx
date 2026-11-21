"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";
import { mailCall } from "@/lib/client/mail";
import { apiGet } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import type { BoxStatus } from "@/lib/mail/box-types";

const TONE: Record<BoxStatus["state"], { label: string; tone: "violet" | "danger" | "neutral" }> = {
  none: { label: "Non connectée", tone: "neutral" },
  pending: { label: "En attente", tone: "neutral" },
  initial: { label: "Première lecture", tone: "neutral" },
  ready: { label: "À jour", tone: "violet" },
  error: { label: "À traiter", tone: "danger" },
};
const KEY = ["mail-box-status"];

/**
 * État de la synchronisation de la boîte Gmail. Tant que la page est ouverte et visible, un passage est relancé
 * seul : toutes les minutes, ou sans attendre pendant la première lecture. Un échec est affiché avec la marche à
 * suivre et retenté au passage suivant.
 */
export function BoxStatusCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: ({ signal }) => apiGet<BoxStatus>("/api/mail/box/sync", signal) });
  const [syncing, setSyncing] = useState(false);
  const busy = useRef(false);

  const run = useCallback(async (): Promise<BoxStatus | null> => {
    if (busy.current) return null; // un seul passage à la fois, même sur un double clic
    busy.current = true;
    setSyncing(true);
    try {
      const r = await mailCall<BoxStatus>("/api/mail/box/sync", "POST", {});
      if (!r.ok) return null;
      qc.setQueryData(KEY, r.data);
      return r.data;
    } catch {
      return null; // réseau coupé : l'état affiché reste le dernier connu, nouvel essai au prochain passage
    } finally {
      busy.current = false;
      setSyncing(false);
    }
  }, [qc]);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      const status = document.visibilityState === "visible" ? await run() : null;
      if (!stopped) timer = setTimeout(loop, status?.state === "initial" ? 2_000 : 60_000);
    };
    timer = setTimeout(loop, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [run]);

  const s = q.data;
  if (!s || s.state === "none") return null;
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-display text-base font-bold">Boîte Gmail</h2>
        <Badge tone={TONE[s.state].tone}>{TONE[s.state].label}</Badge>
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
