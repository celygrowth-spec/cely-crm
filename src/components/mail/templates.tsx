"use client";

// Modèles d'email côté navigateur : liste (cache partagé), écriture, formulaire d'édition.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { apiGet } from "@/lib/client/query";
import { mailCall } from "@/lib/client/mail";
import { Button, Field, Input, Modal, Spinner } from "@/components/ui";
import type { MailTemplate } from "@/lib/mail/templates";
import type { MailEditorHandle } from "./editor";

// Éditeur Tiptap (≈ 120 kB gzip) chargé à l'ouverture du formulaire, pas avec la liste des modèles.
// Il ne s'affiche de toute façon que côté navigateur (immediatelyRender: false).
const MailEditor = dynamic(() => import("./editor").then((m) => m.MailEditor), {
  ssr: false,
  loading: () => <div className="min-h-40 flex-1 animate-pulse rounded-lg border border-line bg-surface" aria-hidden />,
});

export type { MailTemplate };

export const useTemplates = (archived = false) =>
  useQuery({ queryKey: ["mail-templates", archived], queryFn: ({ signal }) => apiGet<MailTemplate[]>(`/api/mail/templates${archived ? "?archives=1" : ""}`, signal), staleTime: 30_000 });

export async function templateOp<T = MailTemplate>(body: Record<string, unknown>) {
  try {
    return await mailCall<T>("/api/mail/templates", "POST", body);
  } catch {
    return { ok: false as const, error: "Connexion impossible : rien n'a été modifié." };
  }
}

export const CATEGORIES = ["Premier contact", "Relance", "Proposition", "Suivi de rendez-vous", "Client"];

export function TemplateForm({ template, initial, onClose, onSaved }: {
  template: MailTemplate | null; initial?: { name: string; subject: string; html: string } | null; onClose: () => void; onSaved?: (t: MailTemplate) => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(template?.name ?? initial?.name ?? "");
  const [category, setCategory] = useState(template?.category ?? "");
  const [subject, setSubject] = useState(template?.subject ?? initial?.subject ?? "");
  const [html, setHtml] = useState(template?.body_html ?? initial?.html ?? "");
  const [pending, setPending] = useState(false);
  const editor = useRef<MailEditorHandle>(null);
  const submit = async () => {
    if (!name.trim()) return toast.error("Donnez un nom au modèle");
    setPending(true);
    const r = await templateOp({ op: "save", id: template?.id ?? null, name, category: category || null, subject, html });
    setPending(false);
    if (!r.ok) return toast.error(r.error);
    toast.success(template ? "Modèle enregistré" : "Modèle créé");
    qc.invalidateQueries({ queryKey: ["mail-templates"] });
    onSaved?.(r.data);
    onClose();
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Nom interne"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Relance après un appel" aria-label="Nom interne" /></Field>
        <Field label="Catégorie (facultatif)">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} list="mail-template-categories" placeholder="Relance" aria-label="Catégorie" />
          <datalist id="mail-template-categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
        </Field>
      </div>
      <Field label="Objet" hint="Variables possibles : {{prenom}}, {{entreprise}}…"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} aria-label="Objet du modèle" /></Field>
      <div className="flex h-80 flex-col">
        <MailEditor handle={editor} initialHtml={html} onChange={(h) => setHtml(h)} label="Corps du modèle" placeholder="Bonjour {Prénom}, …" />
      </div>
      <p className="text-xs text-muted">Un brouillon créé à partir de ce modèle en est une copie : modifier le brouillon ne change jamais le modèle.</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer le modèle"}</Button>
      </div>
    </form>
  );
}

export function TemplateModal({ open, template, initial, onClose, onSaved }: { open: boolean; template: MailTemplate | null; initial?: { name: string; subject: string; html: string } | null; onClose: () => void; onSaved?: (t: MailTemplate) => void }) {
  return (
    <Modal open={open} onClose={onClose} title={template ? "Modifier le modèle" : "Nouveau modèle"} wide>
      {open && <TemplateForm key={template?.id ?? "new"} template={template} initial={initial} onClose={onClose} onSaved={onSaved} />}
    </Modal>
  );
}
