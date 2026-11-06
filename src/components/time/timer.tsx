"use client";

// Chrono : contexte partagé, fenêtre « Démarrer un chrono » et pastille visible partout dans le CRM.
// Le temps affiché est calculé depuis l'heure de départ enregistrée par le SERVEUR (corrigée du
// décalage d'horloge du navigateur) : recharger ou rouvrir le CRM retrouve le bon temps.
// Les onglets ouverts se tiennent à jour entre eux (BroadcastChannel, puis relecture au retour).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Check, Play, Square, Timer } from "lucide-react";
import { startTimerAction, stopTimerAction, type StartResult } from "@/app/temps-actions";
import { apiGet } from "@/lib/client/query";
import { CompanyPicker, type ClientOption } from "@/components/finance/forms";
import { Button, Field, Input, Modal, Spinner, cn } from "@/components/ui";
import { duration, formatDuration } from "@/lib/time/calc";

type Running = { id: string; company_id: string; company_name: string; label: string | null; started_at: string };
type TimerData = { now: string; running: Running | null; recent: ClientOption[] };

type Ctx = { running: Running | null; openStart: (company?: ClientOption | null) => void; stop: () => void };
const TimerCtx = createContext<Ctx | null>(null);

export function useTimer() {
  const c = useContext(TimerCtx);
  if (!c) throw new Error("useTimer hors du TimerProvider");
  return c;
}

const LONG_MS = 10 * 3600_000;

export function TimerProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [picking, setPicking] = useState<{ company: ClientOption | null } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [stopping, startStop] = useTransition();
  const offset = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const { data } = useQuery({
    queryKey: ["timer"],
    queryFn: async ({ signal }) => {
      const sent = Date.now();
      const d = await apiGet<TimerData>("/api/temps/chrono", signal);
      // décalage serveur − navigateur (milieu de l'aller-retour)
      offset.current = Date.parse(d.now) - (sent + Date.now()) / 2;
      return d;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const changed = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["timer"] });
    channel.current?.postMessage("changed");
    router.refresh(); // la page Temps, si elle est ouverte, recalcule ses totaux
  }, [qc, router]);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("cely-timer");
    ch.onmessage = () => {
      qc.invalidateQueries({ queryKey: ["timer"] });
      router.refresh();
    };
    channel.current = ch;
    return () => ch.close();
  }, [qc, router]);

  const announceStopped = useCallback((s: Running & { ended_at: string }) => {
    const ms = duration(s);
    setSaved(`${s.company_name} · ${formatDuration(ms)}`);
    setTimeout(() => setSaved(null), 2800);
    toast.success(`Session enregistrée : ${s.company_name} · ${formatDuration(ms)}`, {
      description: ms > LONG_MS ? "Plus de 10 h : si vous aviez oublié d'arrêter le chrono, corrigez l'heure de fin." : undefined,
      action: { label: "Modifier", onClick: () => router.push(`/temps?session=${s.id}`) },
      duration: ms > LONG_MS ? 12_000 : 5000,
    });
  }, [router]);

  const stop = useCallback(() => {
    startStop(async () => {
      const r = await stopTimerAction();
      if (!r.ok) return void toast.error(r.error);
      if (r.data.status === "stopped") announceStopped(r.data.stopped as Running & { ended_at: string });
      else toast.info("Le chrono était déjà arrêté.");
      changed();
    });
  }, [announceStopped, changed]);

  const value = useMemo<Ctx>(() => ({ running: data?.running ?? null, openStart: (company) => setPicking({ company: company ?? null }), stop }), [data?.running, stop]);

  return (
    <TimerCtx.Provider value={value}>
      {children}
      <TimerPill running={data?.running ?? null} offset={offset} onStop={stop} stopping={stopping} saved={saved} />
      <StartModal
        open={!!picking}
        initial={picking?.company ?? null}
        recent={data?.recent ?? []}
        running={data?.running ?? null}
        offset={offset}
        onClose={() => setPicking(null)}
        onDone={(r) => {
          setPicking(null);
          if (r.stopped) announceStopped(r.stopped as Running & { ended_at: string });
          if (r.status === "running") toast.info(`Le chrono tourne déjà pour ${r.running.company_name}.`);
          else toast.success(`Chrono démarré : ${r.running.company_name}`);
          changed();
        }}
      />
    </TimerCtx.Provider>
  );
}

function useElapsed(startedAt: string | null, offset: React.RefObject<number>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt ? Math.max(0, now + (offset.current ?? 0) - Date.parse(startedAt)) : 0;
}

