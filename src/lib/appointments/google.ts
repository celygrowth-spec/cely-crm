import "server-only";
// Client Google Calendar minimal (fetch, sans SDK). Périmètre volontairement réduit :
//   calendar.calendarlist.readonly : lister les agendas pour choisir ceux à vérifier et la destination ;
//   calendar.freebusy              : lire les plages occupées (jamais le contenu des événements) ;
//   calendar.events.owned          : créer, modifier, supprimer les événements des rendez-vous.
// Aucune portée Gmail : l'envoi d'emails relève du module Mail.
import { googleConfig } from "./config";
import type { GoogleCalendar, Interval } from "./types";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.freebusy",
  "https://www.googleapis.com/auth/calendar.events.owned",
];

const TIMEOUT_MS = 8000;
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleError extends Error {
  constructor(message: string, readonly status: number, readonly reauth = false) {
    super(message);
  }
}

async function call(url: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  try {
    return await fetch(url, { ...init, headers, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (e) {
    throw new GoogleError(`Google injoignable (${e instanceof Error ? e.name : "erreur réseau"})`, 0);
  }
}

async function fail(res: Response, what: string): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } | string; error_description?: string } | null;
  const detail = typeof body?.error === "string" ? `${body.error}${body.error_description ? ` : ${body.error_description}` : ""}` : body?.error?.message;
  const reauth = res.status === 401 || (typeof body?.error === "string" && body.error === "invalid_grant");
  throw new GoogleError(`${what} : ${detail ?? `HTTP ${res.status}`}`, res.status, reauth);
}

function config() {
  const c = googleConfig();
  if (!c) throw new GoogleError("Google Calendar n'est pas configuré (GOOGLE_CALENDAR_CLIENT_ID / GOOGLE_CALENDAR_CLIENT_SECRET)", 0);
  return c;
}

// ---------------------------------------------------------------------------
// OAuth (code + PKCE, accès hors ligne pour obtenir un jeton de rafraîchissement)
// ---------------------------------------------------------------------------

export function authorizationUrl(p: { redirectUri: string; state: string; codeChallenge: string }): string {
  const q = new URLSearchParams({
    client_id: config().clientId,
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
  });
  // pas d'include_granted_scopes : le jeton reste limité à l'agenda, même si le projet Google
  // Cloud est partagé avec la connexion Gmail du module Mail.
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

export async function exchangeCode(p: { code: string; redirectUri: string; codeVerifier: string }) {
  const { clientId, clientSecret } = config();
  const res = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: p.code, client_id: clientId, client_secret: clientSecret, redirect_uri: p.redirectUri,
      grant_type: "authorization_code", code_verifier: p.codeVerifier,
    }),
  });
  if (!res.ok) await fail(res, "Échange du code Google");
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  return j;
}

// Jetons d'accès gardés en mémoire du processus (jamais en base, jamais côté navigateur)
const accessCache = new Map<string, { token: string; exp: number }>();

