"use client";

// Détail d'une tâche (contenu long) : description, liens, blocage, commentaires courts.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import { commentTaskAction, updateTaskAction } from "@/app/projets-actions";
import { TrashButton } from "@/components/trash/trash-button";
import { Button, Field, Input, Modal, Skeleton, Textarea } from "@/components/ui";
import { apiGet, attempt } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import { TASK_STATUS_LABELS, type AdminTask, type RecapLink, type TaskComment } from "@/lib/projects/types";

export function Comments({ comments, onAdd, disabled }: { comments: TaskComment[]; onAdd?: (body: string) => Promise<boolean>; disabled?: boolean }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div>
      <h3 className="mb-1 font-label text-xs font-semibold text-muted">Commentaires</h3>
      {comments.length === 0 && <p className="text-sm text-muted">Aucun commentaire.</p>}
      <ul className="space-y-2">
        {comments.map((c) => (
          <li key={c.id} className="rounded-lg bg-surface px-3 py-2 text-sm">
            <p className="text-xs text-muted"><strong className="text-ink">{c.author}</strong> · {formatDateTime(c.created_at)}</p>
            <p className="whitespace-pre-line text-ink">{c.body}</p>
          </li>
        ))}
      </ul>
      {onAdd && !disabled && (
        <form className="mt-2 flex gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          setBusy(true);
          const ok = await onAdd(body);
          setBusy(false);
          if (ok) setBody(""); // en cas d'échec, la saisie est conservée
        }}>
          <Input value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} placeholder="Ajouter un commentaire" aria-label="Commentaire" />
          <Button type="submit" disabled={busy || !body.trim()}>Envoyer</Button>
        </form>
      )}
    </div>
  );
}

export function LinksView({ links }: { links: RecapLink[] }) {
  if (!links.length) return null;
  return (
    <ul className="space-y-1 text-sm">
      {links.map((l, i) => <li key={i}><a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-semibold text-violet-strong underline">{l.label} <ExternalLink size={12} /></a></li>)}
    </ul>
  );
}

export function AdminTaskDrawer({ taskId, onClose, onChanged, onDeleted }: {
  taskId: string | null; onClose: () => void; onChanged: (t: AdminTask) => void; onDeleted: (id: string) => void;
}) {
  return (
    <Modal open={!!taskId} onClose={onClose} title="Tâche" wide>
      {taskId && <AdminBody key={taskId} id={taskId} onChanged={onChanged} onDeleted={onDeleted} />}
    </Modal>
  );
}

function AdminBody({ id, onChanged, onDeleted }: { id: string; onChanged: (t: AdminTask) => void; onDeleted: (id: string) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["project-task", id], queryFn: ({ signal }) => apiGet<{ task: AdminTask; comments: TaskComment[] } | null>(`/api/projets/taches/${id}`, signal) });
  if (q.isLoading) return <Skeleton className="h-40 w-full" />;
  if (!q.data) return <p className="text-sm text-muted">Tâche introuvable.</p>;
  return <AdminForm key={q.data.task.updated_at} data={q.data} onSaved={(t) => { onChanged(t); void qc.invalidateQueries({ queryKey: ["project-task", id] }); }} onDeleted={onDeleted} reload={() => qc.invalidateQueries({ queryKey: ["project-task", id] })} />;
}

function AdminForm({ data, onSaved, onDeleted, reload }: { data: { task: AdminTask; comments: TaskComment[] }; onSaved: (t: AdminTask) => void; onDeleted: (id: string) => void; reload: () => void }) {
  const t = data.task;
  const [d, setD] = useState({ title: t.title, description: t.description ?? "", blocked_reason: t.blocked_reason ?? "", links: t.links ?? [] });
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const r = await attempt(() => updateTaskAction(t.id, { title: d.title, description: d.description, blocked_reason: t.status === "bloque" ? d.blocked_reason : null, links: d.links.filter((l) => l.label && l.url) }));
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Tâche enregistrée");
    onSaved(r.data);
  }
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        Statut : <strong>{TASK_STATUS_LABELS[t.status]}</strong> · {t.visible_to_client ? "visible du client" : "interne"} · créée par {t.created_by_kind === "owner" ? "vous" : "le client"} · mise à jour {formatDateTime(t.updated_at)}{t.updated_by_kind === "client" ? " par le client" : ""}
      </p>
      <Field label="Intitulé"><Input value={d.title} maxLength={300} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <Field label={t.visible_to_client ? "Description (visible du client)" : "Description"}><Textarea value={d.description} maxLength={5000} onChange={(e) => setD({ ...d, description: e.target.value })} /></Field>
      {t.status === "bloque" && <Field label="Ce qui bloque"><Input value={d.blocked_reason} maxLength={1000} onChange={(e) => setD({ ...d, blocked_reason: e.target.value })} /></Field>}
      <div>
        <p className="mb-1 font-label text-xs font-semibold text-muted">Liens associés</p>
        {d.links.map((l, i) => (
          <div key={i} className="mb-1 flex gap-2">
            <Input value={l.label} placeholder="Libellé" className="w-44" onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} aria-label="Libellé" />
            <Input value={l.url} placeholder="https://" onChange={(e) => setD({ ...d, links: d.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} aria-label="Adresse" />
            <Button size="sm" variant="ghost" aria-label="Retirer" onClick={() => setD({ ...d, links: d.links.filter((_, j) => j !== i) })}><Trash2 size={13} /></Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" disabled={d.links.length >= 10} onClick={() => setD({ ...d, links: [...d.links, { label: "", url: "" }] })}><Plus size={13} /> Lien</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={save}>Enregistrer</Button>
        <TrashButton kind="project_task" id={t.id} size="md" variant="danger" onDone={() => onDeleted(t.id)}>Supprimer</TrashButton>
      </div>
      <Comments comments={data.comments} onAdd={async (body) => {
        const r = await attempt(() => commentTaskAction(t.id, body));
        if (!r.ok) { toast.error(r.error); return false; }
        reload();
        return true;
      }} />
    </div>
  );
}
