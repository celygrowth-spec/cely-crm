"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from "lucide-react";
import {
  createStageAction,
  deletePipelineAction,
  deleteStageAction,
  renamePipelineAction,
  renameStageAction,
  reorderStagesAction,
} from "@/app/actions";
import { Button, Field, Input, Select } from "@/components/ui";
import type { PipelineWithStages, Stage } from "@/lib/crm/types";

export function StageManager({ pipeline, pipelines, onDone }: { pipeline: PipelineWithStages; pipelines: PipelineWithStages[]; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(pipeline.name);
  const [stages, setStages] = useState<Stage[]>(pipeline.stages);
  const [newStage, setNewStage] = useState("");
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const [replacement, setReplacement] = useState("");
  const [deletingPipeline, setDeletingPipeline] = useState(false);
  const others = pipelines.filter((p) => p.id !== pipeline.id);

  const err = (r: { ok: boolean; error?: string }) => { if (!r.ok) toast.error(r.error); return r.ok; };

  async function rename() {
    if (err(await renamePipelineAction(pipeline.id, name))) { toast.success("Pipeline renommé"); router.refresh(); }
  }
  async function renameStage(s: Stage, n: string) {
    if (n === s.name) return;
    if (err(await renameStageAction(s.id, n))) router.refresh();
  }
  async function reorder(i: number, d: -1 | 1) {
    const n = [...stages];
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setStages(n);
    if (!err(await reorderStagesAction(pipeline.id, n.map((s) => s.id)))) setStages(stages);
    else router.refresh();
  }
  async function add() {
    if (!newStage.trim()) return;
    if (err(await createStageAction(pipeline.id, newStage))) { setNewStage(""); onDone(); }
  }
  async function confirmDeleteStage() {
    if (!deleting) return;
    if (err(await deleteStageAction(deleting.id, replacement || null))) { toast.success("Étape supprimée"); setDeleting(null); onDone(); }
  }
  async function confirmDeletePipeline() {
    if (err(await deletePipelineAction(pipeline.id, replacement || null))) {
      toast.success("Pipeline supprimé");
      router.push("/pipelines");
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end gap-2">
        <Field label="Nom du pipeline" className="flex-1"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Button onClick={rename} disabled={name === pipeline.name || !name.trim()}><Check size={14} /> Renommer</Button>
      </div>

      <div>
        <p className="mb-2 font-label text-xs font-semibold text-muted">Étapes</p>
        <ul className="space-y-1.5">
          {stages.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1">
              <Input defaultValue={s.name} onBlur={(e) => renameStage(s, e.target.value)} className="flex-1" aria-label="Nom de l'étape" />
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => reorder(i, -1)} aria-label="Monter"><ArrowUp size={14} /></Button>
              <Button size="sm" variant="ghost" disabled={i === stages.length - 1} onClick={() => reorder(i, 1)} aria-label="Descendre"><ArrowDown size={14} /></Button>
              <Button size="sm" variant="ghost" onClick={() => { setDeleting(s); setReplacement(stages.find((x) => x.id !== s.id)?.id ?? ""); }} aria-label="Supprimer"><Trash2 size={14} /></Button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex gap-2">
          <Input value={newStage} onChange={(e) => setNewStage(e.target.value)} placeholder="Nouvelle étape" onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button onClick={add}><Plus size={14} /> Ajouter</Button>
        </div>
      </div>

      {deleting && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
          <p className="text-sm font-semibold">Supprimer l&apos;étape « {deleting.name} »</p>
          <p className="mt-1 text-xs text-muted">Les fiches de cette étape (y compris gagnées ou perdues) seront déplacées vers l&apos;étape choisie. Aucune fiche n&apos;est supprimée.</p>
          <Select value={replacement} onChange={(e) => setReplacement(e.target.value)} className="mt-2">
            <option value="">Aucune (seulement si l&apos;étape est vide)</option>
            {pipelines.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.stages.filter((s) => s.id !== deleting.id).map((s) => <option key={s.id} value={s.id}>{p.name} › {s.name}</option>)}
              </optgroup>
            ))}
          </Select>
          <div className="mt-2 flex justify-end gap-2">
            <Button size="sm" onClick={() => setDeleting(null)}>Annuler</Button>
            <Button size="sm" variant="danger" onClick={confirmDeleteStage}>Supprimer l&apos;étape</Button>
          </div>
        </div>
      )}

      <div className="border-t border-line pt-4">
        {!deletingPipeline ? (
          <Button variant="danger" size="sm" onClick={() => { setDeletingPipeline(true); setReplacement(others[0]?.stages[0]?.id ?? ""); }}>Supprimer ce pipeline</Button>
        ) : (
          <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
            <p className="text-sm font-semibold">Supprimer le pipeline « {pipeline.name} »</p>
            <p className="mt-1 text-xs text-muted">Choisissez où déplacer ses fiches. L&apos;historique des fiches est conservé.</p>
            <Select value={replacement} onChange={(e) => setReplacement(e.target.value)} className="mt-2">
              <option value="">Aucune destination (seulement si le pipeline est vide)</option>
              {others.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  {p.stages.map((s) => <option key={s.id} value={s.id}>{p.name} › {s.name}</option>)}
                </optgroup>
              ))}
            </Select>
            <div className="mt-2 flex justify-end gap-2">
              <Button size="sm" onClick={() => setDeletingPipeline(false)}>Annuler</Button>
              <Button size="sm" variant="danger" onClick={confirmDeletePipeline}>Supprimer définitivement</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
