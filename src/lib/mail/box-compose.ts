import "server-only";
// Rédaction depuis la boîte (lot M04). Les brouillons sont ceux de Gmail : créés, modifiés et repris dans les
// deux sens. L'envoi part d'un brouillon Gmail, une seule fois. Rien n'est stocké dans le CRM, sauf un verrou
// d'envoi (identifiant du brouillon, sans contenu).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { publicClient, rpc as serverRpc } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { CrmError } from "@/lib/crm/service";
import { gmail, ownerAccess } from "./box";
import { canModifyBox } from "./box-sync";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_LABEL, type AttachmentRef, type ComposeContext, type ComposeDraft, type ComposeSaved } from "./box-types";
import { GmailBoxError, deleteDraft, findDraftId, getAttachment, getBoxMessageFull, getDraft, gmailSignature, parseAddresses, sendDraft, writeDraft } from "./gmail-box";
import { buildMime } from "./mime";
import { escapeHtml, htmlToText } from "./render";
import { safeHtml } from "./service";
import { MAX_ATTACHMENTS_BYTES, MAX_ATTACHMENTS_LABEL, isEmail } from "./types";

const NEEDS_RECONNECT = "La rédaction n'est pas encore autorisée. Reconnectez Gmail depuis l'onglet « Compte et envois » en acceptant toutes les autorisations.";
const ID = /^[A-Za-z0-9_\-]{1,200}$/;

async function composeAccess(sb: SupabaseClient) {
  const access = await ownerAccess(sb);
  if (!canModifyBox(access.account.scopes)) throw new CrmError(NEEDS_RECONNECT);
  return access;
}

/** Adresse, nom et signature pour une nouvelle rédaction : ceux réglés dans Gmail, sinon ceux du CRM. */
export async function composeContext(sb: SupabaseClient): Promise<ComposeContext> {
  const { account, token } = await ownerAccess(sb);
  const fromGmail = await gmail(() => gmailSignature(token, account.email));
  const fallback = account.signature.trim() ? account.signature.trim().split(/\r?\n/).map((l) => `<p>${escapeHtml(l)}</p>`).join("") : "";
  return {
    email: account.email,
    name: fromGmail?.name ?? account.display_name,
    signature_html: safeHtml(fromGmail?.signature_html || fallback),
    can_compose: canModifyBox(account.scopes),
  };
}

const addresses = z.array(z.string().trim().toLowerCase().refine(isEmail, "Adresse email invalide")).max(50, "50 destinataires maximum par champ");
const saveSchema = z.object({
  draft_id: z.string().regex(ID).nullish(),
  thread_id: z.string().regex(ID).nullish(),
  // en-têtes de fil repris du message auquel on répond ; un retour à la ligne y est refusé (construction du message)
  in_reply_to: z.string().max(1000).nullish(),
  references: z.string().max(8000).nullish(),
  to: addresses,
  cc: addresses,
  bcc: addresses,
  subject: z.string().max(500),
  html: z.string().max(500_000),
  keep: z.array(z.object({ message_id: z.string().regex(ID), n: z.number().int().min(0).max(200) })).max(30),
});
export type ComposeInput = z.input<typeof saveSchema>;
export type UploadedFile = { name: string; type: string; data: Buffer };

/**
 * Enregistre le brouillon dans Gmail (création, ou remplacement de `draft_id`). Les pièces jointes déjà dans Gmail
 * (`keep`) sont relues côté serveur ; seuls les nouveaux fichiers viennent du navigateur.
 */
export async function saveComposeDraft(sb: SupabaseClient, input: unknown, files: UploadedFile[] = []): Promise<ComposeSaved> {
  const p = saveSchema.parse(input);
  const { account, token } = await composeAccess(sb);
  if (files.reduce((n, f) => n + f.data.length, 0) > MAX_UPLOAD_BYTES) throw new CrmError(`Fichiers ajoutés trop volumineux (${MAX_UPLOAD_LABEL} au plus à la fois). Ajoutez-les un par un.`);

  const kept: { name: string; mimeType: string; data: Buffer }[] = [];
  for (const messageId of [...new Set(p.keep.map((k) => k.message_id))]) {
    const source = await gmail(() => getBoxMessageFull(token, messageId));
    if (!source) throw new CrmError("Une pièce jointe n'existe plus dans Gmail. Retirez-la puis réessayez.");
    for (const k of p.keep.filter((x) => x.message_id === messageId)) {
      const meta = source.attachments[k.n];
      if (!meta) throw new CrmError("Une pièce jointe n'existe plus dans Gmail. Retirez-la puis réessayez.");
      kept.push({ name: meta.name, mimeType: meta.mime_type, data: await gmail(() => getAttachment(token, messageId, meta.id)) });
    }
  }
  const attachments = [
    ...kept,
    ...files.map((f) => ({ name: f.name.slice(0, 255) || "fichier", mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type : "application/octet-stream", data: f.data })),
  ].map((a) => ({ ...a, mimeType: /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? a.mimeType : "application/octet-stream" }));
  if (attachments.reduce((n, a) => n + a.data.length, 0) > MAX_ATTACHMENTS_BYTES) throw new CrmError(`Pièces jointes trop volumineuses (${MAX_ATTACHMENTS_LABEL} au total).`);

  const html = safeHtml(p.html);
  let raw: Buffer;
  try {
    raw = buildMime({
      from: { email: account.email, name: account.display_name },
      // un brouillon peut ne pas encore avoir de destinataire : Gmail l'accepte, l'envoi le refusera
      to: p.to.length ? p.to : [account.email],
      cc: p.cc, bcc: p.bcc, subject: p.subject, text: htmlToText(html), html,
      inReplyTo: p.in_reply_to ?? null, references: p.references ?? null, attachments,
    });
  } catch (e) {
    throw new CrmError(e instanceof Error ? e.message : "Message invalide.");
  }
  if (!p.to.length) raw = Buffer.from(raw.toString("latin1").replace(/^To: .*\r\n/m, ""), "latin1");

  let draft;
  try {
    draft = await writeDraft(token, raw, { id: p.draft_id, threadId: p.thread_id });
  } catch (e) {
    // brouillon supprimé ou déjà envoyé depuis Gmail entre-temps : on ne le recrée pas en silence
    if (e instanceof GmailBoxError && e.code === "not_found" && p.draft_id) throw new CrmError("Ce brouillon n'existe plus dans Gmail (envoyé ou supprimé ailleurs).");
    if (e instanceof GmailBoxError) throw new CrmError(e.message);
    throw e;
  }
  return {
    draft_id: draft.id, message_id: draft.message_id, thread_id: draft.thread_id,
    attachments: attachments.map((a, n) => ({ message_id: draft.message_id, n, name: a.name, size: a.data.length })),
  };
}

