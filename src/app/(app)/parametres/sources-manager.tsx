"use client";

// Gestion des sources du contact : création, renommage, couleur, ordre, archivage, suppression.
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useState } from "react";
import { toast } from "sonner";
import { Archive, ArchiveRestore, GripVertical, Plus, Trash2 } from "lucide-react";
import { createSourceAction, deleteSourceAction, reorderSourcesAction, updateSourceAction } from "@/app/actions";
import { SOURCE_COLORS } from "@/components/source-picker";
import { Badge, Button, Input, Modal, Select, cn } from "@/components/ui";
import { attempt, useSync } from "@/lib/client/query";
import type { LeadSource, SourceColor } from "@/lib/crm/types";

type Row = LeadSource & { used: number };

export function SourcesManager({ sources }: { sources: Row[] }) {
  const sync = useSync();
  const [rows, setRows] = useState(sources);
  const [prev, setPrev] = useState(sources);
  if (sources !== prev) {
    setPrev(sources);
    setRows(sources);
  }
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [target, setTarget] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const visible = rows.filter((r) => showArchived || !r.archived_at);
  const archivedCount = rows.filter((r) => r.archived_at).length;

  function patchLocal(id: string, p: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }
  async function update(r: Row, p: { name?: string; color?: string; archived?: boolean }, local: Partial<Row>) {
    patchLocal(r.id, local);
    const res = await attempt(() => updateSourceAction(r.id, p));
    if (!res.ok) {
      patchLocal(r.id, r);
      return toast.error(res.error, { action: { label: "Réessayer", onClick: () => update(r, p, local) } });
    }
    sync(["companies"]);
  }
  async function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const before = rows;
    const next = arrayMove(rows, rows.findIndex((r) => r.id === e.active.id), rows.findIndex((r) => r.id === e.over!.id));
    setRows(next);
    const res = await attempt(() => reorderSourcesAction(next.map((r) => r.id)));
    if (!res.ok) {
      setRows(before);
      return toast.error(res.error);
    }
    sync();
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    setName("");
    const res = await attempt(() => createSourceAction(n));
    if (!res.ok) {
      setName(n);
      return toast.error(res.error);
    }
    setRows((rs) => [...rs, { ...res.data, used: 0 }]);
    sync();
  }
  async function confirmDelete() {
    if (!deleting) return;
    const res = await attempt(() => deleteSourceAction(deleting.id, target || null));
    if (!res.ok) return toast.error(res.error);
    setRows((rs) => rs.filter((r) => r.id !== deleting.id));
    toast.success(res.data.moved ? `Source supprimée · ${res.data.moved} fiche(s) ${target ? "réaffectée(s)" : "sans source"}` : "Source supprimée");
    setDeleting(null);
    sync(["companies"]);
  }

  return (
    <div className="space-y-1.5">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={visible.map((r) => r.id)} strategy={verticalListSortingStrategy}>
          {visible.map((r) => (
            <SourceRow
              key={r.id}
              r={r}
              onRename={(n) => n.trim() && n !== r.name && update(r, { name: n }, { name: n })}
              onColor={(c) => update(r, { color: c }, { color: c })}
              onArchive={() => update(r, { archived: !r.archived_at }, { archived_at: r.archived_at ? null : new Date().toISOString() })}
              onDelete={() => { setDeleting(r); setTarget(""); }}
            />
          ))}
        </SortableContext>
      </DndContext>
      <form onSubmit={add} className="flex gap-1 pt-1">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nouvelle source" />
        <Button type="submit" disabled={!name.trim()}><Plus size={14} /> Ajouter</Button>
      </form>
      {archivedCount > 0 && (
        <button className="text-xs text-muted hover:text-ink" onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? "Masquer" : "Afficher"} les archivées ({archivedCount})
        </button>
      )}

      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={`Supprimer « ${deleting?.name ?? ""} »`}>
        {deleting && (
          <div className="space-y-3 text-sm">
            {deleting.used > 0 ? (
              <>
                <p>{deleting.used} fiche(s) utilisent cette source. Les fiches ne sont jamais supprimées. Que faire de leur source ?</p>
                <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Source de remplacement">
                  <option value="">Vider la source de ces fiches</option>
                  {rows.filter((r) => r.id !== deleting.id && !r.archived_at).map((r) => <option key={r.id} value={r.id}>Réaffecter à « {r.name} »</option>)}
                </Select>
              </>
            ) : <p>Aucune fiche n&apos;utilise cette source.</p>}
            <p className="text-xs text-muted">Pour conserver l&apos;historique, préférez l&apos;archivage : la source reste sur les fiches mais n&apos;est plus proposée.</p>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setDeleting(null)}>Annuler</Button>
              <Button variant="danger" onClick={confirmDelete}>Supprimer définitivement</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function SourceRow({ r, onRename, onColor, onArchive, onDelete }: { r: Row; onRename: (n: string) => void; onColor: (c: SourceColor) => void; onArchive: () => void; onDelete: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: r.id });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("flex items-center gap-1 rounded-lg bg-white", isDragging && "z-10 shadow-lg", r.archived_at && "opacity-60")}>
      <button {...attributes} {...listeners} className="cursor-grab rounded p-1 text-muted hover:bg-surface" aria-label={`Réordonner ${r.name}`}><GripVertical size={14} /></button>
      <Select value={r.color} onChange={(e) => onColor(e.target.value as SourceColor)} className="h-9 w-28 text-xs" aria-label={`Couleur de ${r.name}`}>
        {Object.entries(SOURCE_COLORS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </Select>
      <span className={cn("size-2.5 shrink-0 rounded-full", SOURCE_COLORS[r.color].dot)} aria-hidden />
      <Input key={r.name} defaultValue={r.name} onBlur={(e) => onRename(e.target.value)} aria-label="Nom de la source" />
      <span className="w-20 shrink-0 text-right text-xs text-muted">{r.used} fiche(s)</span>
      {r.archived_at && <Badge>Archivée</Badge>}
      <Button variant="ghost" onClick={onArchive} aria-label={r.archived_at ? "Restaurer" : "Archiver"} title={r.archived_at ? "Restaurer" : "Archiver"}>
        {r.archived_at ? <ArchiveRestore size={14} /> : <Archive size={14} />}
      </Button>
      <Button variant="ghost" onClick={onDelete} aria-label="Supprimer"><Trash2 size={14} /></Button>
    </div>
  );
}
