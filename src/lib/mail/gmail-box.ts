import "server-only";
// Lecture de toute la boîte Gmail (lot M01) : libellés, liste complète, historique des changements, métadonnées
// d'un message. Aucun corps de message n'est demandé ici : seul l'index est synchronisé.
import type { GmailPart } from "./inbound";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export type BoxErrorCode = "auth" | "scope" | "quota" | "expired" | "not_found" | "network";

/** Erreur classée : le message est celui affiché à l'utilisateur, jamais la réponse brute de Google. */
export class GmailBoxError extends Error {
  constructor(readonly code: BoxErrorCode, message: string, readonly status = 0) {
    super(message);
  }
}

const MESSAGES: Record<BoxErrorCode, string> = {
  auth: "Google a refusé l'accès à la boîte. Reconnectez Gmail depuis la page Mail.",
  scope: "La lecture de la boîte n'est pas autorisée. Reconnectez Gmail en acceptant toutes les autorisations demandées.",
  quota: "Gmail limite temporairement les lectures. La synchronisation reprendra seule au prochain passage.",
  expired: "L'historique Gmail a expiré : la boîte est relue en entier.",
  not_found: "Élément introuvable dans Gmail.",
  network: "Gmail est injoignable pour le moment. La synchronisation reprendra seule au prochain passage.",
};

async function get<T>(token: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new GmailBoxError("network", MESSAGES.network);
  }
  if (res.ok) return (await res.json()) as T;
  // le détail de la réponse n'est jamais journalisé ni renvoyé : seul le motif sert à classer l'erreur
  const body = (await res.json().catch(() => null)) as { error?: { errors?: { reason?: string }[]; status?: string } } | null;
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? "";
  const code: BoxErrorCode =
    res.status === 401 ? "auth"
    : res.status === 404 ? "not_found"
    : res.status === 429 || /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reason) ? "quota"
    : res.status === 403 ? "scope"
    : "network";
  throw new GmailBoxError(code, MESSAGES[code], res.status);
}

