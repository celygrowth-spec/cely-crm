import "server-only";
// Orchestration des réservations : base (source de vérité) + Google Calendar.
// La base et Google ne partagent pas de transaction : chaque opération suit un ordre qui ne
// confirme rien avant la réussite des étapes nécessaires, et toute divergence restante est
// rattrapée par reconcileCalendar (la base fait foi, Google est aligné sur elle).
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { appUrl, googleConfig } from "./config";
import * as google from "./google";
import { subtractIntervals } from "./intervals";
import { bookingRequestSchema, type BookingRequest } from "./schemas";
import { decryptSecret, manageRef, parseManageRef, serverRpcKey, tokenHashFor } from "./secrets";
import { formatRange, timeZoneLabel } from "./time";
import { LOCATION_LABELS, type EventSnapshot, type Interval, type PublicBooking, type PublicEvent } from "./types";

export class BookingError extends Error {
  constructor(message: string, readonly code: "invalid" | "unavailable" | "calendar" | "not_found" | "config" | "server" = "server") {
    super(message);
  }
}

export class CalendarUnavailable extends BookingError {
  constructor(detail: string) {
    super(`Les disponibilités ne peuvent pas être vérifiées pour le moment. Réessayez dans quelques minutes. (${detail})`, "calendar");
  }
}

type PgError = { message: string; code?: string };

