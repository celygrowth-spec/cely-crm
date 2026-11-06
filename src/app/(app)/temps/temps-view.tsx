"use client";

// Page Temps : total de la période, tableau par client (trié par temps passé), détail des sessions,
// saisie manuelle et correction. Le chrono en cours est affiché à part : le total ne compte que les
// sessions enregistrées.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Pencil, Plus, Square, Trash2 } from "lucide-react";
import { addTimeAction, deleteTimeAction, updateTimeAction } from "@/app/temps-actions";
import { CompanyPicker, type ClientOption } from "@/components/finance/forms";
import { StartTimerButton, useTimer } from "@/components/time/timer";
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Spinner, cn } from "@/components/ui";
import { zonedToUtc } from "@/lib/appointments/time";
import { TZ, duration, formatDuration, overlap, parseDuration, totalsByClient, type Period, type TimeEntry } from "@/lib/time/calc";

const KINDS = [
  ["jour", "Aujourd'hui"],
  ["semaine", "Cette semaine"],
  ["mois", "Ce mois-ci"],
  ["perso", "Période personnalisée"],
] as const;

const dayFmt0 = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
const dayFmt = { format: (d: Date) => { const s = dayFmt0.format(d); return s.charAt(0).toUpperCase() + s.slice(1); } };
const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
/** Instant → valeur d'un champ datetime-local, en heure de Paris. */
function toLocalInput(iso: string) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}
const fromLocalInput = (v: string) => zonedToUtc(v.slice(0, 10), v.slice(11, 16), TZ).toISOString();

export function TempsView({ period, today, entries, focus, openClient }: { period: Period; today: string; entries: TimeEntry[]; focus: TimeEntry | null; openClient: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { running, stop } = useTimer();
  const [open, setOpen] = useState<string | null>(openClient);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TimeEntry | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  // session ouverte depuis la pastille (« Modifier ») : ?session=…
  const shown = editing ?? (focus && focus.id !== dismissed ? focus : null);
  const [du, setDu] = useState(period.from);
  const [au, setAu] = useState(period.to);
  const { total, rows } = useMemo(() => totalsByClient(entries, period), [entries, period]);
  const max = rows[0]?.ms ?? 0;
  const sessions = rows.reduce((s, r) => s + r.sessions, 0);
  const clients = useMemo(() => [...new Map(entries.map((e) => [e.company_id, { id: e.company_id, name: e.company_name }])).values()], [entries]);

  const go = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`${pathname}?${sp.toString()}`, { scroll: false });
  };

  return (
    <div className="max-w-4xl space-y-4">
      <PageHeader
        title="Temps"
        actions={<>
          <Button onClick={() => setAdding(true)}><Plus size={15} /> Ajouter du temps</Button>
          <StartTimerButton />
        </>}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Période" className="inline-flex flex-wrap rounded-lg border border-line bg-white p-0.5">
          {KINDS.map(([k, l]) => (
            <button key={k} type="button" aria-pressed={period.kind === k}
              onClick={() => go(k === "perso" ? { p: k, du: period.from, au: period.to } : { p: k, du: null, au: null })}
              className={cn("rounded-md px-2.5 py-1 text-xs font-semibold", period.kind === k ? "bg-ink text-white" : "text-muted hover:text-ink")}>{l}</button>
          ))}
        </div>
        {period.kind === "perso" ? (
          <form className="flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); if (du && au && du <= au) go({ p: "perso", du, au }); }}>
            <Input type="date" value={du} onChange={(e) => setDu(e.target.value)} aria-label="Du" className="h-8 w-36" />
            <span className="text-xs text-muted">au</span>
            <Input type="date" value={au} onChange={(e) => setAu(e.target.value)} aria-label="Au" className="h-8 w-36" />
            <button className="h-8 rounded-lg bg-ink px-2.5 text-xs font-semibold text-white">Appliquer</button>
          </form>
        ) : <span className="text-sm font-semibold text-muted">{period.label}</span>}
      </div>

      {running && <RunningCard running={running} onStop={stop} />}

      <Card className="p-4 sm:p-5">
        <p className="font-label text-xs font-semibold text-muted">Total sur la période</p>
        <p className="font-display text-3xl font-extrabold tracking-tight text-ink tabular-nums" data-total>{formatDuration(total)}</p>
        <p className="text-xs text-muted">{sessions} session{sessions > 1 ? "s" : ""} · {rows.length} client{rows.length > 1 ? "s" : ""}{running ? " · chrono en cours non compté" : ""}</p>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title="Aucun temps enregistré sur cette période" description="Lancez un chrono pour un client, ou ajoutez du temps oublié."
          action={<div className="flex flex-wrap justify-center gap-2"><StartTimerButton /><Button onClick={() => setAdding(true)}><Plus size={15} /> Ajouter du temps</Button></div>} />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm" data-totals>
            <thead>
              <tr className="border-b border-line text-left font-label text-[11px] text-muted">
                <th className="px-4 py-2">Client</th><th className="hidden w-1/3 sm:table-cell" aria-label="Répartition" /><th className="pr-3 text-right">Temps passé</th><th className="pr-4 text-right">Sessions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isOpen = open === r.company_id;
                const mine = entries.filter((e) => e.company_id === r.company_id && e.ended_at && overlap(e, period.start, period.end, 0) > 0);
                return (
                  <ClientRows key={r.company_id} name={r.company_name} ms={r.ms} share={max ? r.ms / max : 0} pct={total ? Math.round((r.ms / total) * 100) : 0} count={r.sessions}
                    open={isOpen} onToggle={() => setOpen(isOpen ? null : r.company_id)} sessions={mine} period={period} onEdit={setEditing} />
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <AddModal open={adding} onClose={() => setAdding(false)} today={today} clients={clients} />
      <EditModal entry={shown} onClose={() => { setEditing(null); if (focus) { setDismissed(focus.id); go({ session: null }); } }} clients={clients} />
    </div>
  );
}

