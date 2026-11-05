"use client";

// La fiche unique. S'affiche immédiatement avec ce qui est connu (ligne du tableau), puis complète
// en arrière-plan : d'abord la partie légère, l'historique et les fichiers à part.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ExternalLink, Maximize2, X } from "lucide-react";
import { addToListAction, removeFromListAction, setArchivedAction, updateCompanyAction } from "@/app/actions";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import type { CompanyCore, CompanyDetail, CompanyTimeline, DuplicateCandidate, LeadSource, ProspectStatus } from "@/lib/crm/types";
import type { CompanyPatch } from "@/lib/crm/schemas";
import { formatDate, formatDateTime, PROSPECT_STATUS_LABELS } from "@/lib/format";
import { useCrm, type CompanySeed } from "./app-shell";
import { DuplicateNotice } from "./duplicate-notice";
import { RecordDeal } from "./record-deal";
import { RecordPeople } from "./record-people";
import type { ComposeTarget } from "./mail-compose";
import { RecordProspecting } from "./record-prospecting";
import { RecordTasks } from "./record-tasks";
import { RecordTimeline } from "./record-timeline";
import { SourcePicker } from "./source-picker";
import { Badge, Button, Field, Input, SaveIndicator, Select, Skeleton, Textarea } from "./ui";

// section chargée à la demande : ne pèse pas sur l'ouverture de la fiche
const RecordFiles = dynamic(() => import("./record-files").then((m) => m.RecordFiles), {
  loading: () => <Skeleton className="h-20 w-full" />,
});

// idem : le composeur et la section Emails ne pèsent rien tant qu'on ne s'en sert pas
const RecordMail = dynamic(() => import("./record-mail").then((m) => m.RecordMail), {
  loading: () => <Skeleton className="h-12 w-full" />,
});
const MailCompose = dynamic(() => import("./mail-compose").then((m) => m.MailCompose));

type CompanyFields = Partial<CompanyCore["company"]>;

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
};

