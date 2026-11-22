"use client";

// Fenêtre de rédaction de la boîte : nouveau message, réponse, transfert, reprise d'un brouillon.
// Le brouillon est enregistré dans Gmail pendant la saisie ; l'envoi part de ce brouillon.
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { File as FileIcon, Paperclip, Send, Trash2, X } from "lucide-react";
import { MailEditor } from "@/components/mail/editor";
import { RecipientsInput } from "@/components/mail/recipients";
import { Button, Input, Skeleton } from "@/components/ui";
import type { MailResult } from "@/lib/client/mail";
import { mailCall } from "@/lib/client/mail";
import { apiGet } from "@/lib/client/query";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, type AttachmentRef, type BoxOpenMessage, type ComposeContext, type ComposeDraft, type ComposeSaved } from "@/lib/mail/box-types";
import { MAX_ATTACHMENTS_BYTES, MAX_ATTACHMENTS_LABEL } from "@/lib/mail/types";

export type ComposeRequest =
  | { kind: "new" }
  | { kind: "reply" | "reply_all" | "forward"; thread_id: string; message: BoxOpenMessage }
  | { kind: "draft"; message_id: string };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const when = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", dateStyle: "long", timeStyle: "short" });
const prefixed = (subject: string, prefix: "Re" | "Fwd") => (new RegExp(`^${prefix === "Re" ? "re" : "(fwd?|tr)"}\\s*:`, "i").test(subject.trim()) ? subject : `${prefix}: ${subject}`);
const size = (n: number) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1).replace(".", ",")} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const uniq = (list: string[]) => [...new Set(list.map((a) => a.toLowerCase()))];

/** Brouillon de départ selon la demande. La citation du message d'origine est placée sous la signature. */
function initial(req: Exclude<ComposeRequest, { kind: "draft" }>, ctx: ComposeContext): ComposeDraft {
  const signature = ctx.signature_html ? `<p></p><p>-- </p>${ctx.signature_html}` : "";
  const blank: ComposeDraft = { draft_id: null, thread_id: null, in_reply_to: null, references: null, to: [], cc: [], bcc: [], subject: "", html: `<p></p>${signature}`, attachments: [] };
  if (req.kind === "new") return blank;
  const m = req.message;
  const me = ctx.email.toLowerCase();
  const sender = m.from_name ? `${esc(m.from_name)} &lt;${esc(m.from_email ?? "")}&gt;` : esc(m.from_email ?? "");
  if (req.kind === "forward") {
    const head = `<p>---------- Message transféré ----------<br>De : ${sender}<br>Date : ${when.format(new Date(m.at))}<br>Objet : ${esc(m.subject)}<br>À : ${esc(m.to)}</p>`;
    return { ...blank, thread_id: req.thread_id, subject: prefixed(m.subject, "Fwd"), html: `<p></p>${signature}<p></p>${head}${m.html}`,
      attachments: m.attachments.map((a, n) => ({ message_id: m.id, n, name: a.name, size: a.size })) };
  }
  // réponse : à l'adresse de réponse si elle existe, sinon à l'expéditeur ; si c'est moi, à mes destinataires d'origine
  const mine = m.from_email?.toLowerCase() === me;
  const to = uniq(mine ? m.to_list : m.reply_to.length ? m.reply_to : m.from_email ? [m.from_email] : []);
  const cc = req.kind === "reply_all" ? uniq([...(mine ? [] : m.to_list), ...m.cc_list]).filter((a) => a !== me && !to.includes(a)) : [];
  const quote = `<p>Le ${when.format(new Date(m.at))}, ${sender} a écrit :</p><blockquote>${m.html}</blockquote>`;
  return {
    ...blank, thread_id: req.thread_id, to, cc, subject: prefixed(m.subject, "Re"),
    in_reply_to: m.rfc_message_id, references: [m.references, m.rfc_message_id].filter(Boolean).join(" ") || null,
    html: `<p></p>${signature}<p></p>${quote}`,
  };
}

