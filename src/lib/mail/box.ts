import "server-only";
// Lecture de l'index de la boîte avec la session du propriétaire (les politiques d'accès filtrent en base).
import type { SupabaseClient } from "@supabase/supabase-js";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { ensureServerKey } from "@/lib/appointments/owner";
import { publicClient } from "@/lib/appointments/server";
import { CrmError } from "@/lib/crm/service";
import { gmailAccess } from "@/lib/jobs/run";
import { BOX_ACTIONS, type BoxActionResult, type BoxFolder, type BoxOpenThread, type BoxStatus, type BoxThread, type BoxThreadPage } from "./box-types";
import { canModifyBox } from "./box-sync";
import { GmailBoxError, getAttachment, getThread, modifyThread, parseAddresses, pooled, searchThreadIds, trashThread, type FullMessage, type ThreadLabels } from "./gmail-box";
import { rpc as serverRpc } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";

export async function boxStatus(sb: SupabaseClient): Promise<BoxStatus> {
  const { data: accounts, error } = await sb.from("mail_accounts").select("id, email, status, is_default, connected_at, scopes").neq("status", "disconnected")
    .order("is_default", { ascending: false }).order("connected_at", { ascending: false }).limit(1);
  if (error) throw new CrmError(`Lecture de la boîte impossible : ${error.message}`);
  const account = accounts?.[0];
  if (!account) return { state: "none", email: null, message: "Aucun compte Gmail connecté.", messages: 0, last_sync_at: null, started_at: null, can_modify: false };
  const base = { email: account.email as string, messages: 0, last_sync_at: null as string | null, started_at: null as string | null, can_modify: canModifyBox((account.scopes as string[]) ?? []) };
  if (account.status !== "connected") return { ...base, state: "error", message: "Google a retiré l'accès à ce compte. Reconnectez Gmail ci-dessous : la synchronisation reprendra où elle s'est arrêtée." };

  const { data: sync } = await sb.from("mailbox_sync").select("backfill_started_at, backfill_done_at, last_sync_at, error_code, last_error").eq("account_id", account.id).maybeSingle();
  const { count } = await sb.from("mailbox_messages").select("message_id", { count: "exact", head: true }).eq("account_id", account.id);
  const seen = { ...base, messages: count ?? 0, last_sync_at: (sync?.last_sync_at as string | null) ?? null, started_at: (sync?.backfill_started_at as string | null) ?? null };
  if (!sync) return { ...seen, state: "pending", message: "La première synchronisation n'a pas encore commencé." };
  if (sync.last_error) return { ...seen, state: "error", message: sync.last_error as string };
  if (!sync.backfill_done_at) return { ...seen, state: "initial", message: "Première lecture de la boîte en cours, des messages les plus récents aux plus anciens." };
  return { ...seen, state: "ready", message: "La boîte est à jour." };
}

// ---------------------------------------------------------------------------
// Lecture (lot M02)
// ---------------------------------------------------------------------------
async function currentAccountId(sb: SupabaseClient): Promise<string | null> {
  const { data } = await sb.from("mail_accounts").select("id, is_default, connected_at").neq("status", "disconnected")
    .order("is_default", { ascending: false }).order("connected_at", { ascending: false }).limit(1);
  return (data?.[0]?.id as string | undefined) ?? null;
}

export async function listFolders(sb: SupabaseClient): Promise<BoxFolder[]> {
  const account = await currentAccountId(sb);
  if (!account) return [];
  const { data, error } = await sb.from("mailbox_labels").select("label_id, name, kind, threads_total, threads_unread, messages_total, hidden").eq("account_id", account);
  if (error) throw new CrmError(`Lecture des dossiers impossible : ${error.message}`);
  return (data ?? []).filter((l) => !l.hidden || l.kind === "system").map((l) => ({
    id: l.label_id as string,
    name: l.name as string,
    kind: l.kind as "system" | "user",
    unread: l.threads_unread as number,
    // brouillons : Gmail les compte par message
    total: l.label_id === "DRAFT" ? (l.messages_total as number) : (l.threads_total as number),
  }));
}

const PAGE_SIZE = 50;
const cursorSchema = z.object({ at: z.iso.datetime({ offset: true }), id: z.string().max(200) });