/** Client Supabase sans session (rôle anon) : uniquement pour les fonctions publiques protégées par la clé serveur. */
export function publicClient(): SupabaseClient {
  return createClient(env.supabaseUrl, env.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function friendly(e: PgError): BookingError {
  if (e.code === "42501") return new BookingError(/Lien invalide/.test(e.message) ? "Ce lien n'est pas valide." : "Réservation momentanément indisponible.", "config");
  if (e.code === "22023") return new BookingError(e.message, "invalid");
  if (e.code === "P0002") return new BookingError(e.message, "not_found");
  if (/fetch failed|network/i.test(e.message)) return new BookingError("Service momentanément injoignable. Réessayez.", "server");
  console.error("[rendez-vous]", e);
  return new BookingError("Une erreur inattendue est survenue. Rien n'a été confirmé ; réessayez.", "server");
}

export async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw friendly(error);
  return data as T;
}

/** Identité de l'appelant pour les opérations sur un rendez-vous existant. */
export type Actor = { kind: "owner"; sb: SupabaseClient } | { kind: "invitee"; sb: SupabaseClient; tokenHash: string };

const authArgs = (a: Actor) =>
  a.kind === "owner" ? { p_server_key: null, p_token_hash: null } : { p_server_key: serverRpcKey(), p_token_hash: a.tokenHash };

// ---------------------------------------------------------------------------
// Google : jeton, occupations, événements
// ---------------------------------------------------------------------------

type GoogleCreds = { token: string; check: string[]; destination: string | null; email: string | null };

/** null : aucun agenda connecté. Lève CalendarUnavailable si une connexion existe mais ne répond pas. */
export async function googleCreds(sb: SupabaseClient): Promise<GoogleCreds | null> {
  const row = await rpc<{ refresh_token_enc: string; check_calendar_ids: string[]; destination_calendar_id: string | null; google_email: string | null } | null>(
    sb, "appt_server_google", { p_server_key: serverRpcKey() });
  if (!row) return null;
  if (!googleConfig()) throw new CalendarUnavailable("identifiants Google absents du serveur");
  try {
    const token = await google.accessToken(decryptSecret(row.refresh_token_enc));
    return { token, check: row.check_calendar_ids ?? [], destination: row.destination_calendar_id, email: row.google_email };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.rpc("appt_google_status", { p_server_key: serverRpcKey(), p_ok: false, p_error: msg });
    throw new CalendarUnavailable(e instanceof google.GoogleError && e.reauth ? "accès Google révoqué, reconnexion nécessaire" : msg);
  }
}

/** Occupations Google sur la période, sans nos propres rendez-vous (déjà comptés en base). */
export async function externalBusy(sb: SupabaseClient, creds: GoogleCreds | null, from: string, to: string): Promise<Interval[]> {
  if (!creds || creds.check.length === 0) return [];
  let busy: Interval[];
  try {
    busy = await google.freeBusy(creds.token, creds.check, from, to);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await sb.rpc("appt_google_status", { p_server_key: serverRpcKey(), p_ok: false, p_error: msg });
    throw new CalendarUnavailable(msg);
  }
  const own = await rpc<Interval[]>(sb, "appt_server_own_events", { p_server_key: serverRpcKey(), p_from: from, p_to: to });
  return subtractIntervals(busy, own ?? []);
}

type EventData = {
  id: string;
  starts_at: string;
  ends_at: string;
  event: EventSnapshot;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string | null;
  company_name?: string | null;
  meeting_url?: string | null;
  answers?: { label: string; value: string }[];
  schedule_timezone: string;
};

function calendarEvent(b: EventData, calendarId: string, origin?: string | null): google.CalendarEventInput {
  const lines = [
    `${b.first_name} ${b.last_name} · ${b.email}`,
    b.phone ? `Téléphone : ${b.phone}` : null,
    b.company_name ? `Entreprise : ${b.company_name}` : null,
    b.meeting_url ? `Réunion : ${b.meeting_url}` : null,
    b.event.location_detail ? `Lieu : ${b.event.location_detail}` : null,
    ...(b.answers ?? []).map((a) => `${a.label} : ${a.value}`),
    "",
    `Rendez-vous géré dans Cely CRM : ${appUrl(origin)}/rendez-vous/liste?rdv=${b.id}`,
  ].filter((l): l is string => l !== null);
  return {
    bookingId: b.id,
    calendarId,
    summary: `${b.event.name} — ${b.first_name} ${b.last_name}${b.company_name ? ` (${b.company_name})` : ""}`,
    description: lines.join("\n"),
    start: b.starts_at,
    end: b.ends_at,
    timeZone: b.schedule_timezone,
    location: b.meeting_url ?? (b.event.location_kind === "phone" ? `Téléphone : ${b.phone ?? ""}` : b.event.location_detail),
    attendee: { email: b.email, name: `${b.first_name} ${b.last_name}` },
    createMeet: !b.meeting_url && b.event.location_kind === "video" && !!b.event.google_meet,
  };
}

// ---------------------------------------------------------------------------
// Lecture publique
// ---------------------------------------------------------------------------

export async function getPublicEvent(slug: string): Promise<PublicEvent | null> {
  return rpc<PublicEvent | null>(publicClient(), "appt_public_event", { p_server_key: serverRpcKey(), p_slug: slug });
}

/** Créneaux libres (instants UTC). Si un agenda connecté ne répond pas : erreur, jamais « tout libre ». */
export async function getSlots(p: { slug: string; from: string; to: string; exclude?: string | null; sb?: SupabaseClient }): Promise<string[]> {
  const sb = p.sb ?? publicClient();
  const creds = await googleCreds(sb);
  const busy = await externalBusy(sb, creds, new Date(Date.parse(p.from) - 6 * 3600_000).toISOString(), new Date(Date.parse(p.to) + 6 * 3600_000).toISOString());
  const r = await rpc<string[] | null>(sb, "appt_public_slots", {
    p_server_key: serverRpcKey(), p_slug: p.slug, p_from: p.from, p_to: p.to, p_busy: busy, p_exclude_booking: p.exclude ?? null,
  });
  if (r === null) throw new BookingError("Ce rendez-vous n'est plus proposé.", "not_found");
  return r.map((s) => new Date(s).toISOString());
}

async function alternatives(slug: string, around: string, exclude?: string | null): Promise<string[]> {
  try {
    const from = new Date(Math.max(Date.now(), Date.parse(around) - 12 * 3600_000)).toISOString();
    const to = new Date(Date.parse(around) + 8 * 86400_000).toISOString();
    const all = await getSlots({ slug, from, to, exclude });
    return all.sort((a, b) => Math.abs(Date.parse(a) - Date.parse(around)) - Math.abs(Date.parse(b) - Date.parse(around))).slice(0, 6).sort();
  } catch {
    return [];
  }
}

export async function getPublicBooking(ref: string): Promise<(PublicBooking & { ref: string }) | null> {
  const parsed = parseManageRef(ref);
  if (!parsed) return null;
  try {
    const b = await rpc<PublicBooking>(publicClient(), "appt_public_booking", { p_server_key: serverRpcKey(), p_id: parsed.id, p_token_hash: parsed.tokenHash });
    return b ? { ...b, ref } : null;
  } catch (e) {
    if (e instanceof BookingError && e.code === "config" && /lien/i.test(e.message)) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Réservation publique
// ---------------------------------------------------------------------------

export type BookResult =
  | { status: "confirmed"; ref: string; booking: PublicBooking }
  | { status: "unavailable"; alternatives: string[] }
  | { status: "error"; message: string; retryable: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function bookPublic(input: BookingRequest, origin?: string | null): Promise<BookResult> {
  const parsed = bookingRequestSchema.safeParse(input);
  if (!parsed.success) return { status: "error", message: parsed.error.issues.map((i) => i.message).join(" · "), retryable: false };
  const req = parsed.data;
  const sb = publicClient();
  const key = serverRpcKey();

  const event = await getPublicEvent(req.slug);
  if (!event) return { status: "error", message: "Ce rendez-vous n'est plus proposé.", retryable: false };
  const start = new Date(req.starts_at).toISOString();
  const end = new Date(Date.parse(start) + event.duration_min * 60_000).toISOString();

  // 1. Vérification Google la plus récente possible (jamais « libre » par défaut)
  let creds: GoogleCreds | null;
  let busy: Interval[];
  try {
    creds = await googleCreds(sb);
    busy = await externalBusy(sb, creds, new Date(Date.parse(start) - 6 * 3600_000).toISOString(), new Date(Date.parse(end) + 6 * 3600_000).toISOString());
  } catch (e) {
    if (e instanceof BookingError) return { status: "error", message: e.message, retryable: true };
    throw e;
  }
  const calendarId = creds?.destination ?? null;

  // 2. Vérification finale et retenue du créneau en base (verrou + contrainte d'exclusion)
  const id = randomUUID();
  let res: { status: "pending" | "confirmed" | "unavailable" | "existing"; id?: string; booking_status?: string };
  try {
    res = await rpc(sb, "appt_book", {
      p_server_key: key, p_booking_id: id, p_slug: req.slug, p_starts_at: start, p_invitee: req.invitee, p_answers: req.answers,
      p_busy: busy, p_calendar_target: !!calendarId, p_token_hash: tokenHashFor(id), p_idempotency_key: req.idempotency_key, p_hold_minutes: 10,
    });
  } catch (e) {
    if (e instanceof BookingError) return { status: "error", message: e.message, retryable: e.code !== "invalid" };
    throw e;
  }
  if (res.status === "unavailable") return { status: "unavailable", alternatives: await alternatives(req.slug, start) };

  const bookingId = res.id ?? id;
  const ref = manageRef(bookingId);
  const tokenHash = tokenHashFor(bookingId);
  const read = () => rpc<PublicBooking>(sb, "appt_public_booking", { p_server_key: key, p_id: bookingId, p_token_hash: tokenHash });

  // Double envoi : on attend l'issue de la première requête plutôt que de recommencer
  if (res.status === "existing") {
    for (let i = 0; i < 12; i++) {
      const b = await read();
      if (b.status === "confirmed" || b.status === "cancelled") return { status: "confirmed", ref, booking: b };
      if (b.status !== "pending") return { status: "error", message: "La réservation n'a pas pu être finalisée. Choisissez à nouveau un créneau.", retryable: true };
      await sleep(700);
    }
    return { status: "error", message: "La réservation est encore en cours de confirmation. Patientez quelques secondes puis réessayez.", retryable: true };
  }

  if (res.status === "confirmed") return { status: "confirmed", ref, booking: await read() };

  // 3. Événement Google (nécessaire dès qu'un agenda de destination est choisi)
  try {
    const full = await bookingForSync(sb, bookingId);
    if (!full) throw new Error("Rendez-vous introuvable après retenue");
    const ev = await google.upsertEvent(creds!.token, calendarEvent(full, calendarId!, origin));
    const c = await rpc<{ status: string }>(sb, "appt_confirm_booking", {
      p_server_key: key, p_id: bookingId, p_calendar_id: calendarId, p_event_id: ev.id, p_meeting_url: ev.meetUrl,
    });
    if (c.status !== "confirmed") {
      // retenue expirée entre-temps : compensation (suppression de l'événement) puis échec propre
      await compensateDelete(sb, creds!.token, calendarId!, bookingId);
      return { status: "error", message: "Le délai de confirmation est dépassé. Choisissez à nouveau un créneau.", retryable: true };
    }
    // la page de confirmation lit ensuite le rendez-vous complet ; la fiche CRM est déjà rattachée
    reconcileSoon(sb, origin);
    return { status: "confirmed", ref, booking: await read() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await rpc(sb, "appt_abandon_booking", { p_server_key: key, p_id: bookingId, p_reason: msg }).catch(() => undefined);
    await compensateDelete(sb, creds!.token, calendarId!, bookingId);
    return {
      status: "error",
      message: "La réservation n'a pas pu être enregistrée dans l'agenda. Aucun rendez-vous n'a été confirmé ; vos informations sont conservées, réessayez.",
      retryable: true,
    };
  }
}

/** Supprime un événement peut-être créé (réponse perdue) ; à défaut, la reprise s'en chargera. */
async function compensateDelete(sb: SupabaseClient, token: string, calendarId: string, bookingId: string) {
  try {
    await google.deleteEvent(token, calendarId, bookingId);
    const b = await bookingForSync(sb, bookingId);
    if (b && b.status !== "pending" && b.status !== "confirmed") {
      await rpc(sb, "appt_mark_calendar", { p_id: bookingId, p_version: b.version, p_server_key: serverRpcKey() });
    }
  } catch {
    // la reprise (reconcileCalendar) supprimera l'événement : la base indique qu'il ne doit pas exister
  }
}

let reconciling = false;
function reconcileSoon(sb: SupabaseClient, origin?: string | null) {
  if (reconciling) return;
  reconciling = true;
  void reconcileCalendar(sb, origin, 5).finally(() => {
    reconciling = false;
  });
}

// ---------------------------------------------------------------------------
// Annulation et report (lien privé ou back-office)
// ---------------------------------------------------------------------------

export async function cancelBooking(actor: Actor, id: string, reason: string | null, origin?: string | null) {
  const r = await rpc<{ status: string; version?: number; already?: boolean }>(actor.sb, "appt_cancel", { p_id: id, p_reason: reason, ...authArgs(actor) });
  if (!r.already) await syncOne(actor.sb, id, origin);
  return r;
}

export type RescheduleResult =
  | { status: "rescheduled"; starts_at: string }
  | { status: "unavailable"; alternatives: string[] }
  | { status: "error"; message: string };

export async function rescheduleBooking(actor: Actor, id: string, slug: string, startsAt: string, origin?: string | null): Promise<RescheduleResult> {
  const start = new Date(startsAt).toISOString();
  const sb = actor.sb;
  let creds: GoogleCreds | null;
  let busy: Interval[];
  try {
    creds = await googleCreds(sb);
    busy = await externalBusy(sb, creds, new Date(Date.parse(start) - 6 * 3600_000).toISOString(), new Date(Date.parse(start) + 18 * 3600_000).toISOString());
  } catch (e) {
    if (e instanceof BookingError) return { status: "error", message: e.message };
    throw e;
  }
  // 1. nouveau créneau vérifié et retenu ; l'ancien reste occupé
  const held = await rpc<{ status: string; hold_id: string; version: number; old_starts_at: string; old_ends_at: string; starts_at: string; ends_at: string }>(
    sb, "appt_reschedule_begin", { p_id: id, p_starts_at: start, p_busy: busy, ...authArgs(actor) });
  if (held.status === "unavailable") return { status: "unavailable", alternatives: await alternatives(slug, start, id) };

  // 2. Google mis à jour (si l'événement existe) ; en cas d'échec, rien ne change
  const full = await bookingForSync(sb, id);
  let synced = false;
  if (full?.calendar_target && full.calendar_id) {
    if (!creds) {
      await rpc(sb, "appt_reschedule_abort", { p_id: id, p_hold_id: held.hold_id, p_reason: "Agenda Google déconnecté", ...authArgs(actor) });
      return { status: "error", message: "L'agenda Google n'est plus connecté : le report ne peut pas être répercuté. Le rendez-vous est inchangé." };
    }
    try {
      await google.upsertEvent(creds.token, calendarEvent({ ...full, starts_at: held.starts_at, ends_at: held.ends_at }, full.calendar_id, origin));
      synced = true;
    } catch (e) {
      await rpc(sb, "appt_reschedule_abort", { p_id: id, p_hold_id: held.hold_id, p_reason: e instanceof Error ? e.message : String(e), ...authArgs(actor) });
      return { status: "error", message: "L'agenda n'a pas pu être mis à jour. Le rendez-vous est conservé à son horaire initial ; réessayez." };
    }
  }

  // 3. bascule atomique en base
  const c = await rpc<{ status: string; starts_at?: string }>(sb, "appt_reschedule_commit", {
    p_id: id, p_hold_id: held.hold_id, p_calendar_synced: synced || !full?.calendar_target, ...authArgs(actor),
  });
  if (c.status !== "rescheduled") {
    // compensation : Google revient à l'ancien horaire ; sinon, reprise forcée
    if (synced && creds && full?.calendar_id) {
      try {
        await google.upsertEvent(creds.token, calendarEvent({ ...full, starts_at: held.old_starts_at, ends_at: held.old_ends_at }, full.calendar_id, origin));
      } catch (e) {
        await sb.rpc("appt_calendar_resync", { p_id: id, p_error: e instanceof Error ? e.message : String(e), p_server_key: serverRpcKey() });
      }
    }
    return { status: "error", message: "Le report n'a pas pu être finalisé. Le rendez-vous est conservé à son horaire initial ; réessayez." };
  }
  return { status: "rescheduled", starts_at: c.starts_at ?? start };
}

// ---------------------------------------------------------------------------
// Reprise Google : la base fait foi
// ---------------------------------------------------------------------------

type SyncRow = EventData & { status: string; version: number; calendar_id: string | null; calendar_target?: boolean; google_event_id: string | null };

async function bookingForSync(sb: SupabaseClient, id: string): Promise<(SyncRow & { calendar_target: boolean }) | null> {
  // passe par la fonction de reprise (clé serveur) pour fonctionner aussi depuis un lien privé
  const { data } = await sb.rpc("appt_server_booking", { p_server_key: serverRpcKey(), p_id: id });
  return (data as (SyncRow & { calendar_target: boolean }) | null) ?? null;
}

async function syncRow(sb: SupabaseClient, creds: GoogleCreds | null, b: SyncRow, origin?: string | null) {
  const calendarId = b.calendar_id ?? creds?.destination ?? null;
  try {
    if (!creds || !calendarId) throw new Error("Agenda Google non connecté");
    if (b.status === "confirmed") {
      const ev = await google.upsertEvent(creds.token, calendarEvent(b, calendarId, origin));
      await rpc(sb, "appt_mark_calendar", { p_id: b.id, p_version: b.version, p_event_id: ev.id, p_calendar_id: calendarId, p_server_key: serverRpcKey() });
    } else {
      await google.deleteEvent(creds.token, calendarId, b.id);
      await rpc(sb, "appt_mark_calendar", { p_id: b.id, p_version: b.version, p_server_key: serverRpcKey() });
    }
    return true;
  } catch (e) {
    await sb.rpc("appt_mark_calendar", { p_id: b.id, p_version: b.version, p_error: e instanceof Error ? e.message : String(e), p_server_key: serverRpcKey() });
    return false;
  }
}

async function syncOne(sb: SupabaseClient, id: string, origin?: string | null) {
  const b = await bookingForSync(sb, id);
  if (!b || !b.calendar_target) return;
  let creds: GoogleCreds | null = null;
  try {
    creds = await googleCreds(sb);
  } catch {
    creds = null;
  }
  await syncRow(sb, creds, b, origin);
}

export async function reconcileCalendar(sb: SupabaseClient, origin?: string | null, limit = 20): Promise<{ done: number; failed: number }> {
  const rows = await rpc<SyncRow[]>(sb, "appt_calendar_backlog", { p_server_key: serverRpcKey(), p_limit: limit });
  if (!rows?.length) return { done: 0, failed: 0 };
  let creds: GoogleCreds | null = null;
  try {
    creds = await googleCreds(sb);
  } catch {
    creds = null;
  }
  let done = 0;
  let failed = 0;
  for (const b of rows) {
    if (await syncRow(sb, creds, b, origin)) done++;
    else failed++;
  }
  return { done, failed };
}

// ---------------------------------------------------------------------------
// Textes partagés (confirmation, ICS)
// ---------------------------------------------------------------------------

export function locationText(b: { event: EventSnapshot; meeting_url: string | null }): string {
  if (b.meeting_url) return b.meeting_url;
  if (b.event.location_kind === "phone") return "Par téléphone, au numéro indiqué";
  return b.event.location_detail ?? LOCATION_LABELS[b.event.location_kind];
}

export function summaryText(b: PublicBooking): string {
  return `${b.event.name} — ${formatRange(b.starts_at, b.ends_at, b.invitee_timezone)} (${timeZoneLabel(b.invitee_timezone, new Date(b.starts_at))})`;
}