export function Composer({ request, onClose, onChanged }: { request: ComposeRequest; onClose: () => void; onChanged: () => void }) {
  const ctx = useQuery({ queryKey: ["mail-compose-context"], queryFn: ({ signal }) => apiGet<ComposeContext>("/api/mail/box/compose", signal), staleTime: 300_000 });
  const loaded = useQuery({
    queryKey: ["mail-compose-draft", request.kind === "draft" ? request.message_id : null],
    queryFn: ({ signal }) => apiGet<ComposeDraft>(`/api/mail/box/compose?draft_message=${encodeURIComponent(request.kind === "draft" ? request.message_id : "")}`, signal),
    enabled: request.kind === "draft", gcTime: 0, staleTime: 0,
  });
  const title = request.kind === "new" ? "Nouveau message" : request.kind === "forward" ? "Transférer" : request.kind === "draft" ? "Brouillon" : request.kind === "reply_all" ? "Répondre à tous" : "Répondre";
  const start = request.kind === "draft" ? loaded.data : ctx.data ? initial(request, ctx.data) : undefined;
  const error = ctx.error ?? loaded.error;
  return (
    <section role="dialog" aria-label={title} className="fixed inset-x-2 bottom-2 z-40 flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-2xl sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-[38rem]">
      {start && ctx.data
        ? <Form key={request.kind === "draft" ? request.message_id : request.kind} title={title} start={start} ctx={ctx.data} fresh={request.kind !== "draft"} onClose={onClose} onChanged={onChanged} />
        : (
          <div className="p-4">
            <div className="flex items-center"><h2 className="flex-1 font-display text-sm font-bold">{title}</h2><button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:text-ink"><X size={16} /></button></div>
            {error ? <p role="alert" className="mt-3 text-sm text-danger">{error.message}</p> : <Skeleton className="mt-3 h-40 w-full" />}
          </div>
        )}
    </section>
  );
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

function Form({ title, start, ctx, fresh, onClose, onChanged }: { title: string; start: ComposeDraft; ctx: ComposeContext; fresh: boolean; onClose: () => void; onChanged: () => void }) {
  const [to, setTo] = useState(start.to);
  const [cc, setCc] = useState(start.cc);
  const [bcc, setBcc] = useState(start.bcc);
  const [showCc, setShowCc] = useState(start.cc.length > 0 || start.bcc.length > 0);
  const [subject, setSubject] = useState(start.subject);
  const [attachments, setAttachments] = useState<AttachmentRef[]>(start.attachments);
  const [files, setFiles] = useState<File[]>([]);
  const [state, setState] = useState<SaveState>("idle");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // dernière valeur de chaque champ, lue par l'enregistrement (qui peut partir d'une minuterie)
  const v = useRef({ to, cc, bcc, subject, html: start.html, attachments, files, draftId: start.draft_id, threadId: start.thread_id });
  useEffect(() => { Object.assign(v.current, { to, cc, bcc, subject, attachments, files }); });
  const dirty = useRef(false);
  const chain = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const locked = useRef(false); // envoi ou suppression en cours : plus aucun enregistrement
  const sendOnce = useRef(false); // un clic sur Envoyer est en cours de traitement
  const picker = useRef<HTMLInputElement>(null);

  /** Un enregistrement à la fois, dans l'ordre : le brouillon n'est créé qu'une fois, puis mis à jour. */
  const save = useCallback((): Promise<boolean> => {
    clearTimeout(timer.current);
    chain.current = chain.current.then(async () => {
      if (!dirty.current || locked.current) return true;
      dirty.current = false;
      setState("saving");
      const c = v.current;
      const sent = c.files;
      const form = new FormData();
      form.set("data", JSON.stringify({
        draft_id: c.draftId, thread_id: c.threadId, in_reply_to: start.in_reply_to, references: start.references,
        to: c.to, cc: c.cc, bcc: c.bcc, subject: c.subject, html: c.html, keep: c.attachments.map((a) => ({ message_id: a.message_id, n: a.n })),
      }));
      for (const f of sent) form.append("files", f);
      try {
        const res = await fetch("/api/mail/box/compose", { method: "POST", body: form });
        const r = (await res.json()) as MailResult<ComposeSaved>;
        if (!r.ok) throw new Error(r.error);
        c.draftId = r.data.draft_id;
        c.threadId = r.data.thread_id ?? c.threadId;
        // les fichiers envoyés sont maintenant dans Gmail ; ceux ajoutés pendant l'enregistrement restent à envoyer
        c.attachments = r.data.attachments;
        setAttachments(r.data.attachments);
        setFiles((cur) => cur.filter((f) => !sent.includes(f)));
        setProblem(null);
        setState(dirty.current ? "dirty" : "saved");
        onChanged();
        return true;
      } catch (e) {
        dirty.current = true; // rien n'est perdu : la saisie reste à l'écran et sera réenregistrée
        setProblem(e instanceof Error && e.message ? e.message : "Enregistrement impossible. Vérifiez votre connexion.");
        setState("error");
        return false;
      }
    });
    return chain.current;
  }, [onChanged, start.in_reply_to, start.references]);

  const touch = useCallback(() => {
    if (locked.current) return;
    dirty.current = true;
    setState("dirty");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 2_000);
  }, [save]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // une réponse ou un transfert part d'un contenu prérempli : il est enregistré dès la première modification seulement
  const edit = <T,>(set: (x: T) => void) => (x: T) => { set(x); touch(); };

  const addFiles = (list: FileList | null) => {
    const added = [...(list ?? [])];
    if (!added.length) return;
    const pending = [...files, ...added];
    if (pending.reduce((n, f) => n + f.size, 0) > MAX_UPLOAD_BYTES) return void toast.error(`${MAX_UPLOAD_LABEL} au plus par ajout : ajoutez les fichiers un par un, ou attendez la fin de l'enregistrement.`);
    if (pending.reduce((n, f) => n + f.size, 0) + attachments.reduce((n, a) => n + a.size, 0) > MAX_ATTACHMENTS_BYTES) return void toast.error(`Pièces jointes limitées à ${MAX_ATTACHMENTS_LABEL} au total.`);
    setFiles(pending);
    v.current.files = pending;
    touch();
  };

  const post = (body: Record<string, unknown>) => mailCall<{ status?: string }>("/api/mail/box/compose", "POST", body);

  const send = async () => {
    if (locked.current || sendOnce.current) return; // double clic : un seul envoi
    if (!to.length && !cc.length && !bcc.length) return setProblem("Indiquez au moins un destinataire.");
    sendOnce.current = true;
    setSending(true);
    dirty.current = dirty.current || !v.current.draftId; // un message jamais enregistré l'est avant l'envoi
    const saved = await save();
    if (!saved || !v.current.draftId) { sendOnce.current = false; return setSending(false); }
    locked.current = true;
    try {
      const r = await post({ op: "send", draft_id: v.current.draftId });
      if (!r.ok) throw new Error(r.error);
      toast.success(r.data.status === "already" ? "Ce message était déjà envoyé." : "Message envoyé.");
      onChanged();
      onClose();
    } catch (e) {
      locked.current = false;
      sendOnce.current = false;
      setSending(false);
      setProblem(e instanceof Error && e.message ? e.message : "L'envoi a échoué. Le brouillon est conservé.");
      onChanged();
    }
  };

  const discard = async () => {
    if (locked.current) return;
    locked.current = true;
    clearTimeout(timer.current);
    await chain.current;
    if (v.current.draftId) {
      const r = await post({ op: "discard", draft_id: v.current.draftId }).catch(() => ({ ok: false as const, error: "" }));
      if (!r.ok) { locked.current = false; return setProblem(r.error || "Suppression impossible. Réessayez."); }
      onChanged();
    }
    onClose();
  };

  const close = async () => {
    if (locked.current) return;
    if (dirty.current) {
      const ok = await save();
      if (!ok) return; // l'erreur est affichée : la fenêtre reste ouverte pour ne rien perdre
      toast.message("Brouillon enregistré dans Gmail.");
    }
    onClose();
  };

  const status = sending ? "Envoi…" : state === "saving" ? "Enregistrement…" : state === "saved" ? "Brouillon enregistré dans Gmail" : state === "dirty" ? "Modifications en attente" : state === "error" ? "Non enregistré" : fresh ? "" : "Brouillon Gmail";
  return (
    <>
      <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate font-display text-sm font-bold">{title}</h2>
        <span className="text-xs text-muted" aria-live="polite">{status}</span>
        <button type="button" onClick={() => void close()} aria-label="Fermer et garder le brouillon" title="Fermer et garder le brouillon" className="rounded p-1 text-muted hover:text-ink"><X size={16} /></button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        <p className="text-xs text-muted">De : {ctx.name ? `${ctx.name} · ` : ""}{ctx.email}</p>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1"><RecipientsInput label="À" value={to} onChange={edit(setTo)} contacts={[]} autoFocus={fresh && !to.length} /></div>
          {!showCc && <button type="button" onClick={() => setShowCc(true)} className="mt-1.5 text-xs font-semibold text-violet-strong underline">Cc / Cci</button>}
        </div>
        {showCc && <><RecipientsInput label="Cc" value={cc} onChange={edit(setCc)} contacts={[]} /><RecipientsInput label="Cci" value={bcc} onChange={edit(setBcc)} contacts={[]} /></>}
        <Input value={subject} onChange={(e) => edit(setSubject)(e.target.value)} placeholder="Objet" aria-label="Objet" maxLength={500} />
        <div className="rounded-lg border border-line">
          <MailEditor initialHtml={start.html} variables={false} onChange={(html) => { if (html !== v.current.html) { v.current.html = html; touch(); } }} />
        </div>
        {(attachments.length > 0 || files.length > 0) && (
          <ul className="flex flex-wrap gap-2" aria-label="Pièces jointes">
            {attachments.map((a) => (
              <li key={`${a.message_id}:${a.n}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-xs">
                <FileIcon size={13} className="shrink-0" /><span className="truncate font-semibold">{a.name}</span><span className="shrink-0 text-muted">{size(a.size)}</span>
                <button type="button" aria-label={`Retirer ${a.name}`} className="text-muted hover:text-danger" onClick={() => { const next = attachments.filter((x) => x !== a); setAttachments(next); v.current.attachments = next; touch(); }}><X size={13} /></button>
              </li>
            ))}
            {files.map((f, i) => (
              <li key={`${f.name}:${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-dashed border-line px-2 py-1 text-xs">
                <FileIcon size={13} className="shrink-0" /><span className="truncate font-semibold">{f.name}</span><span className="shrink-0 text-muted">{size(f.size)} · en attente</span>
                <button type="button" aria-label={`Retirer ${f.name}`} className="text-muted hover:text-danger" onClick={() => { const next = files.filter((x) => x !== f); setFiles(next); v.current.files = next; touch(); }}><X size={13} /></button>
              </li>
            ))}
          </ul>
        )}
        {problem && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{problem}</p>}
      </div>
      <footer className="flex items-center gap-2 border-t border-line px-3 py-2">
        <Button variant="primary" onClick={() => void send()} disabled={sending}><Send size={14} /> {sending ? "Envoi…" : "Envoyer"}</Button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <Button variant="ghost" onClick={() => picker.current?.click()} disabled={sending} aria-label="Joindre un fichier" title={`Joindre un fichier (${MAX_UPLOAD_LABEL} par ajout)`}><Paperclip size={15} /></Button>
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => void discard()} disabled={sending} aria-label="Supprimer le brouillon" title="Supprimer le brouillon"><Trash2 size={15} /></Button>
      </footer>
    </>
  );
}
