"use client";

// Mémoire d'un brouillon d'email.
// * Enregistrement automatique après un court délai, les uns après les autres : une réponse ancienne
//   n'écrase jamais une saisie plus récente (rien de ce qui revient du serveur ne remplace le texte affiché).
// * Version : chaque enregistrement indique la version lue. Si le brouillon a été enregistré ailleurs
//   entre-temps (autre onglet), rien n'est écrasé : `conflict` décrit la version distante.
// * Copie locale (localStorage) de toute saisie pas encore confirmée par le serveur : un rechargement ou
//   une fermeture brutale ne perd rien, et la saisie est proposée à la réouverture.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { mailCall } from "@/lib/client/mail";
import type { MailMessage } from "@/lib/mail/types";

export type DraftData = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html: string | null;
  fileIds: string[];
  personId: string | null;
  signature: string;
  templateId: string | null;
  collective: boolean;
};
export type SaveState = "idle" | "saving" | "saved" | "error";
type Ctx = { companyId: string; accountId: string | null; inReplyTo: string | null; references: string | null; threadId: string | null };
type SaveResponse = (MailMessage & { conflict: false }) | { conflict: true; current: MailMessage };

const KEY = (id: string) => `cely-mail-draft:${id}`;
type Backup = { data: DraftData; at: number };

export function readBackup(id: string): Backup | null {
  try {
    const raw = localStorage.getItem(KEY(id));
    return raw ? (JSON.parse(raw) as Backup) : null;
  } catch {
    return null;
  }
}
const writeBackup = (id: string, data: DraftData) => {
  try { localStorage.setItem(KEY(id), JSON.stringify({ data, at: Date.now() })); } catch { /* stockage indisponible */ }
};
const dropBackup = (id: string) => {
  try { localStorage.removeItem(KEY(id)); } catch { /* idem */ }
};

export const sameContent = (a: DraftData, b: DraftData) => JSON.stringify(a) === JSON.stringify(b);

export const fromMessage = (m: MailMessage): DraftData => ({
  to: m.to_addrs, cc: m.cc_addrs, bcc: m.bcc_addrs, subject: m.subject, text: m.body_text, html: m.body_html ?? null,
  fileIds: m.attachments.flatMap((a) => (a.file_id ? [a.file_id] : [])), personId: m.person_id, signature: m.signature,
  templateId: m.template_id ?? null, collective: m.collective ?? false,
});

export function useDraft(id: string, ctx: Ctx, initialVersion: number | null, data: DraftData, empty: boolean) {
  const [state, setState] = useState<SaveState>(initialVersion === null ? "idle" : "saved");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MailMessage | null>(null);
  const version = useRef<number | null>(initialVersion);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(data);
  const savedData = useRef<DraftData | null>(initialVersion === null ? null : data);
  // copie (en état) de ce que le serveur a confirmé : sert à afficher honnêtement « Enregistrement… »
  const [savedJson, setSavedJson] = useState<string | null>(initialVersion === null ? null : JSON.stringify(data));
  const ctxRef = useRef(ctx);
  useLayoutEffect(() => {
    latest.current = data;
    ctxRef.current = ctx;
  });

  const dirty = () => !savedData.current || !sameContent(savedData.current, latest.current);

  /** Enregistre la saisie courante. `force` : écrase volontairement la version distante. */
  const save = useCallback((opts: { force?: boolean } = {}) => {
    const run = chain.current.then(async (): Promise<{ ok: boolean; error?: string; conflict?: boolean }> => {
      const d = latest.current;
      if (!opts.force && savedData.current && sameContent(savedData.current, d)) return { ok: true };
      setState("saving");
      const c = ctxRef.current;
      let r;
      try {
        r = await mailCall<SaveResponse>(`/api/mail/messages/${id}`, "PUT", {
          account_id: c.accountId, company_id: c.companyId, person_id: d.personId,
          to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, body: d.text, html: d.html, signature: d.signature,
          file_ids: d.fileIds, in_reply_to: c.inReplyTo, references: c.references, thread_id: c.threadId,
          template_id: d.templateId, collective: d.collective,
          expected_version: opts.force ? null : version.current,
        });
      } catch {
        setState("error");
        return { ok: false, error: "Connexion impossible : la saisie est gardée sur cet appareil." };
      }
      if (!r.ok) {
        setState("error");
        return { ok: false, error: r.error };
      }
      if (r.data.conflict) {
        setConflict(r.data.current);
        setState("error");
        return { ok: false, conflict: true, error: "Ce brouillon a été modifié ailleurs." };
      }
      version.current = r.data.draft_version ?? (version.current ?? 0) + 1;
      savedData.current = d;
      setSavedJson(JSON.stringify(d));
      setSavedAt(r.data.updated_at);
      // la saisie a pu continuer pendant l'enregistrement : la copie locale reste tant qu'elle diffère
      if (sameContent(d, latest.current)) dropBackup(id);
      setState(sameContent(d, latest.current) ? "saved" : "saving");
      return { ok: true };
    });
    chain.current = run.catch(() => undefined);
    return run;
  }, [id]);

  // à chaque modification : copie locale immédiate, enregistrement après 700 ms de calme
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (conflict || (empty && !savedData.current)) return;
    writeBackup(id, data);
    const t = setTimeout(() => void save(), 700);
    return () => clearTimeout(t);
  }, [data, id, save, conflict, empty]);

  // échec réseau : nouvel essai toutes les 5 s tant que rien ne change (la copie locale protège la saisie)
  useEffect(() => {
    if (state !== "error" || conflict) return;
    const t = setTimeout(() => void save(), 5000);
    return () => clearTimeout(t);
  }, [state, conflict, save]);

  // fermeture d'onglet avec une saisie non confirmée : le navigateur demande confirmation
  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!empty && dirty()) { e.preventDefault(); }
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  });

  /** Conflit : garder ma saisie (écrase l'autre version). */
  const keepMine = useCallback(async () => {
    setConflict(null);
    return save({ force: true });
  }, [save]);

  /** Conflit : prendre l'autre version ; ma saisie est conservée dans un nouveau brouillon. */
  const takeTheirs = useCallback(async (copyId: string) => {
    const mine = latest.current;
    const c = ctxRef.current;
    const r = await mailCall<SaveResponse>(`/api/mail/messages/${copyId}`, "PUT", {
      account_id: c.accountId, company_id: c.companyId, person_id: mine.personId, to: mine.to, cc: mine.cc, bcc: mine.bcc,
      subject: mine.subject ? `${mine.subject} (copie)` : "(copie)", body: mine.text, html: mine.html, signature: mine.signature,
      file_ids: mine.fileIds, template_id: mine.templateId, collective: mine.collective, expected_version: null,
    }).catch(() => ({ ok: false as const, error: "Connexion impossible" }));
    const theirs = conflict;
    if (theirs) {
      version.current = theirs.draft_version ?? null;
      savedData.current = fromMessage(theirs);
      setSavedJson(JSON.stringify(savedData.current));
    }
    dropBackup(id);
    setConflict(null);
    setState("saved");
    return { copied: r.ok, theirs };
  }, [conflict, id]);

  const discardBackup = useCallback(() => dropBackup(id), [id]);

  // modifié et pas encore confirmé par le serveur (hors brouillon vide jamais enregistré)
  const pending = !empty && savedJson !== JSON.stringify(data);
  const shown: SaveState = state === "error" ? "error" : pending ? "saving" : state;
  return { state: shown, savedAt, conflict, save, keepMine, takeTheirs, isDirty: dirty, discardBackup, version };
}
