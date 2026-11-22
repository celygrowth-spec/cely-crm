"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { mailCall } from "@/lib/client/mail";
import { apiGet } from "@/lib/client/query";
import type { BoxStatus } from "@/lib/mail/box-types";

const KEY = ["mail-box-status"];
/** Tout ce qui dépend du contenu de la boîte (dossiers, listes, fil ouvert) : rechargé quand l'index change. */
export const BOX_KEY = ["mail-box"];

/**
 * État de la synchronisation de la boîte Gmail. Tant que la page est ouverte et visible, un passage est relancé
 * seul : toutes les minutes, ou sans attendre pendant la première lecture. Un échec est retenté au passage suivant.
 */
export function useBoxSync() {
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
      const previous = qc.getQueryData<BoxStatus>(KEY);
      qc.setQueryData(KEY, r.data);
      if (previous?.last_sync_at !== r.data.last_sync_at) void qc.invalidateQueries({ queryKey: BOX_KEY });
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

  return { status: q.data, syncing, run };
}
