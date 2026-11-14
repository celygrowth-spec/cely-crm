import "server-only";
// Boîte de réception lemlist : lecture des conversations de chaque compte (liste et non-lus enregistrés au CRM) et
// lecture d'un fil chez lemlist à son ouverture (rien n'est stocké). Les comptes sont lus séparément : un compte en
// erreur ou limité en débit n'empêche jamais les autres de s'afficher.
import type { SupabaseClient } from "@supabase/supabase-js";
import sanitizeHtml from "sanitize-html";
import { z } from "zod";
import { CrmError } from "@/lib/crm/service";
import { htmlToText } from "@/lib/mail/render";
import { withLemlistAccount } from "./accounts";
import { getTeam, lemlistRequest } from "./client";
import type { InboxData, SyncResult, ThreadMessage, ThreadView } from "./types";

/** Pages lues par membre de l'équipe à chaque actualisation (100 conversations par page, les plus récentes d'abord). */
const PAGES_PER_USER = 2;
const PAGE_SIZE = 100;
/** Une actualisation automatique ne relit pas un compte lu il y a moins de 60 s (limite : 20 requêtes / 2 s / clé). */
const MIN_INTERVAL_MS = 60_000;

type RawUser = { userId?: unknown; sender?: unknown; read?: unknown };
type RawConversation = {
  _id?: unknown; contactId?: unknown; channels?: unknown; lastActivityAt?: unknown; lastRepliedAt?: unknown; lastRepliedChannel?: unknown;
  haveReplies?: unknown; users?: unknown; contact?: { _id?: unknown; fullName?: unknown; firstName?: unknown; lastName?: unknown; email?: unknown } | null;
};
type RawPage = { data?: unknown; pagination?: { nextPage?: unknown } | null };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const date = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const CHANNELS = ["email", "linkedin"] as const;

export type ConversationRow = {
  lemlist_id: string; contact_id: string; contact_name: string | null; contact_email: string | null; channels: string[];
  last_channel: string | null; sender_user_id: string | null; last_activity_at: string; last_reply_at: string | null; has_replies: boolean; unread: boolean;
};

/** Conversation lemlist → ligne enregistrée. `null` si elle n'a ni email ni LinkedIn (WhatsApp, SMS : hors version). */
export function toConversationRow(c: RawConversation): ConversationRow | null {
  const id = str(c._id);
  const contactId = str(c.contactId) ?? str(c.contact?._id);
  const at = date(c.lastActivityAt);
  const channels = (Array.isArray(c.channels) ? c.channels : []).filter((x): x is (typeof CHANNELS)[number] => (CHANNELS as readonly unknown[]).includes(x));
  if (!id || !contactId || !at || !channels.length) return null;
  const users = (Array.isArray(c.users) ? c.users : []) as RawUser[];
  const senders = users.filter((u) => u.sender === true);
  const watchers = senders.length ? senders : users;
  const name = str(c.contact?.fullName) ?? ([str(c.contact?.firstName), str(c.contact?.lastName)].filter(Boolean).join(" ") || null);
  const last = str(c.lastRepliedChannel);
  return {
    lemlist_id: id,
    contact_id: contactId,
    contact_name: name,
    contact_email: str(c.contact?.email),
    channels,
    last_channel: last === "email" || last === "linkedin" ? last : null,
    sender_user_id: str(senders[0]?.userId) ?? str(users[0]?.userId),
    last_activity_at: at,
    last_reply_at: date(c.lastRepliedAt),
    has_replies: c.haveReplies === true,
    unread: watchers.some((u) => u.read === false),
  };
}

/** Conversations d'une équipe : lemlist les liste membre par membre ; une conversation suivie par deux membres n'apparaît qu'une fois. */
export async function fetchTeamConversations(apiKey: string): Promise<ConversationRow[]> {
  const team = await getTeam(apiKey);
  const byId = new Map<string, ConversationRow>();
  for (const userId of team.userIds) {
    for (let page = 1; page <= PAGES_PER_USER; page++) {
      const res = await lemlistRequest<RawPage>(apiKey, "/inbox", { query: { userId, page, limit: PAGE_SIZE } });
      const rows = (Array.isArray(res.data) ? res.data : []) as RawConversation[];
      for (const raw of rows) {
        const r = toConversationRow(raw);
        if (!r) continue;
        const prev = byId.get(r.lemlist_id);
        byId.set(r.lemlist_id, prev ? { ...r, unread: prev.unread || r.unread, sender_user_id: prev.sender_user_id ?? r.sender_user_id } : r);
      }
      if (!res.pagination?.nextPage || rows.length < PAGE_SIZE) break;
    }
  }
  return [...byId.values()];
}

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(error.code === "P0001" ? error.message : "Opération Messages impossible.");
  return data as T;
}

export const loadInbox = (sb: SupabaseClient) => rpc<InboxData>(sb, "lemlist_inbox", { p_limit: 500 });

/**
 * Actualise la liste de chaque compte connecté, en parallèle et indépendamment. `force` (bouton Actualiser) relit
 * même un compte lu à l'instant ; l'actualisation automatique respecte un intervalle minimal par compte.
 */
