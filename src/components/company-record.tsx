"use client";

// La fiche unique : entreprise, personnes, suivi commercial, prospection, tâches et historique.
// Utilisée dans le panneau latéral et sur la page /fiches/[id].
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ExternalLink, Maximize2, X } from "lucide-react";
import {
  addToListAction,
  getCompanyAction,
  removeFromListAction,
  setArchivedAction,
  updateCompanyAction,
} from "@/app/actions";
import type { CompanyDetail, DuplicateCandidate, ProspectStatus } from "@/lib/crm/types";
import { formatDate, formatDateTime, PROSPECT_STATUS_LABELS } from "@/lib/format";
import { useCrm } from "./app-shell";
import { DuplicateNotice } from "./duplicate-notice";
import { RecordDeal } from "./record-deal";
import { RecordPeople } from "./record-people";
import { RecordProspecting } from "./record-prospecting";
import { RecordTasks } from "./record-tasks";
import { RecordTimeline } from "./record-timeline";
import { Badge, Button, Field, Input, Select, Spinner, Textarea } from "./ui";

export type RecordCtx = { detail: CompanyDetail; reload: () => Promise<void> };

export function CompanyRecord({ id, onClose, page }: { id: string; onClose?: () => void; page?: boolean }) {
  const router = useRouter();
  const [detail, setDetail] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const apply = useCallback((res: Awaited<ReturnType<typeof getCompanyAction>>) => {
    setLoading(false);
    if (!res.ok) return setError(res.error);
    if (!res.data) return setError("Fiche introuvable.");
    setError(null);
    setDetail(res.data);
  }, []);
  const load = useCallback(async () => apply(await getCompanyAction(id)), [apply, id]);

  const reload = useCallback(async () => {
    await load();
    router.refresh();
  }, [load, router]);

  // le composant est monté avec key={id} : un changement de fiche repart d'un état vierge
  useEffect(() => {
    let alive = true;
    getCompanyAction(id).then((res) => alive && apply(res));
    return () => {
      alive = false;
    };
  }, [apply, id]);

  if (loading && !detail) {
    return <div className="flex h-40 items-center justify-center"><Spinner /></div>;
  }
  if (error || !detail) {
    return (
      <div className="p-6">
        <p className="text-sm text-danger">{error}</p>
        {onClose && <Button className="mt-3" onClick={onClose}>Fermer</Button>}
      </div>
    );
  }

  const c = detail.company;
  if (c.merged_into_id) {
    return (
      <div className="p-6">
        <p className="font-semibold">La fiche « {c.name} » a été fusionnée.</p>
        <p className="mt-1 text-sm text-muted">Ses contacts et son historique se trouvent dans la fiche conservée.</p>
        <ButtonOpen id={c.merged_into_id} page={page} />
      </div>
    );
  }

  const ctx: RecordCtx = { detail, reload };

  return (
    <div className={page ? "" : "p-5 md:p-6"}>
      <Header ctx={ctx} onClose={onClose} page={page} />
      <div className="mt-5 grid gap-5">
        <Section title="Personnes"><RecordPeople ctx={ctx} /></Section>
        <Section title="Suivi commercial"><RecordDeal key={detail.company.updated_at} ctx={ctx} /></Section>
        <Section title="Prospection"><RecordProspecting ctx={ctx} /><Lists ctx={ctx} /></Section>
        <Section title="Tâches"><RecordTasks ctx={ctx} /></Section>
        <Section title="Historique"><RecordTimeline ctx={ctx} /></Section>
        <Section title="Informations"><InfoForm key={detail.company.updated_at} ctx={ctx} /></Section>
      </div>
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

function Header({ ctx, onClose, page }: { ctx: RecordCtx; onClose?: () => void; page?: boolean }) {
  const c = ctx.detail.company;
  const [busy, setBusy] = useState(false);

  async function setStatus(s: ProspectStatus) {
    const res = await updateCompanyAction(c.id, { prospect_status: s });
    if (!res.ok) return toast.error(res.error);
    await ctx.reload();
  }

  async function toggleArchive() {
    setBusy(true);
    const res = await setArchivedAction([c.id], !c.archived_at);
    setBusy(false);
    if (!res.ok) return toast.error(res.error);
    toast.success(c.archived_at ? "Fiche restaurée" : "Fiche archivée");
    await ctx.reload();
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
            {c.source && <span>· {c.source.name}</span>}
            <span>· Créée le {formatDate(c.created_at)}</span>
            <span>· Modifiée le {formatDateTime(c.updated_at)}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
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
          onChange={(e) => setStatus(e.target.value as ProspectStatus)}
          className="h-8 w-auto text-xs"
          aria-label="Statut de prospection"
        >
          {Object.entries(PROSPECT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>Prospection : {v}</option>)}
        </Select>
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
        <Button size="sm" variant="ghost" onClick={toggleArchive} disabled={busy} className="ml-auto">
          {c.archived_at ? <><ArchiveRestore size={14} /> Restaurer</> : <><Archive size={14} /> Archiver</>}
        </Button>
      </div>
    </header>
  );
}

function InfoForm({ ctx }: { ctx: RecordCtx }) {
  const { sources, openCompany } = useCrm();
  const c = ctx.detail.company;
  const [f, setF] = useState({ name: c.name, website: c.website ?? "", description: c.description ?? "", source_id: c.source_id ?? "", tags: c.tags.join(", ") });
  const [candidates, setCandidates] = useState<DuplicateCandidate[] | null>(null);
  const [pending, setPending] = useState(false);
  const dirty =
    f.name !== c.name || f.website !== (c.website ?? "") || f.description !== (c.description ?? "") ||
    f.source_id !== (c.source_id ?? "") || f.tags !== c.tags.join(", ");


  async function save(force: boolean) {
    setPending(true);
    const res = await updateCompanyAction(
      c.id,
      { name: f.name, website: f.website, description: f.description, source_id: f.source_id || null, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) },
      force,
    );
    setPending(false);
    if (!res.ok) return toast.error(res.error);
    if (res.data.status === "duplicates") return setCandidates(res.data.candidates);
    setCandidates(null);
    toast.success("Fiche enregistrée");
    await ctx.reload();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(false); }} className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
      <Field label="Entreprise *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
      <Field label="Site web / domaine"><Input value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
      <Field label="Source du lead">
        <Select value={f.source_id} onChange={(e) => setF({ ...f, source_id: e.target.value })}>
          <option value="">—</option>
          {sources.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </Field>
      <Field label="Tags" hint="Séparés par des virgules"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
      <Field label="Description / besoin identifié" className="sm:col-span-2">
        <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={3} />
      </Field>
      {candidates && (
        <div className="sm:col-span-2">
          <DuplicateNotice candidates={candidates} onOpen={openCompany} onForce={() => save(true)} forceLabel="Enregistrer quand même" pending={pending} />
        </div>
      )}
      <div className="flex justify-end sm:col-span-2">
        <Button type="submit" variant="primary" size="sm" disabled={!dirty || pending}>Enregistrer</Button>
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
    const res = await addToListAction(listId, [c.id]);
    if (!res.ok) return toast.error(res.error);
    await ctx.reload();
  }
  async function remove(listId: string) {
    const res = await removeFromListAction(listId, [c.id]);
    if (!res.ok) return toast.error(res.error);
    await ctx.reload();
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