/** Une page de fils d'un dossier, lue dans l'index. `cursor` : celui renvoyé par la page précédente. */
export async function listThreads(sb: SupabaseClient, label: string, cursor: string | null): Promise<BoxThreadPage> {
  if (!/^[A-Za-z0-9_\-]{1,200}$/.test(label)) throw new CrmError("Dossier inconnu.");
  let before: z.infer<typeof cursorSchema> | null = null;
  if (cursor) {
    try {
      before = cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    } catch {
      throw new CrmError("Page introuvable. Rechargez la liste.");
    }
  }
  const { data, error } = await sb.rpc("mailbox_list_threads", { p_label: label, p_before: before?.at ?? null, p_before_id: before?.id ?? null, p_limit: PAGE_SIZE });
  if (error) throw new CrmError(`Lecture des messages impossible : ${error.message}`);
  const threads = (data ?? []) as BoxThread[];
  const last = threads.at(-1);
  return { threads, next: threads.length === PAGE_SIZE && last ? Buffer.from(JSON.stringify({ at: last.last_at, id: last.thread_id })).toString("base64url") : null };
}

/** Accès Gmail pour une action du propriétaire (déjà vérifié par l'appelant) : jeton côté serveur uniquement. */
export async function ownerAccess(sb: SupabaseClient): Promise<{ account: { id: string; scopes: string[]; email: string; display_name: string | null; signature: string }; token: string }> {
  if (!(await ensureServerKey(sb))) throw new CrmError("Le module Mail demande la variable serveur APPOINTMENTS_SECRET (voir docs/mail-configuration.md).");
  let access: Awaited<ReturnType<typeof gmailAccess>>;
  try {
    access = await gmailAccess(publicClient());
  } catch {
    throw new CrmError("Google a refusé l'accès à la boîte. Reconnectez Gmail depuis l'onglet « Compte et envois ».");
  }
  if ("skipped" in access) throw new CrmError(`${access.skipped}.`);
  const a = access.account;
  return { account: { id: a.id, scopes: a.scopes, email: a.email, display_name: a.display_name, signature: a.signature }, token: access.token };
}
const ownerToken = async (sb: SupabaseClient) => (await ownerAccess(sb)).token;

/** Appel Gmail : une erreur classée devient un message affichable, jamais la réponse brute de Google. */
export async function gmail<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GmailBoxError) throw new CrmError(e.message);
    throw e;
  }
}

const summarize = (messages: FullMessage[]): BoxThread => {
  const labels = [...new Set(messages.flatMap((m) => m.label_ids))].sort();
  const last = messages.at(-1)!;
  return {
    thread_id: last.thread_id,
    last_at: last.internal_at,
    subject: messages[0].subject,
    snippet: last.snippet,
    participants: [...new Set(messages.map((m) => m.from_name || m.from_email).filter((x): x is string => !!x))],
    message_count: messages.length,
    label_ids: labels,
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    important: labels.includes("IMPORTANT"),
    has_attachments: messages.some((m) => m.has_attachments),
  };
};

/**
 * Recherche avec la syntaxe Gmail. Gmail donne les fils, dans son ordre ; l'index fournit leur résumé. Un fil
 * pas encore indexé (première lecture en cours) est résumé à la volée, sans être stocké.
 */
export async function searchThreads(sb: SupabaseClient, q: string, page: string | null): Promise<BoxThreadPage> {
  const query = q.trim();
  if (!query || query.length > 500) throw new CrmError("Recherche vide ou trop longue.");
  const token = await ownerToken(sb);
  const found = await gmail(() => searchThreadIds(token, query, page));
  if (!found.ids.length) return { threads: [], next: null };
  const { data, error } = await sb.from("mailbox_threads")
    .select("thread_id, last_at, subject, snippet, participants, message_count, label_ids, unread, starred, important, has_attachments").in("thread_id", found.ids);
  if (error) throw new CrmError(`Lecture des messages impossible : ${error.message}`);
  const known = new Map((data ?? []).map((t) => [t.thread_id as string, t as BoxThread]));
  const missing = found.ids.filter((id) => !known.has(id));
  const fetched = await gmail(() => pooled(missing, 5, (id) => getThread(token, id)));
  fetched.forEach((m) => { if (m?.length) known.set(m[0].thread_id, summarize(m)); });
  return { threads: found.ids.map((id) => known.get(id)).filter((t): t is BoxThread => !!t), next: found.next };
}

