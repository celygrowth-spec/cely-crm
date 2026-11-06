"use client";

// Onglet Détails : des lignes courtes à lire, un clic sur « Modifier » ouvre l'édition de la section.
import dynamic from "next/dynamic";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ExternalLink, X } from "lucide-react";
import { addToListAction, removeFromListAction, updateCompanyAction } from "@/app/actions";
import { attempt } from "@/lib/client/query";
import type { DuplicateCandidate, LeadSource, ProspectStatus } from "@/lib/crm/types";
import { DEAL_STATUS_LABELS, PROSPECT_STATUS_LABELS, formatAmount, formatDate, formatDateTime } from "@/lib/format";
import { useCrm } from "./app-shell";
import type { DetailsSection, RecordCtx } from "./company-record";
import { DuplicateNotice } from "./duplicate-notice";
import { RecordDeal } from "./record-deal";
import { RecordPeople } from "./record-people";
import { RecordProspecting } from "./record-prospecting";
import { SourcePicker, SourceBadge } from "./source-picker";
import { Badge, Button, Field, Input, Select, Skeleton, Textarea } from "./ui";

const RecordFiles = dynamic(() => import("./record-files").then((m) => m.RecordFiles), {
  loading: () => <Skeleton className="h-20 w-full" />,
});
const RecordProjects = dynamic(() => import("./record-projects").then((m) => m.RecordProjects), {
  loading: () => <Skeleton className="h-10 w-full" />,
});

export function RecordDetails({ ctx }: { ctx: RecordCtx }) {
  const [editing, setEditing] = useState<DetailsSection | null>(null);
  const focus = ctx.detailsFocus;
  const [seen, setSeen] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  if (focus && focus.n !== seen) {
    setSeen(focus.n);
    if (focus.edit) setEditing(focus.section);
  }
  useEffect(() => {
    if (focus) root.current?.querySelector(`[data-section="${focus.section}"]`)?.scrollIntoView({ block: "start" });
  }, [focus]);
  const toggle = (s: DetailsSection) => () => setEditing(editing === s ? null : s);
  const c = ctx.detail.company;

  return (
    <div ref={root} className="grid gap-6">
      <Section id="company" title="Entreprise et personnes" editing={editing === "company"} onToggle={toggle("company")}>
        {editing === "company" ? (
          <CompanyEdit key={c.id} ctx={ctx} onDone={() => setEditing(null)} />
        ) : (
          <Rows>
            <Row label="Site">
              {c.website ? (
                <a href={/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-violet-strong hover:underline">
                  {c.domain_norm ?? c.website} <ExternalLink size={12} />
                </a>
              ) : "—"}
            </Row>
            <Row label="Source">{c.source ? <SourceBadge source={{ name: c.source.name, color: c.source.color ?? "slate" }} /> : "—"}</Row>
            {c.tags.length > 0 && <Row label="Tags"><span className="flex flex-wrap gap-1">{c.tags.map((t) => <Badge key={t}>#{t}</Badge>)}</span></Row>}
            <Row label="Description">{c.description ? <span className="break-words whitespace-pre-line">{c.description}</span> : "—"}</Row>
            <Row label="Dernier échange">{c.last_interaction_at ? formatDate(c.last_interaction_at) : "—"}</Row>
            <Row label="Créée le">{formatDate(c.created_at)}</Row>
            <Row label="Modifiée le">{formatDateTime(c.updated_at)}</Row>
          </Rows>
        )}
        <div className="mt-3">
          <h4 className="mb-1.5 text-xs font-semibold text-muted">Personnes</h4>
          <RecordPeople ctx={ctx} />
        </div>
      </Section>

      <Section id="deal" title="Suivi commercial" editing={editing === "deal"} onToggle={toggle("deal")}>
        {editing === "deal" ? (
          <RecordDeal key={c.id} ctx={ctx} />
        ) : c.pipeline_id ? (
          <Rows>
            <Row label="Pipeline">{c.pipeline?.name ?? "—"}</Row>
            <Row label="Étape">{c.stage?.name ?? "—"}</Row>
            <Row label="Statut">
              <Badge tone={c.deal_status === "won" ? "success" : c.deal_status === "lost" ? "danger" : "violet"}>{DEAL_STATUS_LABELS[c.deal_status]}</Badge>
              {c.deal_status === "lost" && c.lost_reason && <span className="ml-2 text-muted">{c.lost_reason}</span>}
            </Row>
            <Row label="Montant potentiel">{c.amount != null ? formatAmount(c.amount) : "—"}</Row>
            <Row label="Signature estimée">{c.expected_close_date ? formatDate(c.expected_close_date) : "—"}</Row>
          </Rows>
        ) : (
          <p className="text-sm text-muted">Cette fiche n&apos;est dans aucun pipeline.</p>
        )}
      </Section>

      <Section id="prospecting" title="Prospection" editing={editing === "prospecting"} onToggle={toggle("prospecting")}>
        {editing === "prospecting" ? (
          <div className="grid gap-3">
            <Field label="Statut de prospection">
              <Select value={c.prospect_status} onChange={(e) => ctx.patch({ prospect_status: e.target.value as ProspectStatus })} className="max-w-64">
                {Object.entries(PROSPECT_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Lists ctx={ctx} />
            <RecordProspecting ctx={ctx} editing />
          </div>
        ) : (
          <div className="grid gap-2">
            <Rows>
              <Row label="Statut">{PROSPECT_STATUS_LABELS[c.prospect_status]}</Row>
              <Row label="Listes">{ctx.detail.lists.length ? <span className="flex flex-wrap gap-1">{ctx.detail.lists.map((l) => <Badge key={l.id} tone="violet">{l.name}</Badge>)}</span> : "Aucune"}</Row>
            </Rows>
            <RecordProspecting ctx={ctx} />
          </div>
        )}
      </Section>

      <Section id="files" title="Fichiers et projets">
        <div className="grid gap-3">
          <RecordFiles companyId={c.id} />
          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-muted">Projets</h4>
            <RecordProjects companyId={c.id} companyName={c.name} />
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ id, title, editing, onToggle, children }: { id: DetailsSection; title: string; editing?: boolean; onToggle?: () => void; children: ReactNode }) {
  return (
    <section data-section={id} className="scroll-mt-36">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-label text-xs font-bold tracking-wide text-muted uppercase">{title}</h3>
        {onToggle && <Button size="sm" variant="ghost" onClick={onToggle} aria-expanded={!!editing}>{editing ? "Fermer" : "Modifier"}</Button>}
      </div>
      {children}
    </section>
  );
}

const Rows = ({ children }: { children: ReactNode }) => <dl className="grid gap-y-1 text-sm">{children}</dl>;
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function CompanyEdit({ ctx, onDone }: { ctx: RecordCtx; onDone: () => void }) {
  const { sources, openCompany } = useCrm();
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

  function setSource(id: string | null, s: LeadSource | null) {
    ctx.patch({ source_id: id }, { source: s ? { id: s.id, name: s.name, color: s.color } : null });
  }

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
    onDone();
  }

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(false); }} className="grid gap-3 rounded-xl border border-line p-3 sm:grid-cols-2">
      <Field label="Entreprise *"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></Field>
      <Field label="Site web / domaine"><Input value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></Field>
      <Field label="Source du contact"><SourcePicker sources={sources} value={c.source_id} onChange={setSource} placeholder="Source du contact" /></Field>
      <Field label="Tags" hint="Séparés par des virgules"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
      <Field label="Description / besoin identifié" className="sm:col-span-2">
        <Textarea value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} rows={6} />
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
    <div className="flex flex-wrap items-center gap-2">
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
