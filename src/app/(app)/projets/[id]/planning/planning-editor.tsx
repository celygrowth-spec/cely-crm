"use client";

// Planning : phases (dates prévues ET statut réel, distincts) et jalons, avec aperçu de la timeline client.
import { useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { savePlanningAction } from "@/app/projets-actions";
import { Button, Card, EmptyState, Input, Select, Textarea, cn } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import { PHASE_COLORS, PHASE_STATUS_LABELS, type Milestone, type Phase, type PhaseColor, type PhaseStatus, type Project } from "@/lib/projects/types";
import { PHASE_STYLES, TimelineVisual } from "@/components/portal/timeline";
import { VisibilityTag } from "../general";

type DPhase = Omit<Phase, "id" | "completed_at"> & { id?: string; key: string };
type DMilestone = Omit<Milestone, "id"> & { id?: string; key: string; visible_to_client: boolean };
let n = 0;
const key = () => `k${++n}`;
const TEMPLATE = ["Cadrage", "Préparation", "Production", "Retours", "Livraison"];
const TEMPLATE_COLORS: PhaseColor[] = ["violet", "blue", "teal", "amber", "green"];

function addDays(d: string, k: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + k);
  return x.toISOString().slice(0, 10);
}

export function PlanningEditor({ project, initial, today }: { project: Project; initial: { phases: Phase[]; milestones: (Milestone & { visible_to_client: boolean })[] }; today: string }) {
  const sync = useSync();
  const [phases, setPhases] = useState<DPhase[]>(() => initial.phases.map((p) => ({ ...p, key: p.id })));
  const [ms, setMs] = useState<DMilestone[]>(() => initial.milestones.map((m) => ({ ...m, key: m.id })));
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const up = (k: string, patch: Partial<DPhase>) => { setPhases(phases.map((p) => (p.key === k ? { ...p, ...patch } : p))); setDirty(true); };
  const upM = (k: string, patch: Partial<DMilestone>) => { setMs(ms.map((m) => (m.key === k ? { ...m, ...patch } : m))); setDirty(true); };

  function template() {
    const start = project.start_date ?? today;
    const end = project.end_date ?? addDays(start, 60);
    const total = Math.max(5, Math.round((Date.parse(end) - Date.parse(start)) / 86400_000));
    const step = Math.floor(total / TEMPLATE.length);
    setPhases(TEMPLATE.map((name, i) => ({
      key: key(), name, description: null, deliverables: null, color: TEMPLATE_COLORS[i], status: "a_venir" as PhaseStatus,
      start_date: addDays(start, i * step), end_date: i === TEMPLATE.length - 1 ? end : addDays(start, (i + 1) * step - 1),
    })));
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    const r = await attempt(() => savePlanningAction(project.id,
      phases.map(({ key: _k, ...p }) => { void _k; return { ...p, start_date: p.start_date || null, end_date: p.end_date || null }; }),
      ms.map(({ key: _k, ...m }) => { void _k; return { ...m, phase_id: m.phase_id && !m.phase_id.startsWith("k") ? m.phase_id : null }; })));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Planning enregistré");
    setDirty(false);
    sync();
  }

  const previewPhases: Phase[] = phases.map((p) => ({ ...p, id: p.key, completed_at: null }));
  const previewMs: Milestone[] = ms.filter((m) => m.visible_to_client).map((m) => ({ ...m, id: m.key }));

  return (
    <div className="max-w-5xl space-y-4">
      <Card className="space-y-2 p-4">
        <div className="flex items-center justify-between"><h2 className="font-display text-base font-bold">Aperçu pour le client</h2><VisibilityTag client /></div>
        {phases.length ? <TimelineVisual phases={previewPhases} milestones={previewMs} meetings={[]} today={today} start={project.start_date} end={project.end_date} projectId={project.id} /> : <p className="text-sm text-muted">Ajoutez des phases pour construire la timeline.</p>}
        <p className="text-xs text-muted">Les dates indiquent le planning ; le statut indique l&apos;avancement réel. Une phase n&apos;est jamais terminée automatiquement.</p>
      </Card>

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-base font-bold">Phases</h2>
          <div className="flex gap-2">
            {phases.length === 0 && <Button size="sm" onClick={template}>Partir du modèle (Cadrage → Livraison)</Button>}
            <Button size="sm" disabled={phases.length >= 20} onClick={() => { setPhases([...phases, { key: key(), name: "", description: null, deliverables: null, color: PHASE_COLORS[phases.length % PHASE_COLORS.length], status: "a_venir", start_date: null, end_date: null }]); setDirty(true); }}><Plus size={13} /> Phase</Button>
          </div>
        </div>
        {phases.length === 0 && <EmptyState title="Aucune phase" description="Exemple : Cadrage, Préparation, Production, Retours, Livraison. Les noms sont libres." />}
        {phases.map((p, i) => (
          <div key={p.key} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("size-3 shrink-0 rounded-full", PHASE_STYLES[p.color].dot)} aria-hidden />
              <Input value={p.name} onChange={(e) => up(p.key, { name: e.target.value })} placeholder="Nom de la phase" maxLength={80} className="min-w-40 flex-1" aria-label="Nom de la phase" />
              <Select value={p.status} onChange={(e) => up(p.key, { status: e.target.value as PhaseStatus })} className="w-32" aria-label="Avancement réel">
                {(Object.keys(PHASE_STATUS_LABELS) as PhaseStatus[]).map((s) => <option key={s} value={s}>{PHASE_STATUS_LABELS[s]}</option>)}
              </Select>
              <Input type="date" value={p.start_date ?? ""} onChange={(e) => up(p.key, { start_date: e.target.value || null })} className="w-40" aria-label="Début prévu" />
              <Input type="date" value={p.end_date ?? ""} min={p.start_date ?? undefined} onChange={(e) => up(p.key, { end_date: e.target.value || null })} className="w-40" aria-label="Fin prévue" />
              <div className="flex gap-0.5" role="radiogroup" aria-label="Couleur">
                {PHASE_COLORS.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={p.color === c} aria-label={c} onClick={() => up(p.key, { color: c })} className={cn("size-5 rounded-full", PHASE_STYLES[c].dot, p.color === c && "ring-2 ring-ink ring-offset-1")} />
                ))}
              </div>
              <div className="ml-auto flex">
                <Button size="sm" variant="ghost" disabled={i === 0} aria-label="Monter" onClick={() => { const x = [...phases]; [x[i - 1], x[i]] = [x[i], x[i - 1]]; setPhases(x); setDirty(true); }}><ArrowUp size={13} /></Button>
                <Button size="sm" variant="ghost" disabled={i === phases.length - 1} aria-label="Descendre" onClick={() => { const x = [...phases]; [x[i + 1], x[i]] = [x[i], x[i + 1]]; setPhases(x); setDirty(true); }}><ArrowDown size={13} /></Button>
                <Button size="sm" variant="ghost" aria-label="Supprimer la phase" onClick={() => { setPhases(phases.filter((x) => x.key !== p.key)); setDirty(true); }}><Trash2 size={13} /></Button>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <Textarea value={p.description ?? ""} onChange={(e) => up(p.key, { description: e.target.value || null })} placeholder="Ce qui se passe pendant cette phase (visible du client)" maxLength={1000} className="min-h-14" aria-label="Description" />
              <Textarea value={p.deliverables ?? ""} onChange={(e) => up(p.key, { deliverables: e.target.value || null })} placeholder="Livrables attendus" maxLength={1000} className="min-h-14" aria-label="Livrables" />
            </div>
            {p.end_date && p.end_date < today && p.status !== "termine" && <p className="text-xs text-warning">Date de fin dépassée : le client voit « dépasse la date prévue ». Passez la phase en « Terminée » quand elle l&apos;est réellement.</p>}
          </div>
        ))}
      </Card>

      <Card className="space-y-2 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-base font-bold">Jalons</h2>
          <Button size="sm" onClick={() => { setMs([...ms, { key: key(), title: "", due_date: project.end_date ?? today, done: false, phase_id: null, visible_to_client: true }]); setDirty(true); }}><Plus size={13} /> Jalon</Button>
        </div>
        {ms.length === 0 && <p className="text-sm text-muted">Exemples : validation de la maquette, mise en ligne.</p>}
        {ms.map((m) => (
          <div key={m.key} className="flex flex-wrap items-center gap-2">
            <Input value={m.title} onChange={(e) => upM(m.key, { title: e.target.value })} placeholder="Titre du jalon" maxLength={160} className="min-w-48 flex-1" aria-label="Titre du jalon" />
            <Input type="date" value={m.due_date} onChange={(e) => upM(m.key, { due_date: e.target.value })} className="w-40" aria-label="Date" />
            <Select value={m.phase_id ?? ""} onChange={(e) => upM(m.key, { phase_id: e.target.value || null })} className="w-44" aria-label="Phase">
              <option value="">Sans phase</option>
              {phases.filter((p) => p.id).map((p) => <option key={p.key} value={p.id}>{p.name}</option>)}
            </Select>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={m.done} onChange={(e) => upM(m.key, { done: e.target.checked })} /> Atteint</label>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={m.visible_to_client} onChange={(e) => upM(m.key, { visible_to_client: e.target.checked })} /> Visible du client</label>
            <Button size="sm" variant="ghost" aria-label="Supprimer le jalon" onClick={() => { setMs(ms.filter((x) => x.key !== m.key)); setDirty(true); }}><Trash2 size={13} /></Button>
          </div>
        ))}
      </Card>

      <div className="sticky bottom-16 flex items-center gap-2 rounded-xl border border-line bg-white/95 p-3 backdrop-blur md:bottom-4">
        <Button variant="primary" disabled={!dirty || busy} onClick={save}>{busy ? "Enregistrement…" : "Enregistrer le planning"}</Button>
        {dirty && <span className="text-xs text-muted">Modifications non enregistrées</span>}
      </div>
    </div>
  );
}
