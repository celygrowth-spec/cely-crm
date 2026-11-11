"use client";

import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import { toast } from "sonner";
import { DndContext, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { AlertCircle, Plus, Search, Settings2, Trophy } from "lucide-react";
import { moveCompanyAction, searchAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, EmptyState, Input, Modal, Select, Skeleton, cn } from "@/components/ui";
import type { CompanyOverview, PipelineWithStages, SearchResult } from "@/lib/crm/types";
import { formatAmount, relativeDay, todayISO } from "@/lib/format";
import { CardClosingMenu } from "@/components/deal-closing";
import { NewPipeline } from "../new-pipeline";
import { StageManager } from "./stage-manager";

type Card = Pick<CompanyOverview, "id" | "name" | "stage_id" | "amount" | "amount_recurring" | "primary_person_name" | "next_action_title" | "next_action_due" | "deal_status" | "deal_closed_at" | "lost_reason">;

export function Kanban({ pipelineId }: { pipelineId: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { pipelines, openCompany, openCreate, prefetchCompany } = useCrm();
  // Pipelines = opportunités ouvertes ; les ventes gagnées ou perdues sont dans Ventes
  const dealStatus = "open" as const;
  const pipeline = pipelines.find((p) => p.id === pipelineId);
  const key = ["pipeline-cards", pipelineId, dealStatus];
  const { data: cards = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => apiGet<Card[]>(`/api/pipelines/${pipelineId}/cards?statut=${dealStatus}`, signal),
    enabled: !!pipeline,
  });
  const [manage, setManage] = useState(false);
  const [addExisting, setAddExisting] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  if (!pipeline) return <EmptyState title="Pipeline introuvable" action={<Link href="/pipelines" className="font-semibold text-violet-strong">Voir les pipelines →</Link>} />;

  async function move(companyId: string, stageId: string) {
    const card = cards.find((c) => c.id === companyId);
    if (!card || card.stage_id === stageId) return;
    const otherPipeline = !pipeline!.stages.some((s) => s.id === stageId);
    // la carte bouge tout de suite ; seule cette liste est touchée, rien n'est rechargé
    await qc.cancelQueries({ queryKey: key });
    const prev = qc.getQueryData<Card[]>(key);
    qc.setQueryData<Card[]>(key, (cs = []) => (otherPipeline ? cs.filter((c) => c.id !== companyId) : cs.map((c) => (c.id === companyId ? { ...c, stage_id: stageId } : c))));
    const res = await attempt(() => moveCompanyAction(companyId, stageId));
    if (!res.ok) {
      qc.setQueryData(key, prev);
      return toast.error(`Déplacement annulé : ${res.error}`, { action: { label: "Réessayer", onClick: () => move(companyId, stageId) } });
    }
    if (otherPipeline) {
      toast.success("Fiche transférée vers un autre pipeline");
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    }
    qc.invalidateQueries({ queryKey: ["company", companyId] });
    qc.invalidateQueries({ queryKey: ["company-timeline", companyId] });
    qc.invalidateQueries({ queryKey: ["companies"] });
  }

  /** Clôture ou réouverture depuis une carte : elle quitte cette vue, les autres vues et compteurs se relisent. */
  function closed(companyId: string) {
    qc.setQueryData<Card[]>(key, (cs = []) => cs.filter((c) => c.id !== companyId));
  }

  function onDragEnd(e: DragEndEvent) {
    if (e.over) move(String(e.active.id), String(e.over.id));
  }

  const firstStage = pipeline.stages[0];

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {pipelines.map((p) => (
            <Link
              key={p.id}
              href={`/pipelines/${p.id}`}
              className={cn(
                "rounded-lg px-3 py-1.5 font-display text-base font-bold",
                p.id === pipeline.id ? "bg-ink text-white" : "text-muted hover:bg-surface hover:text-ink",
              )}
            >
              {p.name}
            </Link>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link href="/ventes" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface" data-ventes-link>
            <Trophy size={14} /> Ventes gagnées et perdues
          </Link>
          {firstStage && <Button onClick={() => openCreate({ stageId: firstStage.id })}><Plus size={14} /> Nouvelle fiche</Button>}
          <Button onClick={() => setAddExisting(true)}><Search size={14} /> Fiche existante</Button>
          <Button variant="ghost" onClick={() => setManage(true)}><Settings2 size={14} /> Étapes</Button>
          <NewPipeline />
        </div>
      </div>

      {isError && <p className="mb-2 text-sm text-danger">{error.message} <button className="underline" onClick={() => refetch()}>Réessayer</button></p>}
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {pipeline.stages.map((s) => {
            const col = cards.filter((c) => c.stage_id === s.id);
            const total = col.reduce((a, c) => a + (c.amount ?? 0), 0);
            return (
              <Column key={s.id} id={s.id} title={s.name} count={col.length} total={total}>
                {isLoading && [0, 1].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
                {col.map((c) => (
                  <KCard key={c.id} card={c} pipelines={pipelines} onOpen={() => openCompany(c.id, { name: c.name })} onHover={() => prefetchCompany(c.id)} onMove={(stageId) => move(c.id, stageId)} disabled={dealStatus !== "open"} onClosed={() => closed(c.id)} />
                ))}
              </Column>
            );
          })}
        </div>
      </DndContext>

      <Modal open={manage} onClose={() => setManage(false)} title={`Pipeline « ${pipeline.name} »`} wide>
        <StageManager pipeline={pipeline} pipelines={pipelines} onDone={() => { setManage(false); router.refresh(); }} />
      </Modal>
      <AddExisting open={addExisting} onClose={() => setAddExisting(false)} pipeline={pipeline} />
    </div>
  );
}

function Column({ id, title, count, total, children }: { id: string; title: string; count: number; total: number; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div ref={setNodeRef} className={cn("flex w-72 shrink-0 flex-col rounded-xl border border-line bg-surface p-2", isOver && "border-violet bg-violet-soft")}>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <p className="font-label text-sm font-bold">{title} <span className="font-normal text-muted">{count}</span></p>
        {total > 0 && <p className="font-label text-xs text-muted">{formatAmount(total)}</p>}
      </div>
      <div className="flex min-h-24 flex-col gap-2">{children}</div>
    </div>
  );
}

function KCard({ card: c, pipelines, onOpen, onHover, onMove, disabled, onClosed }: { card: Card; pipelines: PipelineWithStages[]; onOpen: () => void; onHover: () => void; onMove: (stageId: string) => void; disabled: boolean; onClosed: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: c.id, disabled });
  const late = c.next_action_due && c.next_action_due < todayISO();
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      onMouseEnter={onHover}
      className={cn("row-in rounded-lg border border-line bg-white p-2.5 shadow-xs", isDragging && "z-10 shadow-lg ring-2 ring-violet")}
      {...(disabled ? {} : attributes)}
      {...(disabled ? {} : listeners)}
    >
      <div className="flex items-start gap-1">
      <button onClick={onOpen} className="block min-w-0 flex-1 text-left">
        <p className="flex items-center gap-1.5 font-semibold">
          {late && c.deal_status === "open" && <AlertCircle size={14} className="shrink-0 text-danger" aria-label="En retard" />}
          <span className="truncate">{c.name}</span>
        </p>
        {c.primary_person_name && <p className="truncate text-xs text-muted">{c.primary_person_name}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {c.amount != null && <Badge tone="ink">{formatAmount(c.amount, c.amount_recurring)}</Badge>}
          {c.deal_status === "open" && c.next_action_title && (
            <span className={cn("truncate text-xs", late ? "font-semibold text-danger" : "text-muted")}>
              {c.next_action_title} · {relativeDay(c.next_action_due)}
            </span>
          )}
        </div>
      </button>
      <CardClosingMenu target={{ id: c.id, name: c.name, deal_status: c.deal_status, amount: c.amount, deal_closed_at: c.deal_closed_at, lost_reason: c.lost_reason }} onChanged={onClosed} />
      </div>
      {!disabled && (
        <Select
          value=""
          onChange={(e) => e.target.value && onMove(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="mt-2 h-7 text-xs text-muted"
          aria-label={`Déplacer ${c.name}`}
        >
          <option value="">Déplacer vers…</option>
          {pipelines.map((p) => (
            <optgroup key={p.id} label={p.name}>
              {p.stages.filter((s) => s.id !== c.stage_id).map((s) => <option key={s.id} value={s.id}>{p.name} › {s.name}</option>)}
            </optgroup>
          ))}
        </Select>
      )}
    </div>
  );
}

function AddExisting({ open, onClose, pipeline }: { open: boolean; onClose: () => void; pipeline: PipelineWithStages }) {
  const sync = useSync();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [stageId, setStageId] = useState(pipeline.stages[0]?.id ?? "");

  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(async () => {
      const res = await searchAction(q);
      if (res.ok) setResults(res.data);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  async function add(id: string) {
    const res = await attempt(() => moveCompanyAction(id, stageId));
    if (!res.ok) return toast.error(res.error);
    toast.success(res.data.stopped_followups ? `Fiche ajoutée · ${res.data.stopped_followups} relance(s) arrêtée(s)` : "Fiche ajoutée au pipeline");
    onClose();
    sync(["pipeline-cards"], ["companies"], ["company", id]);
  }

  return (
    <Modal open={open} onClose={onClose} title="Ajouter une fiche existante">
      <div className="space-y-3">
        <Select value={stageId} onChange={(e) => setStageId(e.target.value)} aria-label="Étape">
          {pipeline.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une fiche" autoFocus />
        <ul className="divide-y divide-line">
          {(q.trim() ? results : []).map((r) => (
            <li key={r.id} className="flex items-center justify-between py-2">
              <span className="font-semibold">{r.name}</span>
              <Button size="sm" onClick={() => add(r.id)}>Ajouter</Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">La fiche est déplacée (jamais copiée). Si elle est déjà dans un autre pipeline, elle est transférée.</p>
      </div>
    </Modal>
  );
}
