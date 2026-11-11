import "server-only";
// Lecture Gmail (Q03) : liste bornée, historique incrémental, message complet. Seules adresses Google de lecture.
import type { GmailMessage } from "./inbound";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailReadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function get<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new GmailReadError(`Lecture Gmail impossible (${res.status})`, res.status);
  return (await res.json()) as T;
}

export async function profileHistoryId(token: string): Promise<string> {
  return (await get<{ historyId: string }>(token, "/profile")).historyId;
}

/** Synchronisation initiale bornée : messages reçus récents (hors envoyés et discussions), au plus `max`. */
export async function listRecent(token: string, days: number, max: number): Promise<string[]> {
  const q = encodeURIComponent(`newer_than:${days}d -in:sent -in:chats -in:drafts`);
  const out: string[] = [];
  let page: string | undefined;
  do {
    const r = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `/messages?q=${q}&maxResults=${Math.min(100, max - out.length)}${page ? `&pageToken=${page}` : ""}`);
    out.push(...(r.messages ?? []).map((m) => m.id));
    page = r.nextPageToken;
  } while (page && out.length < max);
  return out;
}

/** Messages ajoutés depuis `startHistoryId`. 404 : historique expiré (reprise bornée à faire). */
export async function listSince(token: string, startHistoryId: string, max = 300): Promise<{ ids: string[]; historyId: string }> {
  const ids = new Set<string>();
  let page: string | undefined;
  let last = startHistoryId;
  do {
    const r = await get<{ history?: { messagesAdded?: { message: { id: string; labelIds?: string[] } }[] }[]; historyId: string; nextPageToken?: string }>(
      token, `/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&maxResults=100${page ? `&pageToken=${page}` : ""}`);
    for (const h of r.history ?? []) for (const a of h.messagesAdded ?? []) if (!(a.message.labelIds ?? []).some((l) => l === "SENT" || l === "DRAFT" || l === "CHAT")) ids.add(a.message.id);
    last = r.historyId ?? last;
    page = r.nextPageToken;
  } while (page && ids.size < max);
  return { ids: [...ids], historyId: last };
}

export async function getMessage(token: string, id: string): Promise<GmailMessage> {
  return get<GmailMessage>(token, `/messages/${encodeURIComponent(id)}?format=full`);
}
