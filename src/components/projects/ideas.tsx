"use client";

// Boîte à idées : cartes sobres. Portail : proposer, modifier sa propre idée tant que rien n'est décidé,
// commenter. Administration : décider (statut + explication), transformer en tâche.
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Lightbulb, MessageSquare, Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { IDEA_STATUS_LABELS, IDEA_STATUS_STYLES, type Idea, type IdeaStatus } from "@/lib/projects/types";
import { Button, Input, Textarea } from "@/components/ui";

type R<T> = { ok: true; data: T } | { ok: false; error: string };

export function IdeaForm({ initial, onSave, onCancel, label }: { initial?: { title: string; description: string | null }; onSave: (title: string, description: string) => Promise<boolean>; onCancel?: () => void; label: string }) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form className="space-y-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      const ok = await onSave(title, description);
      setBusy(false);
      if (ok && !initial) { setTitle(""); setDescription(""); } // saisie conservée en cas d'échec
    }}>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="Votre idée en une phrase" aria-label="Titre de l'idée" required />
      <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} placeholder="Quelques détails (facultatif)" aria-label="Description de l'idée" className="min-h-16" />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={busy || !title.trim()}>{label}</Button>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Annuler</Button>}
      </div>
    </form>
  );
}

export function IdeaCard({ idea, onEdit, onComment, admin }: {
  idea: Idea;
  onEdit?: (title: string, description: string) => Promise<boolean>;
  onComment?: (body: string) => Promise<boolean>;
  admin?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [showComments, setShowComments] = useState(idea.comments.length > 0 && idea.comments.length <= 2);
  const [body, setBody] = useState("");
  return (
    <article className="row-in flex flex-col rounded-2xl border border-line bg-white p-4">
      <div className="flex items-start gap-2">
        <Lightbulb size={18} className={cn("mt-0.5 shrink-0", idea.status === "retenue" ? "text-success" : "text-violet-strong")} aria-hidden />
        <div className="min-w-0 flex-1">
          {editing && onEdit ? (
            <IdeaForm initial={idea} label="Enregistrer" onCancel={() => setEditing(false)} onSave={async (t, d) => { const ok = await onEdit(t, d); if (ok) setEditing(false); return ok; }} />
          ) : (
            <>
              <h3 className="font-display text-base leading-snug font-bold text-ink">{idea.title}</h3>
              {idea.description && <p className="mt-1 text-sm whitespace-pre-line text-muted">{idea.description}</p>}
            </>
          )}
        </div>
        <span className={cn("shrink-0 rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", IDEA_STATUS_STYLES[idea.status])}>{IDEA_STATUS_LABELS[idea.status]}</span>
      </div>
      {idea.decision_note && <p className="mt-2 rounded-lg bg-surface px-3 py-2 text-sm text-ink"><span className="font-semibold">Décision : </span>{idea.decision_note}</p>}
      {idea.has_task && <p className="mt-2 text-xs font-semibold text-success">Transformée en tâche du projet</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{idea.mine ? "Vous" : idea.author} · {formatDate(idea.created_at)}</span>
        <button type="button" onClick={() => setShowComments(!showComments)} className="inline-flex items-center gap-1 hover:text-ink"><MessageSquare size={13} /> {idea.comments.length}</button>
        {idea.can_edit && onEdit && !editing && <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 hover:text-ink"><Pencil size={12} /> Modifier</button>}
      </div>
      {showComments && (
        <div className="mt-2 space-y-1.5 border-t border-line pt-2">
          {idea.comments.map((c) => <p key={c.id} className="text-sm"><span className="font-semibold text-ink">{c.author}</span> <span className="text-muted">{c.body}</span></p>)}
          {onComment && (
            <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (body.trim() && (await onComment(body))) setBody(""); }}>
              <Input value={body} onChange={(e) => setBody(e.target.value)} maxLength={1000} placeholder="Commenter" aria-label={`Commenter « ${idea.title} »`} className="h-8" />
              <Button size="sm" type="submit" disabled={!body.trim()}>Envoyer</Button>
            </form>
          )}
        </div>
      )}
      {admin}
    </article>
  );
}

export const IDEA_STATUSES = Object.keys(IDEA_STATUS_LABELS) as IdeaStatus[];
export async function run<T>(fn: () => Promise<R<T>>, msg?: string) {
  const r = await fn();
  if (!r.ok) {
    toast.error(r.error);
    return null;
  }
  if (msg) toast.success(msg);
  return r.data;
}
