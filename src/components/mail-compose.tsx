"use client";

// Composeur d'email de la fiche. Le brouillon s'enregistre au fil de la saisie (voir use-draft) ;
// rien ne part sans « Envoyer », et un échec n'efface jamais le texte. Fermer garde le brouillon.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { AlertTriangle, Eye, Maximize2, Minimize2, Paperclip, PencilLine, Send, Trash2, Upload, X } from "lucide-react";
import { mailOp, type MailOverview } from "@/lib/client/mail";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import type { CompanyFile } from "@/lib/crm/files";
import { ACCEPT_ATTR, formatBytes } from "@/lib/crm/file-rules";
import { MAX_ATTACHMENTS_BYTES, isEmail, withSignature, type MailMessage } from "@/lib/mail/types";
import { addFiles } from "./record-files";
import { Button, Input, SaveIndicator, Textarea, cn } from "./ui";
import { RecipientsInput, type Contact } from "./mail/recipients";
import { fromMessage, readBackup, sameContent, useDraft, type DraftData } from "./mail/use-draft";

export type ComposeTarget = { message?: MailMessage; personId?: string | null; to?: string | null };

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

export function MailCompose({ companyId, target, contacts = [], onClose }: { companyId: string; target: ComposeTarget; contacts?: Contact[]; onClose: () => void }) {
  // une reprise de version distante remonte le composeur avec le contenu choisi
  const [rev, setRev] = useState<{ n: number; message: MailMessage | null }>({ n: 0, message: target.message ?? null });
  // rendu au niveau du document : un parent animé (transform) confinerait la position fixe
  if (typeof document === "undefined") return null;
  return createPortal(
    <Composer key={rev.n} companyId={companyId} target={{ ...target, message: rev.message ?? undefined }} contacts={contacts} onClose={onClose} onReload={(m) => setRev((r) => ({ n: r.n + 1, message: m }))} />,
    document.body,
  );
}