export async function syncInbox(sb: SupabaseClient, opts: { force?: boolean } = {}): Promise<SyncResult[]> {
  const { accounts } = await loadInbox(sb);
  const now = Date.now();
  return Promise.all(accounts.map(async (a): Promise<SyncResult> => {
    const base = { account_id: a.id, company_name: a.company_name };
    if (a.status !== "connected") return { ...base, ok: false, skipped: true, message: "Compte à reconnecter (Paramètres › Connecteurs)." };
    if (!opts.force && a.last_synced_at && now - Date.parse(a.last_synced_at) < MIN_INTERVAL_MS && !a.last_error) return { ...base, ok: true, skipped: true, message: null };
    try {
      const r = await withLemlistAccount(sb, a.id, fetchTeamConversations);
      if (!r.ok) return { ...base, ok: false, skipped: false, message: r.message };
      const n = await rpc<number>(sb, "lemlist_conversations_sync", { p_account: a.id, p_rows: r.data });
      return { ...base, ok: true, skipped: false, message: null, count: n };
    } catch (e) {
      return { ...base, ok: false, skipped: false, message: e instanceof CrmError ? e.message : "Lecture impossible pour ce compte." };
    }
  }));
}

// ---------------------------------------------------------------------------
// Fil d'une conversation : lu chez lemlist à l'ouverture, jamais enregistré
// ---------------------------------------------------------------------------

type RawMessage = {
  _id?: unknown; type?: unknown; createdAt?: unknown; subject?: unknown; message?: unknown; body?: unknown;
  sendUserId?: unknown; sendUserName?: unknown; sendUserEmail?: unknown; sendUserMailboxId?: unknown; fromEmail?: unknown; leadId?: unknown;
};

/** Texte lisible d'un message : citations des réponses précédentes, images et suivi retirés ; aucun HTML renvoyé au navigateur. */
export function messageText(content: string): string {
  if (!/<[a-z][\s\S]*>/i.test(content)) return content.trim();
  const clean = sanitizeHtml(content, {
    allowedTags: ["p", "br", "div", "span", "a", "ul", "ol", "li", "b", "strong", "i", "em"],
    allowedAttributes: { a: ["href"] },
    exclusiveFilter: (f) => f.tag === "blockquote" || /\bgmail_(quote|signature|extra)\b/.test(String(f.attribs?.class ?? "")),
    nonTextTags: ["style", "script", "textarea", "option", "noscript", "title", "head", "blockquote"],
  });
  return htmlToText(clean).trim();
}

/** Message lemlist → message affiché. Seuls les emails et messages LinkedIn échangés sont gardés (pas les ouvertures, clics…). */
export function toThreadMessage(m: RawMessage): ThreadMessage | null {
  const type = str(m.type) ?? "";
  const channel = type.startsWith("email") ? "email" : type.startsWith("linkedin") ? "linkedin" : null;
  const direction = /Replied$|Received$/.test(type) ? "in" : /Sent$/.test(type) ? "out" : null;
  const content = typeof m.message === "string" ? m.message : typeof m.body === "string" ? m.body : null;
  const id = str(m._id);
  const at = date(m.createdAt);
  if (!channel || !direction || content === null || !id || !at) return null;
  return {
    id, channel, direction, at,
    subject: channel === "email" ? str(m.subject) : null,
    text: messageText(content).slice(0, 50_000),
    sender_name: direction === "out" ? str(m.sendUserName) : null,
    sender_email: direction === "out" ? str(m.sendUserEmail) : str(m.fromEmail),
  };
}

type ConversationRef = {
  id: string; account_id: string; company_id: string; company_name: string; team_name: string; account_status: string; contact_id: string;
  contact_name: string | null; contact_email: string | null; channels: string[]; last_channel: string | null; sender_user_id: string | null;
};

/** Conversation retrouvée par le serveur à partir de son identifiant CRM (le compte n'est jamais pris du navigateur). */
export async function getConversation(sb: SupabaseClient, id: string): Promise<ConversationRef> {
  const c = await rpc<ConversationRef | null>(sb, "lemlist_conversation_get", { p_id: z.uuid().parse(id) });
  if (!c) throw new CrmError("Conversation introuvable.");
  return c;
}

/** Ouvre un fil : messages lus chez lemlist avec la clé du compte de la conversation, puis « vue » dans le CRM. */
export async function openThread(sb: SupabaseClient, id: string): Promise<ThreadView> {
  const c = await getConversation(sb, id);
  const head = { id: c.id, company_name: c.company_name, team_name: c.team_name, contact_name: c.contact_name, contact_email: c.contact_email, channels: c.channels };
  if (c.account_status !== "connected") return { ...head, ok: false, error: "Compte lemlist à reconnecter (Paramètres › Connecteurs) : le fil ne peut pas être lu.", messages: [] };
  const r = await withLemlistAccount(sb, c.account_id, async (key) => {
    const res = await lemlistRequest<{ data?: unknown }>(key, `/inbox/${encodeURIComponent(c.contact_id)}`, { query: { limit: 100 } });
    return ((Array.isArray(res.data) ? res.data : []) as RawMessage[]).map(toThreadMessage).filter((m): m is ThreadMessage => !!m).sort((a, b) => a.at.localeCompare(b.at));
  });
  if (!r.ok) return { ...head, ok: false, error: r.message, messages: [] };
  await rpc(sb, "lemlist_conversation_seen", { p_id: c.id });
  return { ...head, ok: true, error: null, messages: r.data };
}
