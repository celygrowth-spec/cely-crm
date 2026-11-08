"use client";

// La fiche unique. S'affiche immédiatement avec ce qui est connu (ligne du tableau), puis complète
// en arrière-plan : d'abord la partie légère, l'historique et les fichiers à part.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { updateCompanyAction } from "@/app/actions";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import type { ActivityEntry, ActivityFilter } from "@/lib/crm/record-activity";
import type { CompanyCore, CompanyDetail, CompanyTimeline } from "@/lib/crm/types";
import type { CompanyPatch } from "@/lib/crm/schemas";
import { useCrm, type CompanySeed } from "./app-shell";
import type { ComposeTarget } from "./mail-compose";
import { isEmail } from "@/lib/mail/types";
import { personName } from "@/lib/format";
import type { LogKind } from "./record-log-form";
import { RecordHeader } from "./record-header";
import { RecordOverview } from "./record-overview";
import { Button, Modal, Skeleton } from "./ui";

// L'en-tête et l'Aperçu s'affichent d'abord : le reste ne pèse rien tant qu'on ne l'ouvre pas.
const loadActivity = () => import("./record-activity").then((m) => m.RecordActivity);
const loadDetails = () => import("./record-details").then((m) => m.RecordDetails);
const RecordActivity = dynamic(loadActivity, { loading: () => <Skeleton className="h-40 w-full" /> });
const RecordDetails = dynamic(loadDetails, { loading: () => <Skeleton className="h-40 w-full" /> });
const RecordDiagnostic = dynamic(() => import("./record-diagnostic").then((m) => m.RecordDiagnostic), { loading: () => <Skeleton className="h-40 w-full" /> });
const EntryDetail = dynamic(() => import("./record-entry-detail").then((m) => m.EntryDetail));
const LogForm = dynamic(() => import("./record-log-form").then((m) => m.LogForm), { loading: () => <Skeleton className="h-32 w-full" /> });
const TaskForm = dynamic(() => import("./record-tasks").then((m) => m.TaskForm), { loading: () => <Skeleton className="h-24 w-full" /> });
const MailCompose = dynamic(() => import("./mail-compose").then((m) => m.MailCompose));

type CompanyFields = Partial<CompanyCore["company"]>;

export type RecordTab = "overview" | "activity" | "details" | "diagnostic";
export type DetailsSection = "company" | "deal" | "prospecting" | "files";

export type RecordCtx = {
  detail: CompanyDetail;
  timelineLoading: boolean;
  /** Rafraîchit la fiche et les listes qui l'affichent, sans bloquer l'écran. */
  reload: () => Promise<void>;
  /** Applique tout de suite `optimistic`, lance `send`, rétablit l'état réel en cas d'échec. */
  mutate: (optimistic: CompanyFields, send: () => Promise<{ ok: true } | { ok: false; error: string }>) => Promise<boolean>;
  patch: (fields: CompanyPatch, derived?: CompanyFields) => Promise<boolean>;
  /** Ouvre le composeur d'email. */
  compose: (target: ComposeTarget) => void;
  /** Change d'onglet, avec le filtre de l'Activité ou la section des Détails à montrer. */
  go: (tab: RecordTab, opts?: { filter?: ActivityFilter; section?: DetailsSection; edit?: boolean }) => void;
  filter: ActivityFilter;
  setFilter: (f: ActivityFilter) => void;
  detailsFocus: { section: DetailsSection; edit?: boolean; n: number } | null;
  openEntry: (e: ActivityEntry) => void;
  logExchange: (kind: LogKind) => void;
  newTask: () => void;
  /** Ouvre l'onglet Diagnostic et crée le premier dossier s'il n'y en a pas. */
  generateDiagnostic: () => void;
};