export function CompanyRecord({ id, onClose, page }: { id: string; onClose?: () => void; page?: boolean }) {
  const qc = useQueryClient();
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const sync = useSync();
  const coreKey = ["company", id];
  const core = useQuery({ queryKey: coreKey, queryFn: ({ signal }) => apiGet<CompanyCore | null>(`/api/fiches/${id}`, signal) });
  const timeline = useQuery({ queryKey: ["company-timeline", id], queryFn: ({ signal }) => apiGet<CompanyTimeline>(`/api/fiches/${id}/timeline`, signal) });
  // lancé avec le reste de la fiche : la section Fichiers, chargée à la demande, trouve sa liste déjà prête
  useEffect(() => {
    qc.prefetchQuery({ queryKey: ["company-files", id], queryFn: ({ signal }) => apiGet(`/api/fiches/${id}/files`, signal) });
  }, [id, qc]);
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

  const patch = useCallback<RecordCtx["patch"]>(
    (fields, derived) =>
      mutate({ ...(fields as CompanyFields), ...derived }, async () => {
        const r = await updateCompanyAction(id, fields);
        if (!r.ok) return r;
        if (r.data.status === "duplicates") return { ok: false, error: "Cette valeur correspond à une autre fiche : ouvrez « Informations » pour vérifier." };
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

  const wrap = page ? "" : "p-5 md:p-6";

  if (!core.data) {
    // en-tête immédiat avec les données déjà connues, structure réservée pour le reste
    return (
      <div className={wrap} aria-busy="true">
        <div className="flex items-start justify-between gap-3">
          {seed ? <h2 className="font-display text-2xl font-extrabold break-words">{seed.name}</h2> : <Skeleton className="h-8 w-64" />}
          {onClose && <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-surface" aria-label="Fermer"><X size={18} /></button>}
        </div>
        <Skeleton className="mt-2 h-4 w-72 max-w-full" />
        <Skeleton className="mt-3 h-8 w-52" />
        <div className="mt-6 space-y-5">
          {[56, 112, 48, 72].map((h) => <div key={h} style={{ height: h }}><Skeleton className="h-full w-full" /></div>)}
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
    const primary = detail.people.find((p) => p.is_primary && p.email) ?? detail.people.find((p) => p.email);
    setCompose(t.message || t.to ? t : { personId: primary?.id ?? null, to: primary?.email ?? null });
  };
  const ctx: RecordCtx = { detail, timelineLoading: timeline.isLoading, reload, mutate, patch, compose: openCompose };

  return (
    <div className={`${wrap} fade-in`}>
      <Header ctx={ctx} onClose={onClose} page={page} save={save} />
      <div className="mt-5 grid gap-5">
        <Section title="Personnes"><RecordPeople ctx={ctx} /></Section>
        <Section title="Suivi commercial"><RecordDeal key={c.id} ctx={ctx} /></Section>
        <Section title="Prospection"><RecordProspecting ctx={ctx} /><Lists ctx={ctx} /></Section>
        <Section title="Tâches"><RecordTasks ctx={ctx} /></Section>
        <Section title="Emails"><RecordMail companyId={c.id} onCompose={openCompose} /></Section>
        <Section title="Fichiers"><RecordFiles companyId={c.id} /></Section>
        <Section title="Historique"><RecordTimeline ctx={ctx} /></Section>
        <Section title="Informations"><InfoForm key={c.id} ctx={ctx} /></Section>
      </div>
      {compose && <MailCompose companyId={c.id} target={compose} onClose={() => setCompose(null)} />}
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 font-label text-xs font-bold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Header({ ctx, onClose, page, save }: { ctx: RecordCtx; onClose?: () => void; page?: boolean; save: "idle" | "saving" | "saved" | "error" }) {
  const { sources } = useCrm();
  const c = ctx.detail.company;

  function setSource(id: string | null, s: LeadSource | null) {
    ctx.patch({ source_id: id }, { source: s ? { id: s.id, name: s.name, color: s.color } : null });
  }
  async function toggleArchive() {
    const value = !c.archived_at;
    const ok = await ctx.mutate({ archived_at: value ? new Date().toISOString() : null }, async () => {
      const r = await attempt(() => setArchivedAction([c.id], value));
      return r.ok ? { ok: true } : r;
    });
    if (ok) toast.success(value ? "Fiche archivée" : "Fiche restaurée");
  }

  return (
    <header>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-extrabold break-words">{c.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {c.website && (
              <a
                href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-violet-strong hover:underline"
              >
                {c.domain_norm ?? c.website} <ExternalLink size={12} />
              </a>
            )}
            <span>· Créée le {formatDate(c.created_at)}</span>
            <span>· Modifiée le {formatDateTime(c.updated_at)}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SaveIndicator state={save} />
          {!page && (
            <Link href={`/fiches/${c.id}`} className="rounded-md p-1.5 text-muted hover:bg-surface" aria-label="Ouvrir en pleine page" title="Pleine page">
              <Maximize2 size={16} />
            </Link>
          )}
          {onClose && (
            <button onClick={onClose} className="rounded-md p-1.5 text-muted hover:bg-surface" aria-label="Fermer">
              <X size={18} />
            </button>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Select
          value={c.prospect_status}
          onChange={(e) => ctx.patch({ prospect_status: e.target.value as ProspectStatus })}
          className="h-8 w-auto text-xs"
          aria-label="Statut de prospection"
        >
          {Object.entries(PROSPECT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>Prospection : {v}</option>)}
        </Select>
        <SourcePicker sources={sources} value={c.source_id} onChange={setSource} placeholder="Source du contact" className="w-52 [&>button]:h-8 [&>button]:text-xs" />
        {c.pipeline && (
          <Badge tone={c.deal_status === "won" ? "success" : c.deal_status === "lost" ? "danger" : "violet"}>
            {c.pipeline.name} › {c.stage?.name ?? "—"}
            {c.deal_status === "won" && " · Gagné"}
            {c.deal_status === "lost" && " · Perdu"}
          </Badge>
        )}
        {c.last_interaction_at && <Badge>Dernier échange : {formatDate(c.last_interaction_at)}</Badge>}
        {c.tags.map((t) => <Badge key={t} tone="neutral">#{t}</Badge>)}
        {c.archived_at && <Badge tone="warning">Archivée</Badge>}
        <Button size="sm" variant="ghost" onClick={toggleArchive} className="ml-auto">
          {c.archived_at ? <><ArchiveRestore size={14} /> Restaurer</> : <><Archive size={14} /> Archiver</>}
        </Button>
      </div>
    </header>
  );
}

function InfoForm({ ctx }: { ctx: RecordCtx }) {
  const { openCompany } = useCrm();
  const c = ctx.detail.company;
  const server = { name: c.name, website: c.website ?? "", description: c.description ?? "", tags: c.tags.join(", ") };
  const [f, setF] = useState(server);
  const [baseline, setBaseline] = useState(server);
  const serverKey = JSON.stringify(server);
  const [prevKey, setPrevKey] = useState(serverKey);
  const [candidates, setCandidates] = useState<DuplicateCandidate[] | null>(null);
  const [pending, setPending] = useState(false);

  // suit le serveur sans jamais effacer une saisie en cours
  if (serverKey !== prevKey) {
    setPrevKey(serverKey);
    if (JSON.stringify(f) === JSON.stringify(baseline)) setF(server);
    setBaseline(server);
  }
  const dirty = JSON.stringify(f) !== JSON.stringify(baseline);

  async function save(force: boolean) {
    setPending(true);
    const tags = f.tags.split(",").map((t) => t.trim()).filter(Boolean);
    const r = await attempt(() => updateCompanyAction(c.id, { name: f.name, website: f.website, description: f.description, tags }, force));
    setPending(false);
    if (!r.ok) return toast.error(r.error, { action: { label: "Réessayer", onClick: () => save(force) } });
    if (r.data.status === "duplicates") return setCandidates(r.data.candidates);
    setCandidates(null);
    setBaseline(f);
    toast.success("Fiche enregistrée");
    ctx.reload();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(false); }} className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
      <Field label="Entreprise *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
      <Field label="Site web / domaine"><Input value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
      <Field label="Tags" hint="Séparés par des virgules" className="sm:col-span-2"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
      <Field label="Description / besoin identifié" className="sm:col-span-2">
        <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} />
      </Field>
      {candidates && (
        <div className="sm:col-span-2">
          <DuplicateNotice candidates={candidates} onOpen={openCompany} onForce={() => save(true)} forceLabel="Enregistrer quand même" pending={pending} />
        </div>
      )}
      <div className="flex justify-end sm:col-span-2">
        <Button type="submit" variant="primary" size="sm" disabled={!dirty || pending}>{pending ? "Enregistrement…" : "Enregistrer"}</Button>
      </div>
    </form>
  );
}

function Lists({ ctx }: { ctx: RecordCtx }) {
  const { lists } = useCrm();
  const c = ctx.detail.company;
  const mine = new Set(ctx.detail.lists.map((l) => l.id));
  const available = lists.filter((l) => !mine.has(l.id));

  async function add(listId: string) {
    if (!listId) return;
    const res = await attempt(() => addToListAction(listId, [c.id]));
    if (!res.ok) return toast.error(res.error);
    ctx.reload();
  }
  async function remove(listId: string) {
    const res = await attempt(() => removeFromListAction(listId, [c.id]));
    if (!res.ok) return toast.error(res.error);
    ctx.reload();
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted">Listes :</span>
      {ctx.detail.lists.map((l) => (
        <Badge key={l.id} tone="violet">
          {l.name}
          <button onClick={() => remove(l.id)} aria-label={`Retirer de ${l.name}`} className="hover:text-danger"><X size={11} /></button>
        </Badge>
      ))}
      {available.length > 0 && (
        <Select value="" onChange={(e) => add(e.target.value)} className="h-7 w-auto text-xs" aria-label="Ajouter à une liste">
          <option value="">+ Ajouter à une liste</option>
          {available.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      )}
      {!lists.length && <span className="text-xs text-muted">aucune liste créée</span>}
    </div>
  );
}
