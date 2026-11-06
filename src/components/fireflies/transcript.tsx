"use client";

// Transcription complète : affichage progressif, recherche sur tout le texte, copie intégrale.
// Le texte vient de Fireflies : il reste du texte, jamais du HTML.
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Copy, Search } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { apiGet } from "@/lib/client/query";
import { findMatchingLines, formatOffset, splitMatches, transcriptToText } from "@/lib/fireflies/transcript-view";
import type { TranscriptLine } from "@/lib/fireflies/types";
import { Button, Input, Skeleton } from "../ui";

const PAGE = 200;

export function Transcript({ callId, lineCount }: { callId: string; lineCount: number }) {
  const q = useQuery({
    queryKey: ["fireflies-transcript", callId],
    queryFn: ({ signal }) => apiGet<{ lines: TranscriptLine[] } | null>(`/api/fireflies/calls/${callId}/transcript`, signal),
    staleTime: 5 * 60_000,
  });
  if (q.isLoading) return <div className="space-y-2" aria-busy="true"><Skeleton className="h-9 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (q.isError) {
    return (
      <div className="text-sm">
        <p className="text-danger">{q.error.message}</p>
        <Button size="sm" className="mt-2" onClick={() => q.refetch()}>Réessayer</Button>
      </div>
    );
  }
  const lines = q.data?.lines ?? [];
  if (!lines.length) {
    return <p className="text-sm text-muted">{lineCount ? "Transcription introuvable." : "Aucune parole enregistrée dans cet appel."}</p>;
  }
  return <TranscriptBody lines={lines} />;
}

function TranscriptBody({ lines }: { lines: TranscriptLine[] }) {
  const [visible, setVisible] = useState(PAGE);
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query);
  const matches = useMemo(() => findMatchingLines(lines, deferred), [lines, deferred]);
  const [current, setCurrent] = useState(0);
  const [prevQuery, setPrevQuery] = useState(deferred);
  const currentLine = useRef<HTMLLIElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  if (prevQuery !== deferred) {
    setPrevQuery(deferred);
    setCurrent(0);
  }
  const target = matches.length ? matches[Math.min(current, matches.length - 1)] : null;
  // une ligne trouvée plus loin que ce qui est affiché : on affiche jusqu'à elle
  const shown = Math.min(lines.length, target === null ? visible : Math.max(visible, target + 1));

  useEffect(() => {
    if (target !== null) currentLine.current?.scrollIntoView({ block: "center" });
  }, [target]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible((v) => v + PAGE);
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown >= lines.length]); // eslint-disable-line react-hooks/exhaustive-deps

  async function copy() {
    try {
      await navigator.clipboard.writeText(transcriptToText(lines));
      toast.success(`Transcription copiée (${lines.length} lignes)`);
    } catch {
      toast.error("Copie impossible : votre navigateur l'a refusée.");
    }
  }
  const go = (step: number) => matches.length && setCurrent((c) => (Math.min(c, matches.length - 1) + step + matches.length) % matches.length);

  return (
    <div>
      <div className="sticky -top-5 z-10 -mx-1 flex flex-wrap items-center gap-2 bg-white px-1 py-2">
        <div className="relative min-w-40 flex-1">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                go(e.shiftKey ? -1 : 1);
              }
            }}
            placeholder="Rechercher dans la transcription"
            aria-label="Rechercher dans la transcription"
            className="h-9 pl-8"
          />
        </div>
        {deferred.trim() && (
          <span className="flex items-center gap-1 text-xs text-muted" role="status">
            {matches.length ? `${Math.min(current, matches.length - 1) + 1} / ${matches.length}` : "Aucun résultat"}
            <button type="button" onClick={() => go(-1)} disabled={!matches.length} className="rounded p-1 hover:bg-surface disabled:opacity-40" aria-label="Résultat précédent"><ChevronUp size={15} /></button>
            <button type="button" onClick={() => go(1)} disabled={!matches.length} className="rounded p-1 hover:bg-surface disabled:opacity-40" aria-label="Résultat suivant"><ChevronDown size={15} /></button>
          </span>
        )}
        <Button size="sm" type="button" onClick={copy}><Copy size={14} /> Copier la transcription</Button>
      </div>

      <ol className="mt-1 space-y-1.5 text-sm">
        {lines.slice(0, shown).map((l, i) => {
          const newSpeaker = i === 0 || lines[i - 1].speaker !== l.speaker;
          const isCurrent = i === target;
          return (
            <li key={i} ref={isCurrent ? currentLine : undefined} className={isCurrent ? "rounded bg-violet-soft" : undefined}>
              {newSpeaker && <p className="mt-3 font-semibold text-ink">{l.speaker ?? "Intervenant inconnu"}</p>}
              <div className="flex gap-2">
                <span className="w-14 shrink-0 font-label text-xs leading-5 text-muted tabular-nums">{formatOffset(l.start)}</span>
                <p className="min-w-0 break-words whitespace-pre-wrap">
                  {splitMatches(l.text, deferred).map((p, k) => (p.match ? <mark key={k} className="rounded bg-amber-200 text-ink">{p.text}</mark> : <span key={k}>{p.text}</span>))}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {shown < lines.length && (
        <div ref={sentinel} className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{shown} lignes affichées sur {lines.length}</span>
          <Button size="sm" variant="ghost" type="button" onClick={() => setVisible(lines.length)}>Tout afficher</Button>
        </div>
      )}
      {shown >= lines.length && <p className="mt-3 text-xs text-muted">Fin de la transcription : {lines.length} lignes.</p>}
    </div>
  );
}