export async function accessToken(refreshToken: string): Promise<string> {
  const cached = accessCache.get(refreshToken);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const { clientId, clientSecret } = config();
  const res = await call("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) await fail(res, "Rafraîchissement de l'accès Google");
  const j = (await res.json()) as { access_token: string; expires_in: number };
  accessCache.set(refreshToken, { token: j.access_token, exp: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

export async function revoke(token: string): Promise<void> {
  accessCache.delete(token);
  await call(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Agendas et disponibilités
// ---------------------------------------------------------------------------

export async function listCalendars(token: string): Promise<GoogleCalendar[]> {
  const res = await call(`${API}/users/me/calendarList?minAccessRole=freeBusyReader&maxResults=250`, { token });
  if (!res.ok) await fail(res, "Liste des agendas Google");
  const j = (await res.json()) as { items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole: string; backgroundColor?: string }[] };
  return (j.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summaryOverride ?? c.summary ?? c.id,
    primary: !!c.primary,
    accessRole: c.accessRole,
    backgroundColor: c.backgroundColor,
  }));
}

/** Occupations des agendas demandés. Toute erreur sur un agenda fait échouer l'ensemble : un agenda
 *  non vérifié n'est jamais considéré comme libre. */
export async function freeBusy(token: string, calendarIds: string[], from: string, to: string): Promise<Interval[]> {
  if (!calendarIds.length) return [];
  const res = await call(`${API}/freeBusy`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timeMin: from, timeMax: to, items: calendarIds.map((id) => ({ id })) }),
  });
  if (!res.ok) await fail(res, "Disponibilités Google");
  const j = (await res.json()) as { calendars?: Record<string, { busy?: Interval[]; errors?: { reason: string }[] }> };
  const out: Interval[] = [];
  for (const id of calendarIds) {
    const c = j.calendars?.[id];
    if (!c || c.errors?.length) throw new GoogleError(`Agenda « ${id} » illisible (${c?.errors?.[0]?.reason ?? "absent"})`, 200);
    out.push(...(c.busy ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Événements : identifiant déterministe dérivé du rendez-vous → une nouvelle tentative ne crée
// jamais de doublon (Google répond 409 si l'événement existe déjà).
// ---------------------------------------------------------------------------

export function eventIdFor(bookingId: string): string {
  return `rdv${bookingId.replace(/-/g, "")}`;
}

export type CalendarEventInput = {
  bookingId: string;
  calendarId: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  timeZone: string;
  location?: string | null;
  attendee?: { email: string; name: string } | null;
  createMeet?: boolean;
};

function eventBody(e: CalendarEventInput, withId: boolean) {
  return {
    ...(withId ? { id: eventIdFor(e.bookingId) } : {}),
    summary: e.summary,
    description: e.description,
    location: e.location ?? undefined,
    start: { dateTime: e.start, timeZone: e.timeZone },
    end: { dateTime: e.end, timeZone: e.timeZone },
    // invité affiché dans l'événement, sans notification de Google (sendUpdates=none)
    attendees: e.attendee ? [{ email: e.attendee.email, displayName: e.attendee.name }] : undefined,
    extendedProperties: { private: { celyBookingId: e.bookingId } },
    reminders: { useDefault: true },
    ...(e.createMeet
      ? { conferenceData: { createRequest: { requestId: e.bookingId, conferenceSolutionKey: { type: "hangoutsMeet" } } } }
      : {}),
  };
}

type GEvent = { id: string; status?: string; hangoutLink?: string };

/** Crée l'événement, ou le met à jour s'il existe déjà (reprise après échec partiel). */
export async function upsertEvent(token: string, e: CalendarEventInput): Promise<{ id: string; meetUrl: string | null }> {
  const cal = encodeURIComponent(e.calendarId);
  const res = await call(`${API}/calendars/${cal}/events?sendUpdates=none&conferenceDataVersion=1`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(eventBody(e, true)),
  });
  if (res.ok) {
    const j = (await res.json()) as GEvent;
    return { id: j.id, meetUrl: j.hangoutLink ?? null };
  }
  if (res.status !== 409) await fail(res, "Création de l'événement Google");
  return patchEvent(token, e);
}

export async function patchEvent(token: string, e: CalendarEventInput): Promise<{ id: string; meetUrl: string | null }> {
  const cal = encodeURIComponent(e.calendarId);
  const id = eventIdFor(e.bookingId);
  const body = eventBody({ ...e, createMeet: false }, false) as Record<string, unknown>;
  // un événement supprimé reste « cancelled » chez Google : on le rétablit explicitement
  body.status = "confirmed";
  const res = await call(`${API}/calendars/${cal}/events/${id}?sendUpdates=none&conferenceDataVersion=1`, {
    method: "PATCH",
    token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await fail(res, "Mise à jour de l'événement Google");
  const j = (await res.json()) as GEvent;
  return { id: j.id, meetUrl: j.hangoutLink ?? null };
}

/** Supprime l'événement ; absent ou déjà supprimé = succès. */
export async function deleteEvent(token: string, calendarId: string, bookingId: string): Promise<void> {
  const res = await call(`${API}/calendars/${encodeURIComponent(calendarId)}/events/${eventIdFor(bookingId)}?sendUpdates=none`, {
    method: "DELETE",
    token,
  });
  if (res.ok || res.status === 404 || res.status === 410) return;
  await fail(res, "Suppression de l'événement Google");
}

// ---------------------------------------------------------------------------
// Synchronisation incrémentale (events.list + syncToken) : lit les changements de l'agenda de destination
// pour repérer les événements de l'outil déplacés ou supprimés directement dans Google.
// Un 410 signifie que le jeton a expiré : la synchronisation complète doit être refaite.
// ---------------------------------------------------------------------------

export type ChangedEvent = { id: string; status: string; start?: string | null; end?: string | null; bookingId: string | null };

export async function listEventChanges(token: string, calendarId: string, syncToken: string | null, maxPages = 40): Promise<{ events: ChangedEvent[]; nextSyncToken: string }> {
  const events: ChangedEvent[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ maxResults: "250", showDeleted: "true" });
    if (syncToken) q.set("syncToken", syncToken);
    if (pageToken) q.set("pageToken", pageToken);
    const res = await call(`${API}/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`, { token });
    if (!res.ok) await fail(res, "Lecture des changements Google");
    const j = (await res.json()) as {
      items?: { id: string; status?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; extendedProperties?: { private?: Record<string, string> } }[];
      nextPageToken?: string; nextSyncToken?: string;
    };
    for (const e of j.items ?? []) {
      // seuls les événements créés par l'outil sont pris en compte (identifiant rdv<uuid>)
      const m = /^rdv([0-9a-f]{32})$/.exec(e.id);
      if (!m) continue;
      const h = m[1];
      events.push({
        id: e.id,
        status: e.status ?? "confirmed",
        start: e.start?.dateTime ?? null,
        end: e.end?.dateTime ?? null,
        bookingId: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
      });
    }
    if (j.nextPageToken) { pageToken = j.nextPageToken; continue; }
    if (j.nextSyncToken) return { events, nextSyncToken: j.nextSyncToken };
    break;
  }
  throw new GoogleError("Synchronisation Google interrompue (trop de pages) : elle reprendra au prochain passage", 0);
}
