"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DndContext, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { AlertCircle, Plus, Search, Settings2 } from "lucide-react";
import { moveCompanyAction, searchAction } from "@/app/actions";
import { useCrm } from "@/components/app-shell";
import { Badge, Button, Input, Modal, Select, cn } from "@/components/ui";
import type { CompanyOverview, PipelineWithStages, SearchResult } from "@/lib/crm/types";
import { formatAmount, relativeDay, todayISO } from "@/lib/format";
import { NewPipeline } from "../new-pipeline";
import { StageManager } from "./stage-manager";

export function Kanban({
  pipeline,
  pipelines,
  cards: initial,
  dealStatus,
}: {
  pipeline: PipelineWithStages;
  pipelines: PipelineWithStages[];
  cards: CompanyOverview[];
  dealStatus: "open" | "won" | "lost";
}) {
  const router = useRouter();
  const { openCompany, openCreate } = useCrm();
  const [cards, setCards] = useState(initial);
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    // nouvelles données serveur après router.refresh()
    setPrevInitial(initial);
    setCards(initial);
  }
  const [manage, setManage] = useState(false);
  const [addExisting, setAddExisting] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  async function move(companyId: string, stageId: string) {
    const card = cards.find((c) => c.id === companyId);
    if (!card || card.stage_id === stageId) return;
    const otherPipeline = !pipeline.stages.some((s) => s.id === stageId);
    const prev = cards;
    setCards((cs) => (otherPipeline ? cs.filter((c) => c.id !== companyId) : cs.map((c) => (c.id === companyId ? { ...c, stage_id: stageId } : c))));
    const res = await moveCompanyAction(companyId, stageId);
    if (!res.ok) {
      setCards(prev);
      return toast.error(`Déplacement annulé : ${res.error}`);
    }
    if (otherPipeline) toast.success("Fiche transférée vers un autre pipeline");
    router.refresh();
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
          <Select
            value={dealStatus}
            onChange={(e) => router.push(`/pipelines/${pipeline.id}${e.target.value === "open" ? "" : `?statut=${e.target.value}`}`)}
            className="w-auto"
            aria-label="Statut commercial"
          >
            <option value="open">Opportunités ouvertes</option>
            <option value="won">Gagnées</option>
            <option value="lost">Perdues</option>
          </Select>
          {firstStage && <Button onClick={() => openCreate({ stageId: firstStage.id })}><Plus size={14} /> Nouvelle fiche</Button>}
          <Button onClick={() => setAddExisting(true)}><Search size={14} /> Fiche existante</Button>
          <Button variant="ghost" onClick={() => setManage(true)}><Settings2 size={14} /> Étapes</Button>
          <NewPipeline />
        </div>
      </div>

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {pipeline.stages.map((s) => {
            const col = cards.filter((c) => c.stage_id === s.id);
            const total = col.reduce((a, c) => a + (c.amount ?? 0), 0);
            return (
              <Column key={s.id} id={s.id} title={s.name} count={col.length} total={total}>
                {col.map((c) => (
                  <KCard key={c.id} card={c} pipelines={pipelines} onOpen={() => openCompany(c.id)} onMove={(stageId) => move(c.id, stageId)} disabled={dealStatus !== "open"} />
                ))}
              </Column>
            );
          })}
        </div>
      </DndContext>
      {dealStatus !== "open" && <p className="text-xs text-muted">Les fiches gagnées ou perdues restent rattachées à leur dernière étape. Rouvrez-les depuis la fiche pour les déplacer.</p>}

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

function KCard({ card: c, pipelines, onOpen, onMove, disabled }: { card: CompanyOverview; pipelines: PipelineWithStages[]; onOpen: () => void; onMove: (stageId: string) => void; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: c.id, disabled });
  const late = c.next_action_due && c.next_action_due < todayISO();
  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cn("rounded-lg border border-line bg-white p-2.5 shadow-xs", isDragging && "z-10 shadow-lg ring-2 ring-violet")}
      {...attributes}
      {...listeners}
    >
      <button onClick={onOpen} className="block w-full text-left">
        <p className="flex items-center gap-1.5 font-semibold">
          {late && <AlertCircle size={14} className="shrink-0 text-danger" aria-label="En retard" />}
          <span className="truncate">{c.name}</span>
        </p>
        {c.primary_person_name && <p className="truncate text-xs text-muted">{c.primary_person_name}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {c.amount != null && <Badge tone="ink">{formatAmount(c.amount)}</Badge>}
          {c.next_action_title && (
            <span className={cn("truncate text-xs", late ? "font-semibold text-danger" : "text-muted")}>
              {c.next_action_title} · {relativeDay(c.next_action_due)}
            </span>
          )}
        </div>
      </button>
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
  const router = useRouter();
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
    const res = await moveCompanyAction(id, stageId);
    if (!res.ok) return toast.error(res.error);
    toast.success(res.data.stopped_followups ? `Fiche ajoutée · ${res.data.stopped_followups} relance(s) arrêtée(s)` : "Fiche ajoutée au pipeline");
    onClose();
    router.refresh();
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
