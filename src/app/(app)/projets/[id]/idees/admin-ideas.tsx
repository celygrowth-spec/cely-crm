"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ListPlus } from "lucide-react";
import { commentIdeaAction, createIdeaAction, decideIdeaAction, ideaToTaskAction } from "@/app/projets-actions";
import { Button, Input, Select } from "@/components/ui";
import { IDEA_STATUSES, IdeaCard, IdeaForm, run } from "@/components/projects/ideas";
import { attempt } from "@/lib/client/query";
import { IDEA_STATUS_LABELS, type Idea, type IdeaStatus } from "@/lib/projects/types";

export function AdminIdeas({ projectId, ideas }: { projectId: string; ideas: Idea[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState<IdeaStatus | "">("");
  const shown = filter ? ideas.filter((i) => i.status === filter) : ideas;
  return (
    <div className="max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filter} onChange={(e) => setFilter(e.target.value as IdeaStatus | "")} className="w-44" aria-label="Filtrer par statut">
          <option value="">Toutes ({ideas.length})</option>
          {IDEA_STATUSES.map((s) => <option key={s} value={s}>{IDEA_STATUS_LABELS[s]} ({ideas.filter((i) => i.status === s).length})</option>)}
        </Select>
        <p className="text-xs text-muted">Les idées sont visibles par tous les contacts du projet. Changer le statut avec une explication les informe de votre décision.</p>
      </div>
      <details className="rounded-2xl border border-line bg-white p-4">
        <summary className="cursor-pointer text-sm font-semibold">Ajouter une idée vous-même</summary>
        <div className="mt-2"><IdeaForm label="Ajouter" onSave={async (t, d) => !!(await run(() => attempt(() => createIdeaAction(projectId, t, d || null)), "Idée ajoutée")) && (router.refresh(), true)} /></div>
      </details>
      <div className="grid gap-3 md:grid-cols-2">
        {shown.map((i) => (
          <IdeaCard
            key={i.id + i.updated_at + i.comments.length}
            idea={i}
            onComment={async (body) => !!(await run(() => attempt(() => commentIdeaAction(i.id, body)))) && (router.refresh(), true)}
            admin={<Decide idea={i} projectId={projectId} onDone={() => router.refresh()} />}
          />
        ))}
      </div>
    </div>
  );
}

function Decide({ idea, projectId, onDone }: { idea: Idea; projectId: string; onDone: () => void }) {
  const [status, setStatus] = useState<IdeaStatus>(idea.status);
  const [note, setNote] = useState(idea.decision_note ?? "");
  const dirty = status !== idea.status || note !== (idea.decision_note ?? "");
  return (
    <div className="mt-3 space-y-2 border-t border-line pt-3">
      <div className="flex flex-wrap gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value as IdeaStatus)} className="w-36" aria-label="Décision">
          {IDEA_STATUSES.map((s) => <option key={s} value={s}>{IDEA_STATUS_LABELS[s]}</option>)}
        </Select>
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Explication (visible du client)" className="min-w-48 flex-1" aria-label="Explication de la décision" />
        {dirty && <Button variant="primary" onClick={async () => { if (await run(() => attempt(() => decideIdeaAction(idea.id, status, note || null)), "Décision enregistrée")) onDone(); }}>Enregistrer</Button>}
      </div>
      {idea.task_id ? (
        <Link href={`/projets/${projectId}/taches?tache=${idea.task_id}`} className="text-xs font-semibold text-violet-strong underline">Voir la tâche créée</Link>
      ) : (
        <Button size="sm" onClick={async () => { if (await run(() => attempt(() => ideaToTaskAction(idea.id)), "Tâche créée à partir de l'idée")) onDone(); }}><ListPlus size={13} /> Transformer en tâche</Button>
      )}
    </div>
  );
}
