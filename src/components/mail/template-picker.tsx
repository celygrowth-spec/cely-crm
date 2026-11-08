"use client";

// Choisir un modèle depuis le composeur (recherche, aperçu avec les données du destinataire), et
// enregistrer un brouillon comme modèle après avoir retiré les informations propres au prospect.
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { Badge, Button, Field, Input, Modal, Spinner, cn } from "@/components/ui";
import { renderEmailHtml } from "@/lib/mail/render";
import { labelOf, resolveVariables, scrubProspect, tokensToSpans, type VarContext, type VariableKey } from "@/lib/mail/variables";
import { templateOp, useTemplates, type MailTemplate } from "./templates";

const norm = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function TemplatePicker({ open, onClose, ctx, collective, onPick }: {
  open: boolean; onClose: () => void; ctx: VarContext; collective: boolean; onPick: (t: MailTemplate) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Choisir un modèle" wide>
      {open && <PickerBody ctx={ctx} collective={collective} onPick={onPick} onClose={onClose} />}
    </Modal>
  );
}

function PickerBody({ ctx, collective, onPick, onClose }: { ctx: VarContext; collective: boolean; onPick: (t: MailTemplate) => void; onClose: () => void }) {
  const list = useTemplates();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const shown = useMemo(() => (list.data ?? []).filter((t) => !q.trim() || norm(`${t.name} ${t.category ?? ""} ${t.subject} ${t.body_text}`).includes(norm(q.trim()))), [list.data, q]);
  const current = shown.find((t) => t.id === sel) ?? shown[0] ?? null;
  const resolved = current ? resolveVariables(tokensToSpans(current.body_html), current.subject, ctx, collective) : null;
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex min-h-0 flex-col gap-2">
        <div className="relative">
          <Search size={14} className="absolute top-2.5 left-3 text-muted" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher" className="pl-8" aria-label="Rechercher un modèle" />
        </div>
        <ul className="max-h-[50vh] space-y-1 overflow-y-auto" role="listbox" aria-label="Modèles" data-template-list>
          {list.isLoading && <li className="p-2 text-sm text-muted">Chargement…</li>}
          {!list.isLoading && !shown.length && <li className="p-2 text-sm text-muted">{q ? "Aucun modèle ne correspond." : <>Aucun modèle. Créez-en dans <a className="font-semibold underline" href="/mail/modeles">Mail › Modèles</a>.</>}</li>}
          {shown.map((t) => (
            <li key={t.id} role="option" aria-selected={current?.id === t.id}>
              <button type="button" onClick={() => setSel(t.id)} onDoubleClick={() => onPick(t)}
                className={cn("block w-full rounded-lg px-2.5 py-2 text-left", current?.id === t.id ? "bg-violet-soft" : "hover:bg-surface")}>
                <span className="flex items-center gap-2 text-sm font-semibold">{t.name}{t.category && <Badge>{t.category}</Badge>}</span>
                <span className="block truncate text-xs text-muted">{t.subject || "(sans objet)"}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-h-0 flex-col gap-2">
        {current && resolved ? (
          <>
            <p className="text-sm"><span className="text-muted">Objet :</span> <span className="font-semibold">{resolved.subject || "(sans objet)"}</span></p>
            <iframe title="Aperçu du modèle" sandbox="" srcDoc={renderEmailHtml(resolved.html, "")} className="h-72 w-full rounded-lg border border-line bg-white" data-template-preview />
            {resolved.missing.length > 0 && <p className="text-xs text-warning">Sans valeur pour ce destinataire : {resolved.missing.map(labelOf).join(", ")}. Vous pourrez les compléter avant l&apos;envoi.</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>Annuler</Button>
              <Button variant="primary" onClick={() => onPick(current)}>Appliquer</Button>
            </div>
          </>
        ) : <p className="p-4 text-sm text-muted">Choisissez un modèle pour le prévisualiser.</p>}
      </div>
    </div>
  );
}

/** Le brouillon contient déjà du texte : comment appliquer le modèle ? */
export function ApplyChoice({ template, onChoose, onCancel }: { template: MailTemplate | null; onChoose: (mode: "replace" | "append") => void; onCancel: () => void }) {
  return (
    <Modal open={!!template} onClose={onCancel} title="Appliquer le modèle">
      {template && (
        <div className="space-y-3">
          <p className="text-sm">Votre message contient déjà du texte. Comment appliquer « {template.name} » ?</p>
          <div className="grid gap-2">
            <Button onClick={() => onChoose("replace")} className="justify-start">Remplacer mon message (objet compris)</Button>
            <Button onClick={() => onChoose("append")} className="justify-start">Insérer à la suite de mon texte</Button>
            <Button variant="ghost" onClick={onCancel} className="justify-start">Annuler</Button>
          </div>
          <p className="text-xs text-muted">Vous pourrez revenir en arrière juste après.</p>
        </div>
      )}
    </Modal>
  );
}

/** Enregistrer comme modèle : choisir les informations du prospect à remplacer par des variables. */
export function SaveAsTemplate({ open, onClose, html, subject, ctx }: { open: boolean; onClose: () => void; html: string; subject: string; ctx: VarContext }) {
  return (
    <Modal open={open} onClose={onClose} title="Enregistrer comme modèle">
      {open && <SaveBody onClose={onClose} html={html} subject={subject} ctx={ctx} />}
    </Modal>
  );
}

function SaveBody({ onClose, html, subject, ctx }: { onClose: () => void; html: string; subject: string; ctx: VarContext }) {
  const qc = useQueryClient();
  const found = useMemo(() => scrubProspect(html, subject, ctx).found, [html, subject, ctx]);
  const [keep, setKeep] = useState<VariableKey[]>(found.map((f) => f.key));
  const [name, setName] = useState(subject.slice(0, 120));
  const [pending, setPending] = useState(false);
  const save = async () => {
    if (!name.trim()) return toast.error("Donnez un nom au modèle");
    const out = scrubProspect(html, subject, ctx, keep);
    setPending(true);
    const r = await templateOp({ op: "save", id: null, name, category: null, subject: out.subject, html: out.html });
    setPending(false);
    if (!r.ok) return toast.error(r.error);
    qc.invalidateQueries({ queryKey: ["mail-templates"] });
    toast.success("Modèle créé : votre brouillon n'a pas changé");
    onClose();
  };
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Field label="Nom du modèle"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Nom du modèle" /></Field>
      {found.length ? (
        <div className="space-y-1.5" data-scrub>
          <p className="text-sm">Informations propres à ce prospect, à remplacer par des variables :</p>
          {found.map((f) => (
            <label key={f.key} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-violet-600" checked={keep.includes(f.key)} onChange={(e) => setKeep((k) => (e.target.checked ? [...k, f.key] : k.filter((x) => x !== f.key)))} />
              « {f.value} » → <span className="rounded-full bg-violet-soft px-2 text-xs font-semibold text-violet-strong">{labelOf(f.key)}</span>
              <span className="text-xs text-muted">({f.count} fois)</span>
            </label>
          ))}
        </div>
      ) : <p className="text-sm text-muted">Aucune information du prospect repérée dans le texte. Relisez-le avant de l&apos;enregistrer.</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Créer le modèle"}</Button>
      </div>
    </form>
  );
}
