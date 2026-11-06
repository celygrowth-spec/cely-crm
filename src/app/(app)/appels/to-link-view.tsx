"use client";

// File « Appels à rattacher » : les candidates aident, le choix reste le vôtre et il est conservé.
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { post } from "@/components/fireflies/api";
import { CallCard } from "@/components/fireflies/call-list";
import { CompanyPicker } from "@/components/fireflies/company-picker";
import { Badge, Button, EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { apiGet, useSync } from "@/lib/client/query";
import type { Call } from "@/lib/fireflies/types";

const CallPanel = dynamic(() => import("@/components/fireflies/call-panel").then((m) => m.CallPanel));
const KEYS = [["fireflies-to-link"], ["fireflies-calls"], ["fireflies-status"]] as const;

export function ToLinkView() {
  const sync = useSync();
  const [showIgnored, setShowIgnored] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [recalc, setRecalc] = useState(false);
  const state = showIgnored ? "ignored" : "to_link";
  const q = useQuery({
    queryKey: ["fireflies-to-link", state],
    queryFn: ({ signal }) => apiGet<Call[]>(`/api/fireflies/to-link?state=${state}`, signal),
  });
  const list = q.data ?? [];
  const open = list.find((c) => c.id === openId);

  async function rematch() {
    setRecalc(true);
    const r = await post<number>("/api/fireflies/rematch");
    setRecalc(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(r.data ? `${r.data} appel(s) rattaché(s)` : "Aucun nouveau rattachement");
    sync(...KEYS);
  }

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={showIgnored ? "Appels ignorés" : "Appels à rattacher"}
        description="Appels Fireflies sans fiche certaine. Rien n'est créé automatiquement, et vos choix sont conservés aux imports suivants."
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => setShowIgnored((s) => !s)}>{showIgnored ? "Voir les appels à rattacher" : "Voir les appels ignorés"}</Button>
            {!showIgnored && <Button size="sm" disabled={recalc} onClick={rematch}><RefreshCw size={14} /> {recalc ? "Recalcul…" : "Recalculer"}</Button>}
          </>
        }
      />
      {q.isLoading && <Skeleton className="h-24 w-full" />}
      {q.isError && <p className="text-sm text-danger">{q.error.message}</p>}
      {!q.isLoading && !q.isError && !list.length && (
        <EmptyState title={showIgnored ? "Aucun appel ignoré" : "Rien à rattacher"} description={showIgnored ? undefined : "Les nouveaux appels sans fiche certaine apparaîtront ici."} />
      )}
      <ul className="space-y-3">
        {list.map((c) => (
          <CallCard key={c.id} call={c} onOpen={() => setOpenId(c.id)}>
            <LinkActions call={c} ignored={showIgnored} />
          </CallCard>
        ))}
      </ul>
      {open && <CallPanel call={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function LinkActions({ call, ignored }: { call: Call; ignored: boolean }) {
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  async function act(body: object, done: string) {
    setBusy(true);
    const r = await post(`/api/fireflies/calls/${call.id}/link`, body);
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(done);
    sync(...KEYS);
  }
  if (ignored) {
    return <div className="mt-2"><Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "reset" }, "Choix annulé")}>Annuler mon choix</Button></div>;
  }
  return (
    <div className="mt-2 border-t border-line pt-2">
      {call.link_reason && <p className="mb-2 text-xs text-muted">{call.link_reason}</p>}
      {call.link_candidates.length > 0 && (
        <ul className="mb-2 space-y-1">
          {call.link_candidates.map((f) => (
            <li key={f.company_id} className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => act({ action: "link", company_id: f.company_id }, `Rattaché à ${f.name}`)}>Rattacher à {f.name}</Button>
              {f.archived && <Badge tone="warning">Archivée</Badge>}
              <span className="text-xs text-muted">{f.reasons.join(" · ")}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" onClick={() => setSearching((s) => !s)}>Chercher une autre fiche</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "ignore" }, "Appel ignoré")}>Ignorer</Button>
      </div>
      {searching && <div className="mt-2"><CompanyPicker disabled={busy} onPick={(id) => act({ action: "link", company_id: id }, "Appel rattaché")} /></div>}
    </div>
  );
}