/** Reprend un brouillon de la boîte (créé ici ou dans Gmail) à partir de son message. */
export async function loadComposeDraft(sb: SupabaseClient, messageId: string): Promise<ComposeDraft> {
  if (!ID.test(messageId)) throw new CrmError("Brouillon introuvable.");
  const { token } = await composeAccess(sb);
  const id = await gmail(() => findDraftId(token, messageId));
  const draft = id ? await gmail(() => getDraft(token, id)) : null;
  if (!draft) throw new CrmError("Ce brouillon n'existe plus dans Gmail.");
  const m = draft.message;
  const list = (v: string | null) => parseAddresses(v).map((a) => a.email);
  return {
    draft_id: draft.id, thread_id: m.thread_id, in_reply_to: null, references: m.references,
    to: list(m.to_full), cc: list(m.cc_full), bcc: list(m.bcc_full), subject: m.subject,
    html: safeHtml(m.html ?? (m.text ? m.text.split(/\r?\n/).map((l) => `<p>${escapeHtml(l)}</p>`).join("") : "")),
    attachments: m.attachments.map((a, n) => ({ message_id: m.id, n, name: a.name, size: a.size })) satisfies AttachmentRef[],
  };
}

export type SendResult = { status: "sent"; thread_id: string | null } | { status: "already" };

/**
 * Envoie un brouillon Gmail. Un verrou en base garantit un seul envoi par brouillon (double clic, deux onglets) ;
 * Gmail retire ensuite le brouillon, donc un nouvel essai tardif ne trouve plus rien à envoyer.
 * Échec certain : le brouillon reste dans Gmail et peut être renvoyé. Résultat incertain : on vérifie si le
 * brouillon existe encore avant de conclure.
 */
export async function sendComposeDraft(sb: SupabaseClient, draftId: string): Promise<SendResult> {
  if (!ID.test(draftId)) throw new CrmError("Brouillon introuvable.");
  const { account, token } = await composeAccess(sb);
  const lock = (fn: string) => serverRpc<boolean>(publicClient(), fn, { p_server_key: serverRpcKey(), p_account: account.id, p_draft: draftId });
  if (!(await lock("mailbox_send_claim"))) return { status: "already" };

  const draft = await gmail(() => getDraft(token, draftId)).catch(async (e) => { await lock("mailbox_send_release"); throw e; });
  if (!draft) return { status: "already" }; // déjà parti ou supprimé : rien à renvoyer
  if (!parseAddresses(draft.message.to_full).length && !parseAddresses(draft.message.cc_full).length && !parseAddresses(draft.message.bcc_full).length) {
    await lock("mailbox_send_release");
    throw new CrmError("Indiquez au moins un destinataire.");
  }
  try {
    const sent = await sendDraft(token, draftId);
    // historique de la fiche concernée (lot M05) : un échec ici ne remet jamais l'envoi en cause
    const m = draft.message;
    await serverRpc(publicClient(), "mailbox_record_sent", {
      p_server_key: serverRpcKey(), p_account: account.id,
      p: { provider_message_id: sent.message_id, provider_thread_id: sent.thread_id, rfc_message_id: m.rfc_message_id, to: m.to, cc: m.cc, subject: m.subject,
        text: m.text ?? (m.html ? htmlToText(safeHtml(m.html)) : "") },
    }).catch(() => undefined);
    return { status: "sent", thread_id: sent.thread_id };
  } catch (e) {
    if (!(e instanceof GmailBoxError)) throw e;
    if (e.code === "not_found") return { status: "already" };
    if (e.code !== "network") {
      // refus clair de Gmail (accès, autorisation, quota) : rien n'est parti
      await lock("mailbox_send_release");
      throw new CrmError(`${e.message} Le brouillon est conservé.`);
    }
    // pas de réponse claire : le message est parti si et seulement si le brouillon a disparu
    const still = await getDraft(token, draftId).catch(() => undefined);
    if (still === null) return { status: "sent", thread_id: draft.message.thread_id };
    if (still) {
      await lock("mailbox_send_release");
      throw new CrmError("Gmail n'a pas envoyé le message. Le brouillon est conservé : réessayez.");
    }
    throw new CrmError("Gmail n'a pas répondu clairement : le message est peut-être parti. Vérifiez « Envoyés » avant de le renvoyer.");
  }
}

export async function discardComposeDraft(sb: SupabaseClient, draftId: string): Promise<void> {
  if (!ID.test(draftId)) throw new CrmError("Brouillon introuvable.");
  const { token } = await composeAccess(sb);
  await gmail(() => deleteDraft(token, draftId));
}