function RunningCard({ running, onStop }: { running: { company_name: string; label: string | null; started_at: string }; onStop: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-violet-line bg-violet-soft/40 px-4 py-3" data-running>
      <span className="timer-dot size-2.5 rounded-full bg-violet-strong" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm"><span className="font-semibold text-ink">En cours : {running.company_name}</span>{running.label && <span className="text-muted"> · {running.label}</span>}</p>
        <p className="text-xs text-muted">Démarré à {timeFmt.format(new Date(running.started_at))} · {formatDuration(Math.max(0, now - Date.parse(running.started_at)))} (ajouté au total à l&apos;arrêt)</p>
      </div>
      <Button size="sm" variant="primary" onClick={onStop}><Square size={11} className="fill-current" /> Arrêter</Button>
    </div>
  );
}

function ClientRows({ name, ms, share, pct, count, open, onToggle, sessions, period, onEdit }: {
  name: string; ms: number; share: number; pct: number; count: number; open: boolean; onToggle: () => void; sessions: TimeEntry[]; period: Period; onEdit: (e: TimeEntry) => void;
}) {
  return (
    <>
      <tr className="cursor-pointer border-b border-line last:border-0 hover:bg-surface/60" onClick={onToggle} data-client={name}>
        <td className="px-4 py-2.5">
          <span className="flex items-center gap-1.5 font-semibold text-ink">
            {open ? <ChevronDown size={14} className="text-muted" /> : <ChevronRight size={14} className="text-muted" />}{name}
          </span>
          <span className="mt-1 block h-1.5 rounded-full bg-surface sm:hidden" aria-hidden><span className="block h-full rounded-full bg-violet" style={{ width: `${share * 100}%` }} /></span>
        </td>
        <td className="hidden sm:table-cell">
          <span className="flex items-center gap-2" aria-label={`${pct} % du temps`}>
            <span className="h-2 flex-1 rounded-full bg-surface"><span className="block h-full rounded-full bg-violet" style={{ width: `${share * 100}%` }} /></span>
            <span className="w-9 text-right text-xs text-muted tabular-nums">{pct} %</span>
          </span>
        </td>
        <td className="pr-3 text-right font-semibold whitespace-nowrap tabular-nums">{formatDuration(ms)}</td>
        <td className="pr-4 text-right text-muted tabular-nums">{count}</td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-surface/40">
          <td colSpan={4} className="px-4 py-2">
            <ul className="divide-y divide-line" data-sessions>
              {sessions.map((e) => {
                const inside = overlap(e, period.start, period.end, 0);
                const full = duration(e);
                return (
                  <li key={e.id} className="flex items-center gap-3 py-2 text-sm">
                    <span className="w-24 shrink-0 text-muted sm:w-28">{dayFmt.format(new Date(e.started_at))}</span>
                    <span className="min-w-0 flex-1 truncate">{e.label ?? <span className="text-muted">Sans libellé</span>}
                      <span className="block text-xs text-muted">{e.source === "manual" ? "Saisie manuelle" : `${timeFmt.format(new Date(e.started_at))} → ${timeFmt.format(new Date(e.ended_at!))}`}{inside < full ? ` · ${formatDuration(inside)} sur la période (session de ${formatDuration(full)})` : ""}</span>
                    </span>
                    <span className="font-semibold tabular-nums">{formatDuration(inside)}</span>
                    <button type="button" onClick={() => onEdit(e)} className="rounded p-1.5 text-muted hover:bg-white hover:text-ink" aria-label={`Modifier la session du ${dayFmt.format(new Date(e.started_at))}`}><Pencil size={14} /></button>
                  </li>
                );
              })}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Ajouter du temps (oubli) : client, date, durée ; libellé facultatif
// ---------------------------------------------------------------------------

function AddModal({ open, onClose, today, clients }: { open: boolean; onClose: () => void; today: string; clients: ClientOption[] }) {
  return <Modal open={open} onClose={onClose} title="Ajouter du temps">{open && <AddBody onClose={onClose} today={today} clients={clients} />}</Modal>;
}

function AddBody({ onClose, today, clients }: { onClose: () => void; today: string; clients: ClientOption[] }) {
  const router = useRouter();
  const [company, setCompany] = useState<ClientOption | null>(null);
  const [day, setDay] = useState(today);
  const [dur, setDur] = useState("");
  const [label, setLabel] = useState("");
  const [pending, start] = useTransition();
  const ms = parseDuration(dur);
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      if (!company) return void toast.error("Choisissez le client");
      if (!ms) return void toast.error("Durée illisible : par exemple 1h30, 45 min ou 2h");
      start(async () => {
        const r = await addTimeAction({ company_id: company.id, day, ms, label: label || null });
        if (!r.ok) return void toast.error(r.error);
        toast.success(`${formatDuration(ms)} ajoutées pour ${company.name}`);
        onClose();
        router.refresh();
      });
    }}>
      <Field label="Client"><CompanyPicker value={company} onChange={setCompany} suggestions={clients} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date"><Input type="date" required value={day} max={today} onChange={(e) => setDay(e.target.value)} aria-label="Date" /></Field>
        <Field label="Durée" hint={ms ? formatDuration(ms) : "1h30, 45 min, 2h…"}><Input required value={dur} onChange={(e) => setDur(e.target.value)} placeholder="1h30" aria-label="Durée" /></Field>
      </div>
      <Field label="Libellé (facultatif)"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="Point client" /></Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Ajouter"}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Modifier / supprimer une session (client, libellé, début, fin ou durée)
// ---------------------------------------------------------------------------

function EditModal({ entry, onClose, clients }: { entry: TimeEntry | null; onClose: () => void; clients: ClientOption[] }) {
  return <Modal open={!!entry} onClose={onClose} title="Modifier la session">{entry && <EditBody key={entry.id} entry={entry} onClose={onClose} clients={clients} />}</Modal>;
}

function EditBody({ entry, onClose, clients }: { entry: TimeEntry; onClose: () => void; clients: ClientOption[] }) {
  const router = useRouter();
  const runningEntry = !entry.ended_at;
  const [company, setCompany] = useState<ClientOption | null>({ id: entry.company_id, name: entry.company_name });
  const [label, setLabel] = useState(entry.label ?? "");
  const [start, setStart] = useState(toLocalInput(entry.started_at));
  const [end, setEnd] = useState(entry.ended_at ? toLocalInput(entry.ended_at) : "");
  const [dur, setDur] = useState(entry.ended_at ? formatDuration(duration(entry)).replace(" h ", "h") : "");
  const [pending, run] = useTransition();
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const ms = valid.test(start) && valid.test(end) ? Date.parse(fromLocalInput(end)) - Date.parse(fromLocalInput(start)) : null;
  const applyDuration = (v: string) => {
    setDur(v);
    const d = parseDuration(v);
    if (d && valid.test(start)) setEnd(toLocalInput(new Date(Date.parse(fromLocalInput(start)) + d).toISOString()));
  };
  return (
    <form className="space-y-3" onSubmit={(e) => {
      e.preventDefault();
      if (!company) return void toast.error("Choisissez le client");
      if (!valid.test(start) || (!runningEntry && !valid.test(end))) return void toast.error("Dates incomplètes");
      run(async () => {
        const r = await updateTimeAction(entry.id, { company_id: company.id, label: label || null, started_at: fromLocalInput(start), ended_at: runningEntry ? null : fromLocalInput(end) });
        if (!r.ok) return void toast.error(r.error);
        toast.success("Session modifiée");
        onClose();
        router.refresh();
      });
    }}>
      <Field label="Client"><CompanyPicker value={company} onChange={setCompany} suggestions={clients} /></Field>
      <Field label="Libellé (facultatif)"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Début"><Input type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} aria-label="Début" /></Field>
        {runningEntry ? <Field label="Fin"><p className="flex h-9 items-center text-sm text-muted">Chrono en cours</p></Field>
          : <Field label="Fin" hint="À corriger si le chrono a tourné trop longtemps"><Input type="datetime-local" required value={end} onChange={(e) => { setEnd(e.target.value); setDur(""); }} aria-label="Fin" /></Field>}
      </div>
      {!runningEntry && (
        <Field label="Ou durée" hint={ms !== null ? (ms > 0 ? `Durée : ${formatDuration(ms)}` : "La fin doit être après le début") : undefined}>
          <Input value={dur} onChange={(e) => applyDuration(e.target.value)} placeholder="1h30" aria-label="Durée" />
        </Field>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button variant="ghost" className="text-danger" disabled={pending} onClick={() => {
          if (!confirm("Supprimer cette session ? Son temps sera retiré des totaux.")) return;
          run(async () => {
            const r = await deleteTimeAction(entry.id);
            if (!r.ok) return void toast.error(r.error);
            toast.success("Session supprimée");
            onClose();
            router.refresh();
          });
        }}><Trash2 size={14} /> Supprimer</Button>
        <div className="flex gap-2">
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
        </div>
      </div>
    </form>
  );
}
