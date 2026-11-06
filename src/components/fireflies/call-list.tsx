"use client";

// Liste d'appels, utilisée sur la fiche, le rendez-vous et la file à rattacher. Le panneau (et sa transcription)
// n'est chargé qu'au clic : la liste reste légère.
import { useQuery } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { apiGet } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import { formatCallDuration, mainParticipants, shortDescription } from "@/lib/fireflies/transcript-view";
import { DISPLAY_STATE_LABELS, type Call } from "@/lib/fireflies/types";
import { Badge, Button, Skeleton } from "../ui";

const CallPanel = dynamic(() => import("./call-panel").then((m) => m.CallPanel));

export function CallStateBadge({ call }: { call: Call }) {
  if (call.display_state === "imported") return null; // l'état normal n'encombre pas la liste
  return (
    <Badge tone={call.display_state === "failed" ? "danger" : "warning"} title={call.last_error ?? undefined}>
      {DISPLAY_STATE_LABELS[call.display_state]}
    </Badge>
  );
}

export function CallCard({ call, onOpen, children }: { call: Call; onOpen: () => void; children?: React.ReactNode }) {
  const { shown, more } = mainParticipants(call);
  const preview = shortDescription(call.summary);
  const duration = formatCallDuration(call.duration_minutes);
  return (
    <li className="rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <button type="button" onClick={onOpen} className="min-w-0 text-left font-semibold break-words text-ink hover:text-violet-strong hover:underline">{call.title}</button>
        <CallStateBadge call={call} />
        {call.transcript_url && (
          <a href={call.transcript_url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-violet-strong hover:underline">
            Ouvrir dans Fireflies <ExternalLink size={12} />
          </a>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted">
        {formatDateTime(call.occurred_at) || "Date inconnue"}
        {duration && ` · ${duration}`}
        {shown.length > 0 && ` · ${shown.join(", ")}${more ? ` +${more}` : ""}`}
      </p>
      <button type="button" onClick={onOpen} className="mt-1 line-clamp-2 w-full text-left text-muted hover:text-ink">
        {preview ?? (call.summary_state === "pending" ? "Résumé en attente." : "Pas de résumé. Ouvrir la transcription.")}
      </button>
      {children}
    </li>
  );
}

export function CallList({ url, queryKey, empty }: { url: string; queryKey: unknown[]; empty: string }) {
  const q = useQuery({ queryKey, queryFn: ({ signal }) => apiGet<Call[]>(url, signal) });
  const [openId, setOpenId] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton className="h-16 w-full" />;
  if (q.isError) {
    return (
      <div className="text-sm">
        <p className="text-danger">{q.error.message}</p>
        <Button size="sm" className="mt-2" onClick={() => q.refetch()}>Réessayer</Button>
      </div>
    );
  }
  const list = q.data ?? [];
  if (!list.length) return <p className="text-sm text-muted">{empty}</p>;
  const open = list.find((c) => c.id === openId);
  return (
    <>
      <ul className="space-y-2">
        {list.map((c) => <CallCard key={c.id} call={c} onOpen={() => setOpenId(c.id)} />)}
      </ul>
      {open && <CallPanel call={open} onClose={() => setOpenId(null)} />}
    </>
  );
}
