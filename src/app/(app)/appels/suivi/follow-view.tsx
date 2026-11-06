"use client";

// Suivi de l'import Fireflies : configuration, dernière synchro, échecs et relance, import d'une période passée.
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";
import { post } from "@/components/fireflies/api";
import { Button, Card, Field, Input, PageHeader, Skeleton, Textarea } from "@/components/ui";
import { addDaysISO, formatDateTime, todayISO } from "@/lib/format";
import { apiGet, useSync } from "@/lib/client/query";
import { DISPLAY_STATE_LABELS, type FirefliesStatus, type ImportRow } from "@/lib/fireflies/types";

const KEYS = [["fireflies-status"], ["fireflies-calls"], ["fireflies-to-link"]] as const;
const MAX_ROUNDS = 20; // chaque passage traite ce qu'il peut en 30 s environ

export function FollowView() {
  const sync = useSync();
  const q = useQuery({
    queryKey: ["fireflies-status"],
    queryFn: ({ signal }) => apiGet<FirefliesStatus>("/api/fireflies/status", signal),
    refetchInterval: (s) => (s.state.data?.pending ? 10_000 : false),
  });
  const [running, setRunning] = useState(false);

  async function processAll() {
    setRunning(true);
    let total = 0;
    for (let i = 0; i < MAX_ROUNDS; i++) {
      const r = await post<{ processed: number; failed: number }>("/api/fireflies/process");
      if (!r.ok) {
        toast.error(r.error);
        break;
      }
      total += r.data.processed;
      sync(...KEYS);
      if (!r.data.processed && !r.data.failed) break;
    }
    setRunning(false);
    toast.success(`${total} appel(s) importé(s)`);
  }

  if (q.isLoading) return <Skeleton className="h-64 w-full max-w-3xl" />;
  if (q.isError || !q.data) return <p className="text-sm text-danger">{q.error?.message ?? "Chargement impossible"}</p>;
  const s = q.data;
  const c = s.connection;

  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Suivi Fireflies" description="L'historique des appels reste interne : les clients du portail n'y ont jamais accès." />

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">État</h2>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <Fact label="Dernier import réussi" value={c?.last_success_at} />
          <Fact label="Dernier webhook reçu" value={c?.last_webhook_at} />
          <Fact label="Dernière synchronisation" value={c?.last_sync_at} />
          <div className="flex justify-between gap-3"><dt className="text-muted">Compte Fireflies</dt><dd className="truncate">{c?.account_email ?? "—"}</dd></div>
        </dl>
        {c?.api_paused_until && new Date(c.api_paused_until) > new Date() && (
          <p className="mt-2 text-sm text-warning">Quota Fireflies atteint : reprise après {formatDateTime(c.api_paused_until)}.</p>
        )}
        <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
          <Check1 ok={s.configured.apiKey} label="Clé API (FIREFLIES_API_KEY)" />
          <Check1 ok={s.configured.webhookSecret} label="Signature webhook (FIREFLIES_WEBHOOK_SECRET)" />
          <Check1 ok={s.configured.serverSecret} label="Clé serveur (APPOINTMENTS_SECRET)" />
          <Check1 ok={s.configured.cronSecret} label="Passage quotidien (CRON_SECRET)" />
        </ul>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">{s.pending} import(s) en attente</span>
          <Button size="sm" disabled={running} onClick={processAll}>{running ? "Traitement…" : "Traiter maintenant"}</Button>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Imports en échec</h2>
        {s.failed.length === 0 ? <p className="mt-1 text-sm text-muted">Aucun.</p> : (
          <ul className="mt-2 space-y-2">
            {s.failed.map((j) => <FailedRow key={j.job_id} job={j} />)}
          </ul>
        )}
      </Card>

      <Backfill onDone={() => sync(...KEYS)} />
      <OwnAddresses key={`${c?.own_emails.join()}|${c?.own_domains.join()}`} emails={c?.own_emails ?? []} domains={c?.own_domains ?? []} onDone={() => sync(...KEYS)} />

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Derniers imports</h2>
        {s.recent.length === 0 ? <p className="mt-1 text-sm text-muted">Aucun pour le moment.</p> : (
          <ul className="mt-2 divide-y divide-line text-sm">
            {s.recent.map((j) => (
              <li key={j.job_id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                <span className="min-w-0 break-words">{j.title ?? j.meeting_id}</span>
                <span className="text-xs text-muted">{DISPLAY_STATE_LABELS[j.display_state]}{j.line_count !== null && ` · ${j.line_count} lignes`} · {formatDateTime(j.received_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Fact({ label, value }: { label: string; value?: string | null }) {
  return <div className="flex justify-between gap-3"><dt className="text-muted">{label}</dt><dd>{value ? formatDateTime(value) : "—"}</dd></div>;
}

function Check1({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      {ok ? <Check size={14} className="shrink-0 text-success" /> : <X size={14} className="shrink-0 text-danger" />}
      <span className={ok ? undefined : "font-semibold"}>{label}{ok ? "" : " : à configurer"}</span>
    </li>
  );
}

function FailedRow({ job }: { job: ImportRow }) {
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    const r = await post(`/api/fireflies/jobs/${job.job_id}/retry`);
    if (!r.ok) {
      setBusy(false);
      return toast.error(r.error);
    }
    const run = await post<{ processed: number }>("/api/fireflies/process");
    setBusy(false);
    if (run.ok && run.data.processed) toast.success("Import réussi");
    else toast.error("L'import a de nouveau échoué ou reste en attente.");
    sync(...KEYS);
  }
  return (
    <li className="flex flex-wrap items-start gap-2 rounded-lg border border-line p-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-semibold break-words">{job.title ?? job.meeting_id}</p>
        <p className="text-xs text-muted">{job.last_error ?? "Erreur inconnue"} · {formatDateTime(job.received_at)}</p>
      </div>
      <Button size="sm" disabled={busy} onClick={retry}>{busy ? "Relance…" : "Relancer"}</Button>
    </li>
  );
}

function Backfill({ onDone }: { onDone: () => void }) {
  const [from, setFrom] = useState(addDaysISO(todayISO(), -30));
  const [to, setTo] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await post<{ seen: number; queued: number; truncated: boolean }>("/api/fireflies/backfill", { from, to });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(`${r.data.seen} appel(s) trouvé(s), ${r.data.queued} nouveau(x) à importer`);
    if (r.data.truncated) toast.warning("Période très chargée : relancez sur une période plus courte pour la suite.");
    onDone();
  }
  return (
    <Card className="p-4">
      <h2 className="font-display text-base font-bold">Importer une période passée</h2>
      <p className="mt-1 text-sm text-muted">Les appels déjà connus ne sont pas repris et vos choix sont conservés. Cliquez ensuite sur « Traiter maintenant ».</p>
      <form onSubmit={start} className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="Du"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <Field label="Au"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></Field>
        <Button type="submit" disabled={busy}>{busy ? "Recherche…" : "Mettre en file"}</Button>
      </form>
    </Card>
  );
}

const splitList = (s: string) => s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

function OwnAddresses({ emails, domains, onDone }: { emails: string[]; domains: string[]; onDone: () => void }) {
  const [e, setE] = useState(emails.join("\n"));
  const [d, setD] = useState(domains.join("\n"));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await post("/api/fireflies/own-addresses", { emails: splitList(e), domains: splitList(d) });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Adresses enregistrées");
    onDone();
  }
  return (
    <Card className="p-4">
      <h2 className="font-display text-base font-bold">Vos autres adresses</h2>
      <p className="mt-1 text-sm text-muted">Votre compte, vos boîtes Mail et votre agenda sont déjà reconnus. Ajoutez ici les autres adresses à ne jamais prendre pour un client.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Adresses"><Textarea rows={3} value={e} onChange={(x) => setE(x.target.value)} placeholder="une par ligne" /></Field>
        <Field label="Domaines internes"><Textarea rows={3} value={d} onChange={(x) => setD(x.target.value)} placeholder="ex. monentreprise.fr" /></Field>
      </div>
      <div className="mt-2 flex justify-end"><Button size="sm" variant="primary" disabled={busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer"}</Button></div>
    </Card>
  );
}