export function CompanyRecord({ id, onClose, page }: { id: string; onClose?: () => void; page?: boolean }) {
  const qc = useQueryClient();
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const [tab, setTab] = useState<RecordTab>("overview");
  const [visited, setVisited] = useState<Set<RecordTab>>(() => new Set(["overview"]));
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const [detailsFocus, setDetailsFocus] = useState<RecordCtx["detailsFocus"]>(null);
  const [entry, setEntry] = useState<ActivityEntry | null>(null);
  const [log, setLog] = useState<LogKind | null>(null);
  const [taskForm, setTaskForm] = useState(false);
  const [diagnosticStart, setDiagnosticStart] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const sync = useSync();
  const coreKey = ["company", id];
  const core = useQuery({ queryKey: coreKey, queryFn: ({ signal }) => apiGet<CompanyCore | null>(`/api/fiches/${id}`, signal) });
  const timeline = useQuery({ queryKey: ["company-timeline", id], queryFn: ({ signal }) => apiGet<CompanyTimeline>(`/api/fiches/${id}/timeline`, signal) });
  const seed = qc.getQueryData<CompanySeed>(["company-seed", id]);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const seq = useRef(0);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(async () => {
    sync(["company", id], ["company-timeline", id], ["companies"], ["pipeline-cards"]);
  }, [sync, id]);

  const retry = useRef<RecordCtx["mutate"] | null>(null);
  const mutate = useCallback<RecordCtx["mutate"]>(
    async (optimistic, send) => {
      const token = ++seq.current;
      if (savedTimer.current) clearTimeout(savedTimer.current);
      setSave("saving");
      // une lecture en cours ne doit pas écraser la modification qu'on vient de faire
      await qc.cancelQueries({ queryKey: ["company", id] });
      qc.setQueryData<CompanyCore | null>(["company", id], (d) => (d ? { ...d, company: { ...d.company, ...optimistic } } : d));
      qc.setQueriesData<{ total: number; rows: Record<string, unknown>[] }>({ queryKey: ["companies"] }, (p) =>
        p?.rows ? { ...p, rows: p.rows.map((r) => (r.id === id ? { ...r, ...optimistic } : r)) } : p,
      );
      const r = await attempt(send);
      if (!r.ok) {
        // retour à l'état réel : relecture depuis le serveur
        qc.invalidateQueries({ queryKey: ["company", id] });
        qc.invalidateQueries({ queryKey: ["companies"] });
        if (token === seq.current) setSave("error");
        toast.error(r.error, { action: { label: "Réessayer", onClick: () => retry.current?.(optimistic, send) } });
        return false;
      }
      // seule la dernière modification relit le serveur : une réponse ancienne n'écrase rien
      if (token === seq.current) {
        setSave("saved");
        savedTimer.current = setTimeout(() => setSave("idle"), 1800);
        sync(["company", id], ["companies"], ["pipeline-cards"]);
      }
      return true;
    },
    [qc, id, sync],
  );

  useEffect(() => {
    retry.current = mutate;
  }, [mutate]);

  const go = useCallback<RecordCtx["go"]>((t, opts) => {
    setTab(t);
    setVisited((v) => (v.has(t) ? v : new Set(v).add(t)));
    if (opts?.filter) setFilter(opts.filter);
    if (opts?.section) {
      const { section, edit } = opts;
      setDetailsFocus((f) => ({ section, edit, n: (f?.n ?? 0) + 1 }));
    } else {
      top.current?.scrollIntoView({ block: "start" });
    }
  }, []);

  // les onglets arrivent sans délai au clic ; la liste des fichiers n'est demandée qu'à l'approche des Détails
  const preload = useCallback(() => {
    loadActivity();
    loadDetails();
    qc.prefetchQuery({ queryKey: ["company-files", id], queryFn: ({ signal }) => apiGet(`/api/fiches/${id}/files`, signal), staleTime: 30_000 });
  }, [id, qc]);

  const patch = useCallback<RecordCtx["patch"]>(
    (fields, derived) =>
      mutate({ ...(fields as CompanyFields), ...derived }, async () => {
        const r = await updateCompanyAction(id, fields);
        if (!r.ok) return r;
        if (r.data.status === "duplicates") return { ok: false, error: "Cette valeur correspond à une autre fiche : ouvrez l'onglet « Détails » pour vérifier." };
        return { ok: true };
      }),
    [mutate, id],
  );

  if (core.isError && !core.data) {
    return (
      <div className="p-6">
        <p className="text-sm text-danger">{core.error.message}</p>
        <div className="mt-3 flex gap-2">
          <Button onClick={() => core.refetch()}>Réessayer</Button>
          {onClose && <Button variant="ghost" onClick={onClose}>Fermer</Button>}
        </div>
      </div>
    );
  }
  if (core.data === null) {
    return (
      <div className="p-6">
        <p className="text-sm text-danger">Fiche introuvable.</p>
        {onClose && <Button className="mt-3" onClick={onClose}>Fermer</Button>}
      </div>
    );
  }

  const body = page ? "pt-4" : "px-4 py-4 md:px-6";

  if (!core.data) {
    // en-tête immédiat avec les données déjà connues, structure réservée pour le reste
    return (
      <div aria-busy="true">
        <div className={page ? "border-b border-line pb-2" : "border-b border-line px-4 pt-3 pb-2 md:px-6"}>
          <div className="flex items-center justify-between gap-3">
            {seed ? <h2 className="truncate font-display text-xl font-extrabold">{seed.name}</h2> : <Skeleton className="h-7 w-56" />}
            {onClose && <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-surface" aria-label="Fermer"><X size={18} /></button>}
          </div>
          <Skeleton className="mt-2 h-8 w-72 max-w-full" />
          <Skeleton className="mt-2 h-8 w-full" />
        </div>
        <div className={`${body} grid gap-5`}>
          {[96, 72, 160].map((h) => <div key={h} style={{ height: h }}><Skeleton className="h-full w-full" /></div>)}
        </div>
      </div>
    );
  }

  const c = core.data.company;
  if (c.merged_into_id) {
    return (
      <div className="p-6">
        <p className="font-semibold">La fiche « {c.name} » a été fusionnée.</p>
        <p className="mt-1 text-sm text-muted">Ses contacts, fichiers et son historique se trouvent dans la fiche conservée.</p>
        <ButtonOpen id={c.merged_into_id} page={page} />
      </div>
    );
  }

  const detail: CompanyDetail = { ...core.data, interactions: timeline.data?.interactions ?? [], claudeLog: timeline.data?.claudeLog ?? [] };
  const openCompose = (t: ComposeTarget) => {
    // le blocage existant porte sur la prospection : un email manuel reste possible, mais jamais par mégarde
    if (!t.message && c.do_not_contact && !confirm(`Cette fiche est marquée « Ne plus contacter »${c.do_not_contact_reason ? ` (${c.do_not_contact_reason})` : ""}.\n\nÉcrire quand même ?`)) return;
    const primary = detail.people.find((p) => p.is_primary && p.email && isEmail(p.email)) ?? detail.people.find((p) => p.email && isEmail(p.email));
    setCompose(t.message || t.to ? t : { personId: primary?.id ?? null, to: primary?.email ?? null });
  };
  const ctx: RecordCtx = {
    detail,
    timelineLoading: timeline.isLoading,
    reload,
    mutate,
    patch,
    compose: openCompose,
    go,
    filter,
    setFilter,
    detailsFocus,
    openEntry: setEntry,
    logExchange: setLog,
    newTask: () => setTaskForm(true),
    generateDiagnostic: () => {
      go("diagnostic");
      setDiagnosticStart((n) => n + 1);
    },
  };

  return (
    <div className="fade-in">
      <div ref={top} className="scroll-mt-40" />
      <RecordHeader ctx={ctx} tab={tab} onClose={onClose} page={page} save={save} onPreload={preload} />
      {/* un onglet déjà ouvert reste monté : ses filtres et une saisie en cours survivent au changement d'onglet */}
      <div className={body}>
        <div role="tabpanel" aria-label="Aperçu" hidden={tab !== "overview"}><RecordOverview ctx={ctx} /></div>
        {visited.has("activity") && <div role="tabpanel" aria-label="Activité" hidden={tab !== "activity"}><RecordActivity ctx={ctx} /></div>}
        {visited.has("details") && <div role="tabpanel" aria-label="Détails" hidden={tab !== "details"}><RecordDetails ctx={ctx} /></div>}
        {visited.has("diagnostic") && <div role="tabpanel" aria-label="Diagnostic" hidden={tab !== "diagnostic"}><RecordDiagnostic companyId={c.id} startSignal={diagnosticStart} /></div>}
      </div>
      {compose && (
        <MailCompose companyId={c.id} target={compose} onClose={() => setCompose(null)}
          contacts={detail.people.filter((p) => p.email && isEmail(p.email)).map((p) => ({ id: p.id, name: personName(p), email: p.email!, title: p.title, primary: p.is_primary }))} />
      )}
      {entry && <EntryDetail key={entry.key} entry={entry} ctx={ctx} onClose={() => setEntry(null)} />}
      <Modal open={!!log} onClose={() => setLog(null)} title={log === "note" ? "Ajouter une note" : "Enregistrer un échange"} wide>
        {log && <LogForm ctx={ctx} initial={log} onDone={() => setLog(null)} />}
      </Modal>
      <Modal open={taskForm} onClose={() => setTaskForm(false)} title="Créer une tâche">
        {taskForm && <TaskForm companyId={c.id} people={detail.people} onDone={async () => { setTaskForm(false); await ctx.reload(); }} />}
      </Modal>
    </div>
  );
}

function ButtonOpen({ id, page }: { id: string; page?: boolean }) {
  const { openCompany } = useCrm();
  return page ? (
    <Link href={`/fiches/${id}`} className="mt-3 inline-block font-semibold text-violet-strong">Ouvrir la fiche conservée</Link>
  ) : (
    <Button className="mt-3" onClick={() => openCompany(id)}>Ouvrir la fiche conservée</Button>
  );
}