function TimerPill({ running, offset, onStop, stopping, saved }: { running: Running | null; offset: React.RefObject<number>; onStop: () => void; stopping: boolean; saved: string | null }) {
  const ms = useElapsed(running?.started_at ?? null, offset);
  if (!running && !saved) return null;
  return (
    <div role="status" aria-live="polite" data-timer-pill
      className="fixed right-3 bottom-[4.5rem] z-30 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full border border-line bg-white py-1.5 pr-1.5 pl-3 shadow-lg md:right-6 md:bottom-6">
      {running ? (
        <>
          <span className="timer-dot size-2.5 shrink-0 rounded-full bg-violet-strong" aria-hidden />
          <Link href="/temps" className="min-w-0 truncate text-sm font-semibold text-ink hover:text-violet-strong" title={running.label ?? undefined}>{running.company_name}</Link>
          <span className="font-display text-sm font-bold text-ink tabular-nums" aria-label={`Temps écoulé ${formatDuration(ms)}`} data-elapsed>{formatDuration(ms, { seconds: true })}</span>
          <button type="button" onClick={onStop} disabled={stopping} className="inline-flex h-8 items-center gap-1 rounded-full bg-ink px-3 text-xs font-semibold text-white hover:bg-violet-strong disabled:opacity-60">
            {stopping ? <Spinner /> : <Square size={11} className="fill-current" aria-hidden />} Arrêter
          </button>
        </>
      ) : (
        <span className="timer-saved flex items-center gap-2 py-1 pr-2 text-sm font-semibold text-success"><Check size={15} aria-hidden /> Enregistré · {saved}</span>
      )}
    </div>
  );
}

function StartModal({ open, initial, recent, running, offset, onClose, onDone }: {
  open: boolean; initial: ClientOption | null; recent: ClientOption[]; running: Running | null; offset: React.RefObject<number>; onClose: () => void; onDone: (r: StartResult) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Démarrer un chrono">
      {open && <StartBody initial={initial} recent={recent} running={running} offset={offset} onClose={onClose} onDone={onDone} />}
    </Modal>
  );
}

function StartBody({ initial, recent, running, offset, onClose, onDone }: { initial: ClientOption | null; recent: ClientOption[]; running: Running | null; offset: React.RefObject<number>; onClose: () => void; onDone: (r: StartResult) => void }) {
  const [company, setCompany] = useState<ClientOption | null>(initial);
  const [label, setLabel] = useState("");
  const [conflict, setConflict] = useState<Running | null>(null);
  const [pending, start] = useTransition();
  const elapsed = useElapsed(conflict?.started_at ?? null, offset);
  const go = (switchRunning: boolean) => {
    if (!company) return void toast.error("Choisissez le client");
    start(async () => {
      const r = await startTimerAction(company.id, label || null, switchRunning);
      if (!r.ok) return void toast.error(r.error);
      if (r.data.status === "conflict") return setConflict(r.data.running);
      onDone(r.data);
    });
  };
  const other = conflict ?? (running && company && running.company_id !== company.id ? running : null);
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); go(!!other); }}>
      <Field label="Client">
        <CompanyPicker value={company} onChange={(c) => { setCompany(c); setConflict(null); }} suggestions={recent} />
      </Field>
      {!company && recent.length > 0 && <p className="-mt-1 text-xs text-muted">Clients récents en premier ; tapez pour chercher parmi toutes les fiches.</p>}
      <Field label="Libellé (facultatif)">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="Audit SEO, Point client, Préparation du devis…" />
      </Field>
      {other && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-warning" data-conflict>
          Un chrono tourne pour <span className="font-semibold">{other.company_name}</span>{conflict ? ` (${formatDuration(elapsed)})` : ""}. Il sera arrêté et sa session enregistrée avant de démarrer le nouveau.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending || !company}>
          {pending ? <Spinner /> : <Play size={14} className="fill-current" />} {other ? "Arrêter et démarrer" : "Démarrer"}
        </Button>
      </div>
    </form>
  );
}

/** Bouton réutilisable (page Temps, fiche client). */
export function StartTimerButton({ company, variant = "primary", className, compact }: { company?: ClientOption | null; variant?: "primary" | "secondary"; className?: string; compact?: boolean }) {
  const { openStart, running } = useTimer();
  const busy = !!running && !!company && running.company_id === company.id;
  return (
    <Button variant={variant} size={compact ? "sm" : "md"} className={cn(className)} onClick={() => openStart(company ?? null)} aria-label="Démarrer un chrono" title={busy ? "Le chrono tourne déjà pour ce client" : "Démarrer un chrono"} data-start-timer>
      <Timer size={15} /> <span className={compact ? "max-md:hidden" : undefined}>{busy ? "Chrono en cours" : "Démarrer un chrono"}</span>
    </Button>
  );
}