// HTML d'un email reçu : affiché dans un cadre isolé sans script (voir l'interface). Ce nettoyage retire en plus
// scripts, formulaires, cadres et gestionnaires d'événements, et masque les images distantes (pixels de suivi)
// tant que l'utilisateur ne les demande pas.
export function cleanEmailHtml(html: string, images: boolean): { html: string; remote: boolean } {
  let remote = false;
  const out = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "style", "center", "font"]),
    nonTextTags: ["script", "textarea", "option", "noscript", "title"],
    allowVulnerableTags: true, // <style> : sans danger dans un cadre sans script, les chargements distants sont bloqués par sa politique de contenu
    allowedAttributes: {
      "*": ["style", "class", "id", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing", "colspan", "rowspan", "dir", "lang", "title"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "width", "height"],
      font: ["face", "size", "color"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["https", "data"] },
    transformTags: {
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" } }),
      img: (tagName, attribs) => {
        if (/^https:/i.test(attribs.src ?? "")) {
          remote = true;
          if (!images) return { tagName, attribs: { alt: attribs.alt ?? "", width: attribs.width ?? "", height: attribs.height ?? "" } };
        }
        return { tagName, attribs };
      },
    },
  });
  return { html: out, remote };
}
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Fil ouvert : lu dans Gmail à la demande, jamais stocké. */
export async function openThread(sb: SupabaseClient, threadId: string, images: boolean): Promise<BoxOpenThread> {
  if (!/^[A-Za-z0-9_\-]{1,200}$/.test(threadId)) throw new CrmError("Fil introuvable.");
  const token = await ownerToken(sb);
  const messages = await gmail(() => getThread(token, threadId));
  if (!messages?.length) throw new CrmError("Ce fil n'existe plus dans Gmail.");
  return {
    thread_id: threadId,
    subject: messages[0].subject,
    messages: messages.map((m) => {
      const body = m.html ? cleanEmailHtml(m.html, images) : { html: `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(m.text ?? m.snippet)}</pre>`, remote: false };
      return {
        id: m.id, from_name: m.from_name, from_email: m.from_email, to: m.to_full ?? "", cc: m.cc_full ?? "", at: m.internal_at,
        subject: m.subject, rfc_message_id: m.rfc_message_id, references: m.references,
        reply_to: parseAddresses(m.reply_to).map((a) => a.email), to_list: m.to, cc_list: m.cc,
        label_ids: m.label_ids, html: body.html, remote_images: body.remote,
        attachments: m.attachments.map((a) => ({ name: a.name, mime_type: a.mime_type, size: a.size })),
      };
    }),
  };
}

/**
 * Contenu d'une pièce jointe, désignée par sa position dans le message : les identifiants de pièce jointe de Gmail
 * changent d'une lecture à l'autre. Le nom vient de Gmail, pas de l'appelant.
 */
export async function readAttachment(sb: SupabaseClient, threadId: string, messageId: string, index: number): Promise<{ name: string; data: Buffer }> {
  if (![threadId, messageId].every((x) => /^[A-Za-z0-9_\-]{1,200}$/.test(x)) || !Number.isInteger(index) || index < 0 || index > 200) throw new CrmError("Pièce jointe introuvable.");
  const token = await ownerToken(sb);
  const messages = await gmail(() => getThread(token, threadId));
  const meta = messages?.find((m) => m.id === messageId)?.attachments[index];
  if (!meta) throw new CrmError("Pièce jointe introuvable.");
  return { name: meta.name, data: await gmail(() => getAttachment(token, messageId, meta.id)) };
}

// ---------------------------------------------------------------------------
// Tri (lot M03) : chaque action est faite dans Gmail d'abord ; l'index reprend ensuite l'état que Gmail a renvoyé.
// ---------------------------------------------------------------------------
const ID = /^[A-Za-z0-9_\-]{1,200}$/;
const actionSchema = z.object({
  action: z.enum(BOX_ACTIONS),
  thread_ids: z.array(z.string().regex(ID)).min(1).max(50, "50 fils au plus par action"),
  label_id: z.string().regex(ID).optional(),
  from_label: z.string().regex(ID).optional(),
});
const MOVABLE = (id: string | undefined) => !!id && (id === "INBOX" || !/^[A-Z_]+$/.test(id)); // boîte de réception ou libellé personnel