function Composer({ companyId, target, contacts, onClose, onReload }: { companyId: string; target: ComposeTarget; contacts: Contact[]; onClose: () => void; onReload: (m: MailMessage) => void }) {
  const qc = useQueryClient();
  const sync = useSync();
  const m = target.message;
  const [id] = useState(() => m?.id ?? crypto.randomUUID());
  const initial: DraftData = m ? fromMessage(m) : {
    to: target.to ? [target.to] : [], cc: [], bcc: [], subject: "", text: "", html: null, fileIds: [], personId: target.personId ?? null, signature: "",
  };
  // saisie retrouvée sur cet appareil, plus récente que la version enregistrée
  const [recovered, setRecovered] = useState(() => {
    const b = readBackup(id);
    if (!b) return null;
    if (m && (b.at <= Date.parse(m.updated_at) || sameContent(b.data, initial))) return null;
    return b;
  });
  const [d0, setD] = useState<DraftData>(initial);
  const set = (patch: Partial<DraftData>) => setD((x) => ({ ...x, ...patch }));
  const [showCopies, setShowCopies] = useState(!!(initial.cc.length || initial.bcc.length));
  const [expanded, setExpanded] = useState(false);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; size: number; error?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const overview = useQuery({ queryKey: ["mail-overview"], queryFn: ({ signal }) => apiGet<MailOverview>("/api/mail/accounts", signal) });
  const account = overview.data?.accounts.find((a) => a.is_default && a.status === "connected") ?? null;
  const lost = overview.data?.accounts.find((a) => a.status === "needs_reconnect") ?? null;
  // signature : celle déjà enregistrée sur le brouillon, sinon celle du compte expéditeur (une seule fois)
  const existing = !!m;
  const accountSignature = account?.signature ?? "";
  const d = useMemo(() => (existing || d0.signature || !accountSignature ? d0 : { ...d0, signature: accountSignature }), [d0, existing, accountSignature]);

  const files = useQuery({ queryKey: ["company-files", companyId], queryFn: ({ signal }) => apiGet<CompanyFile[]>(`/api/fiches/${companyId}/files`, signal) });
  const available = (files.data ?? []).filter((f) => f.status === "ready");
  const attached = available.filter((f) => d.fileIds.includes(f.id));
  const totalBytes = attached.reduce((n, f) => n + f.size_bytes, 0);

  const empty = !d.subject.trim() && !d.text.trim() && !d.fileIds.length;
  const draft = useDraft(id, {
    companyId, accountId: account?.id ?? m?.account_id ?? null,
    inReplyTo: m?.in_reply_to ?? null, references: m?.references_hdr ?? null, threadId: m?.provider_thread_id ?? null,
  }, m ? (m.draft_version ?? 0) : null, d, empty);

  const recipients = [...d.to, ...d.cc, ...d.bcc];
  const invalid = recipients.filter((a) => !isEmail(a));
  const uploading = uploads.some((u) => !u.error);
  const blockers = [
    !account && (lost ? "Gmail est à reconnecter" : "Aucun compte Gmail connecté"),
    !d.to.length && "Ajoutez un destinataire",
    invalid.length > 0 && `Adresse invalide : ${invalid.join(", ")}`,
    !d.subject.trim() && "Ajoutez un objet",
    !d.text.trim() && "Le message est vide",
    uploading && "Un fichier est en cours de transfert",
    totalBytes > MAX_ATTACHMENTS_BYTES && "Pièces jointes au-delà de 25 Mo",
  ].filter(Boolean) as string[];
  const canSend = !sending && !blockers.length && !draft.conflict;

  async function close() {
    if (sending) return; // le résultat d'un envoi doit être vu
    if (!empty && draft.isDirty()) {
      const r = await draft.save();
      if (!r.ok && !r.conflict) toast.warning("Brouillon gardé sur cet appareil : il sera enregistré à la prochaine ouverture.");
      if (r.conflict) return; // le choix doit être fait avant de fermer
    }
    sync(["company-mail", companyId]);
    onClose();
  }
  // clavier : focus initial dans la fenêtre (objet si le destinataire est déjà là), Tab reste dans la fenêtre,
  // et le focus revient à l'élément d'origine à la fermeture
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const target = panel.current?.querySelector<HTMLElement>(initial.to.length ? 'input[aria-label="Objet"]' : 'input[aria-label="Destinataires"]');
    target?.focus();
    return () => opener?.focus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    const items = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([type="file"]):not([disabled]), textarea, [contenteditable="true"], a[href], select')].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  // Échap ferme (et garde le brouillon)
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); void closeRef.current(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function discard() {
    if (!confirm("Supprimer définitivement ce brouillon ?")) return;
    await draft.save().catch(() => undefined);
    const r = await attempt(() => mailOp<null>(id, { op: "discard" }));
    if (!r.ok && !/introuvable|ne peut plus/.test(r.error)) return void toast.error(r.error);
    draft.discardBackup();
    toast.success("Brouillon supprimé");
    sync(["company-mail", companyId]);
    onClose();
  }

  const sendLock = useRef(false);
  async function send() {
    if (!canSend || sendLock.current) return; // deux clics rapprochés arrivent avant le nouveau rendu
    sendLock.current = true;
    setSending(true);
    setError(null);
    const saved = await draft.save();
    if (!saved.ok) {
      sendLock.current = false;
      setSending(false);
      return setError(`Brouillon non enregistré, rien n'a été envoyé : ${saved.error}`);
    }
    let r;
    try {
      r = await mailOp(id, { op: "send" });
    } catch {
      toast.error("Connexion perdue pendant l'envoi. Vérifiez l'état du message dans la fiche avant de renvoyer.");
      sync(["company-mail", companyId], ["company-timeline", companyId]);
      return onClose();
    }
    sendLock.current = false;
    setSending(false);
    if (!r.ok) return setError(r.error);
    sync(["company-mail", companyId], ["company-timeline", companyId], ["company", companyId]);
    if (r.data.status === "accepted") {
      draft.discardBackup();
      toast.success("Accepté par Gmail");
      return onClose();
    }
    if (r.data.status === "failed") {
      // redevient un brouillon modifiable, pièces jointes comprises
      await attempt(() => mailOp(id, { op: "reopen" }));
      return setError(r.data.last_error ?? "L'envoi a échoué.");
    }
    toast.warning(r.data.last_error ?? "Ce message est déjà en cours de traitement.");
    onClose();
  }

  const input = useRef<HTMLInputElement>(null);
  async function upload(list: File[]) {
    setUploads((u) => [...u, ...list.map((f) => ({ name: f.name, size: f.size }))]);
    try {
      const added = await addFiles(companyId, list, qc);
      set({ fileIds: [...d.fileIds, ...added.map((f) => f.id)] });
      setUploads((u) => u.filter((x) => !list.some((f) => f.name === x.name)));
      const failed = list.filter((f) => !added.some((a) => a.display_name === f.name));
      if (failed.length) setUploads((u) => [...u, ...failed.map((f) => ({ name: f.name, size: f.size, error: "Transfert échoué" }))]);
    } catch {
      setUploads((u) => u.map((x) => (list.some((f) => f.name === x.name) ? { ...x, error: "Transfert échoué" } : x)));
    }
  }

  const contactOf = useMemo(() => new Map(contacts.map((c) => [c.email.toLowerCase(), c])), [contacts]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/30 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="Composer un email" data-composer>
      <button type="button" className="absolute inset-0 cursor-default" aria-label="Fermer le composeur (le brouillon est gardé)" tabIndex={-1} onClick={() => void close()} />
      <div ref={panel} onKeyDown={trap} className={cn("relative flex w-full flex-col overflow-hidden bg-white shadow-2xl",
        expanded ? "h-dvh sm:h-[calc(100dvh-2rem)] sm:max-w-none sm:rounded-2xl" : "h-dvh sm:h-[min(88dvh,820px)] sm:max-w-3xl sm:rounded-2xl")}>
        {/* en-tête */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <h2 className="font-display text-base font-bold">{m ? "Brouillon" : "Nouveau message"}</h2>
          <span className="text-xs text-muted" data-save-state={draft.state}>
            {draft.state === "saving" ? "Enregistrement…" : draft.state === "saved" ? `Enregistré${draft.savedAt ? ` à ${timeFmt.format(new Date(draft.savedAt))}` : ""}` : draft.state === "error" ? <span className="text-danger">Échec de sauvegarde</span> : ""}
          </span>
          <SaveIndicator state="idle" />
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={() => setExpanded((x) => !x)} className="hidden rounded-lg p-2 text-muted hover:bg-surface hover:text-ink sm:inline-flex" aria-label={expanded ? "Réduire" : "Agrandir"}>
              {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button type="button" onClick={() => void close()} className="rounded-lg p-2 text-muted hover:bg-surface hover:text-ink" aria-label="Fermer (le brouillon est gardé)"><X size={18} /></button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
          {draft.conflict && (
            <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm" data-conflict>
              <p className="flex items-center gap-1.5 font-semibold text-warning"><AlertTriangle size={14} /> Ce brouillon a été modifié ailleurs (autre onglet ou appareil) à {timeFmt.format(new Date(draft.conflict.updated_at))}.</p>
              <p className="mt-0.5 text-muted">Rien n&apos;a été écrasé. Choisissez la version à garder.</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void draft.keepMine().then((r) => r.ok && toast.success("Votre version est enregistrée"))}>Garder ma version</Button>
                <Button size="sm" onClick={() => void draft.takeTheirs(crypto.randomUUID()).then((r) => {
                  toast.success(r.copied ? "Autre version chargée ; la vôtre est gardée dans un nouveau brouillon (copie)." : "Autre version chargée.");
                  sync(["company-mail", companyId]);
                  if (r.theirs) onReload(r.theirs);
                })}>Prendre l&apos;autre version</Button>
              </div>
            </div>
          )}
          {recovered && (
            <div className="rounded-xl border border-violet-line bg-violet-soft/40 px-3 py-2 text-sm" data-recovered>
              <p>Une saisie non enregistrée a été retrouvée sur cet appareil ({timeFmt.format(new Date(recovered.at))}).</p>
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" variant="primary" onClick={() => { setD(recovered.data); setRecovered(null); }}>Restaurer</Button>
                <Button size="sm" variant="ghost" onClick={() => { draft.discardBackup(); setRecovered(null); }}>Ignorer</Button>
              </div>
            </div>
          )}

          {/* expéditeur */}
          {account ? (
            <p className="text-xs text-muted">De <span className="font-semibold text-ink" data-sender>{account.display_name ? `${account.display_name} · ` : ""}{account.email}</span></p>
          ) : overview.isSuccess && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm" data-gmail-off>
              {lost ? <>Gmail ({lost.email}) est à reconnecter.</> : <>Aucun compte Gmail connecté.</>} Votre brouillon est conservé.{" "}
              <a href={`/api/mail/oauth/start${lost ? `?hint=${encodeURIComponent(lost.email)}` : ""}`} className="font-semibold underline">{lost ? "Reconnecter Gmail" : "Connecter Gmail"}</a>
            </p>
          )}

          {preview ? (
            <Preview d={d} attached={attached.map((f) => f.display_name)} contactOf={contactOf} />
          ) : (
            <>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1"><RecipientsInput label="À" value={d.to} onChange={(to) => set({ to })} contacts={contacts} /></div>
                {!showCopies && <button type="button" className="mt-2 shrink-0 text-xs font-semibold text-muted hover:text-ink" onClick={() => setShowCopies(true)}>Cc / Cci</button>}
              </div>
              {showCopies && (
                <>
                  <RecipientsInput label="Cc" value={d.cc} onChange={(cc) => set({ cc })} contacts={contacts} />
                  <RecipientsInput label="Cci" value={d.bcc} onChange={(bcc) => set({ bcc })} contacts={contacts} />
                </>
              )}
              {d.to.length > 1 && (
                <p className="rounded-lg bg-surface px-3 py-1.5 text-xs text-muted" data-multi>
                  {d.to.length} destinataires : ils reçoivent le même message et voient les adresses des autres. Pour écrire à chacun, faites un brouillon par personne.
                </p>
              )}
              <Input value={d.subject} onChange={(e) => set({ subject: e.target.value })} maxLength={500} placeholder="Objet" aria-label="Objet" className="font-semibold" />
              <Textarea value={d.text} onChange={(e) => set({ text: e.target.value })} aria-label="Message" placeholder="Votre message…" spellCheck className="min-h-48 flex-1 resize-none" />
              {d.signature && (
                <div className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted" data-signature>
                  <p className="mb-1 font-label text-[10px] font-bold tracking-wide uppercase">Signature</p>
                  <p className="whitespace-pre-wrap">{d.signature}</p>
                </div>
              )}

              {/* pièces jointes */}
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => setPicker((p) => !p)}><Paperclip size={13} /> Documents de la fiche</Button>
                  <Button size="sm" onClick={() => input.current?.click()}><Upload size={13} /> Depuis l&apos;ordinateur</Button>
                  <span className="text-xs text-muted">{attached.length ? `${formatBytes(totalBytes)} sur 25 Mo` : "25 Mo maximum au total"}</span>
                  <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="sr-only" onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
                </div>
                {(attached.length > 0 || uploads.length > 0) && (
                  <ul className="mt-2 flex flex-wrap gap-1.5" data-attachments>
                    {attached.map((f) => (
                      <li key={f.id} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1 text-xs">
                        <Paperclip size={12} className="text-muted" /><span className="max-w-48 truncate font-semibold">{f.display_name}</span><span className="text-muted">{formatBytes(f.size_bytes)}</span>
                        <button type="button" aria-label={`Retirer ${f.display_name}`} onClick={() => set({ fileIds: d.fileIds.filter((x) => x !== f.id) })} className="rounded p-0.5 hover:bg-white"><X size={11} /></button>
                      </li>
                    ))}
                    {uploads.map((u) => (
                      <li key={u.name} className={cn("inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs", u.error ? "border-danger/40 text-danger" : "border-line text-muted")}>
                        <Upload size={12} /><span className="max-w-48 truncate">{u.name}</span><span>{u.error ?? "Transfert…"}</span>
                        {u.error && <button type="button" aria-label={`Retirer ${u.name}`} onClick={() => setUploads((x) => x.filter((y) => y.name !== u.name))} className="rounded p-0.5"><X size={11} /></button>}
                      </li>
                    ))}
                  </ul>
                )}
                {picker && (
                  <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-sm">
                    {!available.length && <li className="text-muted">Aucun document sur cette fiche.</li>}
                    {available.map((f) => (
                      <li key={f.id}>
                        <label className="flex items-center gap-2">
                          <input type="checkbox" className="accent-violet-600" checked={d.fileIds.includes(f.id)} onChange={(e) => set({ fileIds: e.target.checked ? [...d.fileIds, f.id] : d.fileIds.filter((x) => x !== f.id) })} />
                          <span className="min-w-0 flex-1 truncate">{f.display_name}</span>
                          <span className="text-xs text-muted">{formatBytes(f.size_bytes)}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}

          {error && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error} Votre brouillon et ses pièces jointes sont conservés.</p>}
        </div>

        {/* pied */}
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={discard} disabled={sending} className="text-muted"><Trash2 size={14} /> <span className="max-sm:sr-only">Supprimer le brouillon</span></Button>
          {!canSend && blockers[0] && !sending && <span className="text-xs text-muted" data-blocker>{blockers[0]}</span>}
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setPreview((p) => !p)}>{preview ? <><PencilLine size={14} /> Modifier</> : <><Eye size={14} /> Aperçu</>}</Button>
            <Button variant="primary" onClick={send} disabled={!canSend} title={blockers.join(" · ") || undefined}><Send size={14} /> {sending ? "Envoi…" : "Envoyer"}</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Preview({ d, attached, contactOf }: { d: DraftData; attached: string[]; contactOf: Map<string, Contact> }) {
  const who = (list: string[]) => list.map((a) => contactOf.get(a.toLowerCase())?.name ? `${contactOf.get(a.toLowerCase())!.name} <${a}>` : a).join(", ");
  return (
    <div className="space-y-2 rounded-xl border border-line p-4 text-sm" data-preview>
      <p><span className="text-muted">À :</span> {who(d.to) || "—"}</p>
      {!!d.cc.length && <p><span className="text-muted">Cc :</span> {who(d.cc)}</p>}
      {!!d.bcc.length && <p><span className="text-muted">Cci :</span> {who(d.bcc)}</p>}
      <p className="font-semibold">{d.subject || "(sans objet)"}</p>
      <p className="whitespace-pre-wrap">{withSignature(d.text, d.signature)}</p>
      {!!attached.length && <p className="text-xs text-muted">{attached.length} pièce(s) jointe(s) : {attached.join(", ")}</p>}
    </div>
  );
}
