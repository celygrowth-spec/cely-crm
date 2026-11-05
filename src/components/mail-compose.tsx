"use client";

// Composition d'un email depuis la fiche. Le brouillon est enregistré au fil de la saisie ;
// rien ne part sans le bouton « Envoyer », et un échec n'efface jamais le texte.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Eye, Paperclip, PencilLine, Send, Upload } from "lucide-react";
import { mailCall, mailOp, type MailOverview } from "@/lib/client/mail";
import { apiGet, attempt, useSync } from "@/lib/client/query";
import type { CompanyFile } from "@/lib/crm/files";
import { ACCEPT_ATTR, formatBytes } from "@/lib/crm/file-rules";
import { MAX_ATTACHMENTS_BYTES, isEmail, splitAddresses, withSignature, type MailMessage } from "@/lib/mail/types";
import { addFiles } from "./record-files";
import { Button, Field, Input, Modal, SaveIndicator, Textarea } from "./ui";

export type ComposeTarget = { message?: MailMessage; personId?: string | null; to?: string | null };

export function MailCompose({ companyId, target, onClose }: { companyId: string; target: ComposeTarget; onClose: () => void }) {
  const qc = useQueryClient();
  const sync = useSync();
  const m = target.message;
  const [id] = useState(() => m?.id ?? crypto.randomUUID());
  const [to, setTo] = useState(m ? m.to_addrs.join(", ") : (target.to ?? ""));
  const [cc, setCc] = useState(m?.cc_addrs.join(", ") ?? "");
  const [bcc, setBcc] = useState(m?.bcc_addrs.join(", ") ?? "");
  const [showCopies, setShowCopies] = useState(!!(m?.cc_addrs.length || m?.bcc_addrs.length));
  const [subject, setSubject] = useState(m?.subject ?? "");
  const [body, setBody] = useState(m?.body_text ?? "");
  const [fileIds, setFileIds] = useState<string[]>(() => m?.attachments.flatMap((a) => (a.file_id ? [a.file_id] : [])) ?? []);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const overview = useQuery({ queryKey: ["mail-overview"], queryFn: ({ signal }) => apiGet<MailOverview>("/api/mail/accounts", signal) });
  const account = overview.data?.accounts.find((a) => a.is_default && a.status === "connected") ?? null;
  const [signatureEdit, setSignatureEdit] = useState<string | null>(m?.signature ?? null);
  const signature = signatureEdit ?? account?.signature ?? "";
  const files = useQuery({ queryKey: ["company-files", companyId], queryFn: ({ signal }) => apiGet<CompanyFile[]>(`/api/fiches/${companyId}/files`, signal) });
  const available = (files.data ?? []).filter((f) => f.status === "ready");
  const attached = available.filter((f) => fileIds.includes(f.id));
  const totalBytes = attached.reduce((n, f) => n + f.size_bytes, 0);

  const payload = useCallback(() => ({
    account_id: account?.id ?? null,
    company_id: companyId,
    person_id: m?.person_id ?? target.personId ?? null,
    to: splitAddresses(to),
    cc: splitAddresses(cc),
    bcc: splitAddresses(bcc),
    subject,
    body,
    signature,
    file_ids: fileIds,
    in_reply_to: m?.in_reply_to ?? null,
    references: m?.references_hdr ?? null,
    thread_id: m?.provider_thread_id ?? null,
  }), [account?.id, bcc, body, cc, companyId, fileIds, m, signature, subject, target.personId, to]);

  // Enregistrements à la suite : une réponse plus ancienne n'écrase jamais une saisie plus récente.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const dirty = useRef(false);
  const failed = useRef(m?.status === "failed");
  const saveNow = useCallback(() => {
    const data = payload();
    dirty.current = false;
    setSave("saving");
    const run = chain.current.then(async () => {
      if (failed.current) {
        const r = await attempt(() => mailOp(id, { op: "reopen" }));
        if (!r.ok) return r;
        failed.current = false;
      }
      return attempt(() => mailCall<MailMessage>(`/api/mail/messages/${id}`, "PUT", data));
    });
    chain.current = run.catch(() => undefined);
    return run.then((r) => {
      if (!r.ok) {
        dirty.current = true;
        setSave("error");
      } else setSave("saved");
      return r;
    });
  }, [id, payload]);

  const empty = !to.trim() && !subject.trim() && !body.trim() && !fileIds.length;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    dirty.current = true;
    if (sending) return;
    const t = setTimeout(() => void saveNow(), 800);
    return () => clearTimeout(t);
    // « sending » n'est pas une modification de contenu
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, cc, bcc, subject, body, fileIds, signatureEdit]);

  async function close() {
    if (sending) return; // l'envoi se termine avant de fermer : son résultat doit être vu
    if (dirty.current && !empty) {
      const r = await saveNow();
      if (!r.ok) {
        toast.error(`Brouillon non enregistré : ${r.error}`);
        return; // le texte reste à l'écran
      }
    }
    sync(["company-mail", companyId]);
    onClose();
  }

  async function discard() {
    if (!confirm("Supprimer ce brouillon ?")) return;
    await chain.current;
    const r = await attempt(() => mailOp<null>(id, { op: "discard" }));
    // jamais enregistré : il n'y a rien à supprimer
    if (!r.ok && !/introuvable|ne peut plus/.test(r.error)) return void toast.error(r.error);
    dirty.current = false;
    sync(["company-mail", companyId]);
    onClose();
  }

  const invalid = [...splitAddresses(to), ...splitAddresses(cc), ...splitAddresses(bcc)].filter((a) => !isEmail(a));
  const canSend = !!account && !sending && splitAddresses(to).length > 0 && !invalid.length && !!subject.trim() && totalBytes <= MAX_ATTACHMENTS_BYTES;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    const saved = await saveNow();
    if (!saved.ok) {
      setSending(false);
      return setError(`Brouillon non enregistré, rien n'a été envoyé : ${saved.error}`);
    }
    let r;
    try {
      r = await mailOp(id, { op: "send" });
    } catch {
      // la demande a pu arriver au serveur : on ne laisse pas renvoyer depuis cet écran
      toast.error("Connexion perdue pendant l'envoi. Vérifiez l'état du message dans la fiche avant de renvoyer.");
      sync(["company-mail", companyId], ["company-timeline", companyId]);
      return onClose();
    }
    setSending(false);
    if (!r.ok) return setError(r.error);
    sync(["company-mail", companyId], ["company-timeline", companyId], ["company", companyId]);
    if (r.data.status === "accepted") {
      toast.success("Accepté par Gmail");
      return onClose();
    }
    if (r.data.status === "failed") {
      failed.current = true;
      return setError(r.data.last_error ?? "L'envoi a échoué. Votre texte est conservé.");
    }
    // incertain, ou déjà en cours ailleurs : ne pas proposer de renvoyer
    toast.warning(r.data.last_error ?? "Ce message est déjà en cours de traitement.");
    onClose();
  }

  const input = useRef<HTMLInputElement>(null);
  async function upload(list: File[]) {
    const added = await addFiles(companyId, list, qc);
    setFileIds((ids) => [...ids, ...added.map((f) => f.id)]);
    setPicker(true);
  }

  return (
    <Modal open onClose={close} title={m ? "Reprendre le message" : "Nouveau message"} wide>
      <div className="space-y-3">
        {overview.isSuccess && !account && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm">
            Aucun compte Gmail connecté. Votre brouillon est conservé ; <a href="/mail" className="font-semibold underline">connectez Gmail</a> pour l&apos;envoyer.
          </p>
        )}
        {account && <p className="text-xs text-muted">Depuis <span className="font-semibold text-ink">{account.email}</span></p>}

        {preview ? (
          <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
            <p><span className="text-muted">À :</span> {splitAddresses(to).join(", ") || "—"}</p>
            {cc.trim() && <p><span className="text-muted">Cc :</span> {splitAddresses(cc).join(", ")}</p>}
            {bcc.trim() && <p><span className="text-muted">Cci :</span> {splitAddresses(bcc).join(", ")}</p>}
            <p className="font-semibold">{subject || "(sans objet)"}</p>
            <p className="whitespace-pre-wrap">{withSignature(body, signature)}</p>
            {!!attached.length && <p className="text-xs text-muted">{attached.length} pièce(s) jointe(s) : {attached.map((f) => f.display_name).join(", ")}</p>}
          </div>
        ) : (
          <>
            <Field label="À">
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="adresse@exemple.fr" />
            </Field>
            {showCopies ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Cc"><Input value={cc} onChange={(e) => setCc(e.target.value)} /></Field>
                <Field label="Cci"><Input value={bcc} onChange={(e) => setBcc(e.target.value)} /></Field>
              </div>
            ) : (
              <button type="button" className="text-xs text-muted hover:text-ink" onClick={() => setShowCopies(true)}>Ajouter Cc ou Cci</button>
            )}
            {!!invalid.length && <p className="text-xs text-danger">Adresse invalide : {invalid.join(", ")}</p>}
            <Field label="Objet"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={500} /></Field>
            <Field label="Message"><Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-44" /></Field>
            <Field label="Signature" hint="Modifiable pour ce message. La signature par défaut se règle dans Mail.">
              <Textarea value={signature} onChange={(e) => setSignatureEdit(e.target.value)} className="min-h-14" />
            </Field>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => setPicker((p) => !p)}><Paperclip size={13} /> Fichiers de la fiche{attached.length ? ` (${attached.length})` : ""}</Button>
                <Button size="sm" onClick={() => input.current?.click()}><Upload size={13} /> Depuis mon ordinateur</Button>
                <span className="text-xs text-muted">{attached.length ? `${formatBytes(totalBytes)} · ` : ""}25 Mo maximum au total. Les fichiers ajoutés rejoignent ceux de la fiche.</span>
                <input ref={input} type="file" multiple accept={ACCEPT_ATTR} className="sr-only" onChange={(e) => { void upload([...(e.target.files ?? [])]); e.target.value = ""; }} />
              </div>
              {picker && (
                <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line p-2 text-sm">
                  {!available.length && <li className="text-muted">Aucun fichier sur cette fiche.</li>}
                  {available.map((f) => (
                    <li key={f.id}>
                      <label className="flex items-center gap-2">
                        <input type="checkbox" className="accent-violet-600" checked={fileIds.includes(f.id)} onChange={(e) => setFileIds((ids) => (e.target.checked ? [...ids, f.id] : ids.filter((x) => x !== f.id)))} />
                        <span className="min-w-0 flex-1 truncate">{f.display_name}</span>
                        <span className="text-xs text-muted">{formatBytes(f.size_bytes)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              {totalBytes > MAX_ATTACHMENTS_BYTES && <p className="mt-1 text-xs text-danger">Pièces jointes trop lourdes : retirez-en pour passer sous 25 Mo.</p>}
            </div>
          </>
        )}

        {error && <p role="alert" className="rounded-lg bg-danger/5 px-3 py-2 text-sm text-danger">{error} Votre texte est conservé.</p>}

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={discard} disabled={sending}>Supprimer le brouillon</Button>
          <SaveIndicator state={save} />
          <div className="ml-auto flex gap-2">
            <Button onClick={() => setPreview((p) => !p)}>{preview ? <><PencilLine size={14} /> Modifier</> : <><Eye size={14} /> Prévisualiser</>}</Button>
            <Button variant="primary" onClick={send} disabled={!canSend}><Send size={14} /> {sending ? "Envoi…" : "Envoyer"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