/** Exécute `fn` sur chaque élément avec au plus `limit` appels en parallèle (quota Gmail par utilisateur). */
export async function pooled<A, B>(items: A[], limit: number, fn: (a: A) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

export async function profileHistoryId(token: string): Promise<string> {
  return (await get<{ historyId: string }>(token, "/profile")).historyId;
}

// ---------------------------------------------------------------------------
// Libellés (dossiers système, catégories, libellés personnels) avec leurs compteurs
// ---------------------------------------------------------------------------
export type BoxLabel = {
  id: string; name: string; kind: "system" | "user";
  messages_total: number; messages_unread: number; threads_total: number; threads_unread: number;
  hidden: boolean; color_bg: string | null; color_text: string | null;
};
type RawLabel = {
  id: string; name?: string; type?: string; labelListVisibility?: string;
  messagesTotal?: number; messagesUnread?: number; threadsTotal?: number; threadsUnread?: number;
  color?: { backgroundColor?: string; textColor?: string };
};

export async function listLabels(token: string): Promise<BoxLabel[]> {
  const { labels = [] } = await get<{ labels?: RawLabel[] }>(token, "/labels");
  // la liste ne donne pas les compteurs : un appel par libellé (léger), un libellé supprimé entre-temps est ignoré
  const full = await pooled(labels, 8, (l) => get<RawLabel>(token, `/labels/${encodeURIComponent(l.id)}`).catch((e) => {
    if (e instanceof GmailBoxError && e.code === "not_found") return null;
    throw e;
  }));
  return full.filter((l): l is RawLabel => !!l).map((l) => ({
    id: l.id,
    name: l.name ?? l.id,
    kind: l.type === "system" ? "system" : "user",
    messages_total: l.messagesTotal ?? 0,
    messages_unread: l.messagesUnread ?? 0,
    threads_total: l.threadsTotal ?? 0,
    threads_unread: l.threadsUnread ?? 0,
    hidden: l.labelListVisibility === "labelHide",
    color_bg: l.color?.backgroundColor ?? null,
    color_text: l.color?.textColor ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------
/** Une page de la boîte entière, du plus récent au plus ancien, Spam et Corbeille compris. */
export async function listMessageIds(token: string, pageToken: string | null, max = 100): Promise<{ ids: string[]; next: string | null }> {
  const r = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(
    token, `/messages?includeSpamTrash=true&maxResults=${max}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
  return { ids: (r.messages ?? []).map((m) => m.id), next: r.nextPageToken ?? null };
}

export type BoxMessage = {
  id: string; thread_id: string; internal_at: string;
  from_name: string | null; from_email: string | null; to: string[]; cc: string[];
  subject: string; snippet: string; label_ids: string[];
  has_attachments: boolean; size_estimate: number | null; rfc_message_id: string | null;
};
type RawMessage = { id: string; threadId?: string; labelIds?: string[]; snippet?: string; internalDate?: string; sizeEstimate?: number; payload?: GmailPart };

// Réponse réduite : en-têtes et structure des pièces jointes, jamais le contenu (ni corps, ni fichiers).
const PART = "filename,mimeType";
const FIELDS = encodeURIComponent(`id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload(headers,${PART},parts(${PART},parts(${PART},parts(${PART},parts(${PART})))))`);

const header = (p: GmailPart | undefined, name: string) => p?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
const hasFile = (p: GmailPart | undefined): boolean => !!p && (!!p.filename || (p.parts ?? []).some(hasFile));
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** « "Dupont, Claire" <claire@x.fr>, b@y.fr » → [{name, email}], la virgule entre guillemets ne sépare pas. */
export function parseAddresses(v: string | null): { name: string | null; email: string }[] {
  if (!v) return [];
  return v.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).flatMap((raw) => {
    const m = raw.match(/^(.*)<([^>]+)>\s*$/);
    const email = (m ? m[2] : raw).trim().toLowerCase();
    if (!ADDRESS.test(email)) return [];
    const name = m ? m[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim() : "";
    return [{ name: name || null, email }];
  });
}

// Gmail renvoie les extraits avec des entités HTML.
const unescape = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function toBoxMessage(m: RawMessage): BoxMessage {
  const from = parseAddresses(header(m.payload, "from"))[0] ?? null;
  const ms = Number(m.internalDate);
  return {
    id: m.id,
    thread_id: m.threadId ?? m.id,
    internal_at: new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString(),
    from_name: from?.name ?? null,
    from_email: from?.email ?? null,
    to: parseAddresses(header(m.payload, "to")).map((a) => a.email).slice(0, 50),
    cc: parseAddresses(header(m.payload, "cc")).map((a) => a.email).slice(0, 50),
    subject: header(m.payload, "subject") ?? "",
    snippet: unescape(m.snippet ?? ""),
    label_ids: m.labelIds ?? [],
    has_attachments: (m.payload?.parts ?? []).some(hasFile),
    size_estimate: m.sizeEstimate ?? null,
    rfc_message_id: header(m.payload, "message-id"),
  };
}

/** `null` : le message n'existe plus dans Gmail (supprimé définitivement). */
export async function getBoxMessage(token: string, id: string): Promise<BoxMessage | null> {
  try {
    return toBoxMessage(await get<RawMessage>(token, `/messages/${encodeURIComponent(id)}?format=full&fields=${FIELDS}`));
  } catch (e) {
    if (e instanceof GmailBoxError && e.code === "not_found") return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Historique : tout ce qui a changé depuis un repère (arrivées, suppressions, libellés, lu / non lu…)
// ---------------------------------------------------------------------------
type HistoryRef = { message: { id: string } };
type HistoryRecord = { id: string; messagesAdded?: HistoryRef[]; messagesDeleted?: HistoryRef[]; labelsAdded?: HistoryRef[]; labelsRemoved?: HistoryRef[] };

/**
 * Une page de changements après `startHistoryId`. `complete` faux : il en reste, et `historyId` est le dernier
 * enregistrement lu (l'appel suivant repart de là, donc chaque page fait avancer le repère). Repère trop ancien :
 * erreur « expired ».
 */
export async function listChanges(token: string, startHistoryId: string, max = 100): Promise<{ changed: string[]; deleted: string[]; historyId: string; complete: boolean }> {
  let r: { history?: HistoryRecord[]; historyId?: string; nextPageToken?: string };
  try {
    r = await get(token, `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&maxResults=${max}`);
  } catch (e) {
    if (e instanceof GmailBoxError && e.code === "not_found") throw new GmailBoxError("expired", MESSAGES.expired, 404);
    throw e;
  }
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let last = startHistoryId;
  for (const h of r.history ?? []) {
    for (const x of [...(h.messagesAdded ?? []), ...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) changed.add(x.message.id);
    for (const x of h.messagesDeleted ?? []) deleted.add(x.message.id);
    last = h.id;
  }
  // l'état final l'emporte : un message supprimé n'est pas relu ; un message « changé » est relu tel qu'il est maintenant
  for (const id of deleted) changed.delete(id);
  const complete = !r.nextPageToken;
  return { changed: [...changed], deleted: [...deleted], historyId: complete ? (r.historyId ?? last) : last, complete };
}

// ---------------------------------------------------------------------------
// Lecture à la demande (lot M02) : recherche Gmail, fil complet, pièce jointe. Rien de ceci n'est stocké.
// ---------------------------------------------------------------------------
/** Recherche avec la syntaxe Gmail (`from:`, `has:attachment`, `in:spam`…) : Gmail répond, le CRM n'interprète rien. */
export async function searchThreadIds(token: string, q: string, pageToken: string | null, max = 30): Promise<{ ids: string[]; next: string | null }> {
  const r = await get<{ threads?: { id: string }[]; nextPageToken?: string }>(
    token, `/threads?q=${encodeURIComponent(q)}&maxResults=${max}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`);
  return { ids: (r.threads ?? []).map((t) => t.id), next: r.nextPageToken ?? null };
}

export type FullAttachment = { id: string; name: string; mime_type: string; size: number };
export type FullMessage = BoxMessage & { to_full: string | null; cc_full: string | null; html: string | null; text: string | null; attachments: FullAttachment[] };

const decode = (d?: string) => (d ? Buffer.from(d, "base64url").toString("utf8") : "");
function flatten(p: GmailPart | undefined, out: GmailPart[] = []): GmailPart[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) flatten(c, out);
  return out;
}

export function toFullMessage(m: RawMessage): FullMessage {
  const parts = flatten(m.payload);
  const html = parts.find((x) => x.mimeType === "text/html" && !x.filename && x.body?.data);
  const text = parts.find((x) => x.mimeType === "text/plain" && !x.filename && x.body?.data);
  return {
    ...toBoxMessage(m),
    to_full: header(m.payload, "to"),
    cc_full: header(m.payload, "cc"),
    html: html ? decode(html.body?.data) : null,
    text: text ? decode(text.body?.data) : null,
    attachments: parts.filter((x) => x.filename && x.body?.attachmentId)
      .map((x) => ({ id: x.body!.attachmentId!, name: x.filename!.slice(0, 255), mime_type: x.mimeType ?? "application/octet-stream", size: x.body?.size ?? 0 })),
  };
}

/** Fil complet, du plus ancien au plus récent. `null` : le fil n'existe plus dans Gmail. */
export async function getThread(token: string, id: string): Promise<FullMessage[] | null> {
  try {
    const r = await get<{ messages?: RawMessage[] }>(token, `/threads/${encodeURIComponent(id)}?format=full`);
    return (r.messages ?? []).map(toFullMessage);
  } catch (e) {
    if (e instanceof GmailBoxError && e.code === "not_found") return null;
    throw e;
  }
}

export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const r = await get<{ data?: string }>(token, `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
  return Buffer.from(r.data ?? "", "base64url");
}