/**
 * Toutes les actions sont des états à atteindre (« marquer lu », jamais « inverser ») : les rejouer, sur un double
 * clic ou un nouvel essai, ne change rien de plus.
 */
export async function runBoxAction(sb: SupabaseClient, input: unknown): Promise<BoxActionResult> {
  const p = actionSchema.parse(input);
  const { account, token } = await ownerAccess(sb);
  if (!canModifyBox(account.scopes)) throw new CrmError("Le tri n'est pas encore autorisé. Reconnectez Gmail depuis l'onglet « Compte et envois » en acceptant toutes les autorisations.");

  const needsLabel = p.action === "label" || p.action === "unlabel" || p.action === "move";
  if (needsLabel) {
    if (!p.label_id) throw new CrmError("Choisissez un libellé.");
    if (p.action === "move" ? !MOVABLE(p.label_id) : /^[A-Z_]+$/.test(p.label_id)) throw new CrmError("Ce dossier ne peut pas être choisi ici.");
    if (p.label_id !== "INBOX") {
      const { data } = await sb.from("mailbox_labels").select("label_id").eq("account_id", account.id).eq("label_id", p.label_id).eq("kind", "user").maybeSingle();
      if (!data) throw new CrmError("Libellé introuvable. Synchronisez la boîte puis réessayez.");
    }
  }

  const one = async (id: string): Promise<ThreadLabels> => {
    const label = p.label_id!;
    switch (p.action) {
      case "archive": return modifyThread(token, id, [], ["INBOX"]);
      case "trash": return trashThread(token, id);
      case "untrash": await trashThread(token, id, true); return modifyThread(token, id, ["INBOX"], []);
      case "read": return modifyThread(token, id, [], ["UNREAD"]);
      case "unread": return modifyThread(token, id, ["UNREAD"], []);
      case "star": return modifyThread(token, id, ["STARRED"], []);
      case "unstar": return modifyThread(token, id, [], ["STARRED"]);
      case "important": return modifyThread(token, id, ["IMPORTANT"], []);
      case "unimportant": return modifyThread(token, id, [], ["IMPORTANT"]);
      case "spam": return modifyThread(token, id, ["SPAM"], ["INBOX"]);
      case "unspam": return modifyThread(token, id, ["INBOX"], ["SPAM"]);
      case "label": return modifyThread(token, id, [label], []);
      case "unlabel": return modifyThread(token, id, [], [label]);
      case "move": {
        if (p.from_label === "TRASH") await trashThread(token, id, true);
        // quitter le dossier d'origine : la boîte de réception par défaut, un libellé personnel ou le spam sinon
        const leave = p.from_label === "SPAM" ? ["SPAM"] : MOVABLE(p.from_label) ? [p.from_label!] : label === "INBOX" ? [] : ["INBOX"];
        return modifyThread(token, id, [label], leave.filter((l) => l !== label));
      }
    }
  };

  const done: string[] = [];
  const failed: string[] = [];
  const labels: ThreadLabels = [];
  let fatal: GmailBoxError | null = null;
  await pooled(p.thread_ids, 5, async (id) => {
    if (fatal) return;
    try {
      labels.push(...(await one(id)));
      done.push(id);
    } catch (e) {
      if (!(e instanceof GmailBoxError)) throw e;
      if (e.code === "not_found") failed.push(id); // le fil n'existe plus dans Gmail : la synchronisation le retirera
      else fatal = e; // accès, autorisation, quota, réseau : inutile d'insister sur les fils suivants
    }
  });
  // ce que Gmail a accepté est reflété tout de suite, même si la suite a échoué
  if (labels.length) await serverRpc(publicClient(), "mailbox_set_labels", { p_server_key: serverRpcKey(), p_account: account.id, p_messages: labels });
  if (fatal) throw new CrmError((fatal as GmailBoxError).message);
  return { done, failed };
}
