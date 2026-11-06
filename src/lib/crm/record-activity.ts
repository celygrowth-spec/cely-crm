// Fil d'activité de la fiche : réunit les échanges, les appels Fireflies, les emails, les rendez-vous et les tâches
// en une seule liste. Aucune dépendance au navigateur : mêmes règles pour l'Aperçu et l'onglet Activité.
import type { Booking } from "@/lib/appointments/types";
import { shortDescription } from "@/lib/fireflies/transcript-view";
import type { Call } from "@/lib/fireflies/types";
import type { MailMessage } from "@/lib/mail/types";
import type { ClaudeLogEntry, Interaction, Task } from "./types";

export type ActivityType = "note" | "email" | "call" | "meeting" | "task";
export type ActivityFilter = "all" | ActivityType;

export const ACTIVITY_FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "Tout" },
  { key: "note", label: "Notes" },
  { key: "email", label: "Emails" },
  { key: "call", label: "Appels" },
  { key: "meeting", label: "Rendez-vous" },
  { key: "task", label: "Tâches" },
];

export type ActivityEntry = {
  key: string;
  type: ActivityType;
  at: string | null;
  title: string;
  preview: string | null;
  personId: string | null;
  interaction?: Interaction;
  call?: Call;
  booking?: Booking;
  mail?: MailMessage;
  task?: Task;
};

const EXCHANGE_KINDS: Partial<Record<Interaction["kind"], ActivityType>> = {
  note: "note",
  message_out: "email",
  message_in: "email",
  call: "call",
  meeting: "meeting",
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

const metaText = (i: Interaction, key: string) => {
  const v = i.meta?.[key];
  return typeof v === "string" && v ? v : null;
};

/** Le lien fiable posé en base par l'import Fireflies, jamais déduit d'un titre ou d'une heure proche. */
export const linkedCallId = (i: Interaction) => metaText(i, "fireflies_call_id");

function mailPreview(text: string | null) {
  return text ? text.replace(/^Objet : .*\n+/, "") : null;
}
function mailSubject(text: string | null) {
  return text?.match(/^Objet : (.*)/)?.[1] ?? null;
}
const MESSAGE_TITLES: Partial<Record<Interaction["kind"], string>> = { message_out: "Message envoyé", message_in: "Message reçu" };

function fromInteraction(i: Interaction, type: ActivityType, call?: Call, booking?: Booking, mail?: MailMessage): ActivityEntry {
  const base = { key: i.id, type, at: i.occurred_at, personId: i.person_id ?? call?.person_id ?? null, interaction: i, call, booking, mail };
  if (call) return { ...base, title: call.title, preview: shortDescription(call.summary) ?? (call.summary_state === "pending" ? "Résumé en attente." : "Pas de résumé. Ouvrir la transcription.") };
  if (type === "email") {
    const isMail = i.channel === "email" || !!metaText(i, "mail_id");
    const label = i.kind === "message_in" ? "Reçu" : "Envoyé";
    const subject = mail?.subject || mailSubject(i.content);
    return { ...base, title: isMail ? `Email · ${subject ?? label.toLowerCase()}` : MESSAGE_TITLES[i.kind] ?? label, preview: mailPreview(i.content) };
  }
  if (type === "note") return { ...base, title: "Note interne", preview: i.content };
  if (type === "meeting") return { ...base, title: booking?.event_snapshot.name ?? "Rendez-vous", preview: i.content };
  return { ...base, title: "Appel", preview: i.content };
}

/**
 * Une entrée par fait réel :
 * - un compte rendu Fireflies relié à une activité (meta.fireflies_call_id) se fond dans cette activité ;
 * - un compte rendu sans activité reliée garde sa propre entrée, et deux appels distincts restent distincts ;
 * - un email envoyé (meta.mail_id) et un rendez-vous (meta.appointment_id) suivent le même principe.
 */
export function buildActivity(src: { interactions: Interaction[]; calls?: Call[]; mails?: MailMessage[]; bookings?: Booking[]; tasks?: Task[] }): ActivityEntry[] {
  const calls = new Map((src.calls ?? []).map((c) => [c.id, c]));
  const mails = new Map((src.mails ?? []).map((m) => [m.id, m]));
  const bookings = new Map((src.bookings ?? []).map((b) => [b.id, b]));
  const usedCalls = new Set<string>();
  const usedMails = new Set<string>();
  const usedBookings = new Set<string>();
  const out: ActivityEntry[] = [];

  for (const i of src.interactions) {
    const type = EXCHANGE_KINDS[i.kind];
    if (!type) continue;
    const callId = linkedCallId(i);
    const call = callId ? calls.get(callId) : undefined;
    if (callId) usedCalls.add(callId);
    const mailId = metaText(i, "mail_id");
    const mail = mailId ? mails.get(mailId) : undefined;
    if (mailId) usedMails.add(mailId);
    const bookingId = metaText(i, "appointment_id");
    const booking = bookingId ? bookings.get(bookingId) : undefined;
    if (bookingId) usedBookings.add(bookingId);
    out.push(fromInteraction(i, type, call, booking, mail));
  }
  for (const c of src.calls ?? []) {
    if (usedCalls.has(c.id)) continue;
    out.push({ key: `call-${c.id}`, type: "call", at: c.occurred_at, title: c.title, preview: shortDescription(c.summary), personId: c.person_id, call: c });
  }
  // brouillons, échecs, résultats incertains : pas encore dans l'historique, mais à traiter depuis la fiche
  for (const m of src.mails ?? []) {
    if (usedMails.has(m.id)) continue;
    out.push({ key: `mail-${m.id}`, type: "email", at: m.sent_at ?? m.updated_at, title: `Email · ${m.subject || "(sans objet)"}`, preview: m.body_text || null, personId: m.person_id, mail: m });
  }
  for (const b of src.bookings ?? []) {
    if (usedBookings.has(b.id)) continue;
    out.push({ key: `booking-${b.id}`, type: "meeting", at: b.starts_at, title: b.event_snapshot.name, preview: null, personId: b.person_id, booking: b });
  }
  // les tâches à faire restent groupées en tête de l'onglet : seules les terminées prennent place dans le fil
  for (const t of src.tasks ?? []) {
    if (t.done_at) out.push({ key: `task-${t.id}`, type: "task", at: t.done_at, title: t.title, preview: null, personId: t.person_id, task: t });
  }
  return out.sort((a, b) => ms(b.at) - ms(a.at));
}

export function matchesFilter(e: ActivityEntry, f: ActivityFilter) {
  if (f === "all") return true;
  // un rendez-vous enregistré par Fireflies reste un appel à relire : il apparaît sous les deux filtres
  if (f === "call") return e.type === "call" || !!e.call;
  return e.type === f;
}

export const openTasks = (tasks: Task[]) =>
  tasks.filter((t) => !t.done_at).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.created_at.localeCompare(b.created_at));

const MAIL_NOT_SENT: MailMessage["status"][] = ["draft", "cancelled", "failed", "pending", "sending", "uncertain"];

/** Ce qui s'est réellement passé : ni rendez-vous à venir ou annulé, ni email non parti. */
export function isPastExchange(e: ActivityEntry, now = Date.now()) {
  if (e.type === "task" || !e.at || ms(e.at) > now) return false;
  if (e.booking && !e.interaction && (e.booking.display_status === "cancelled" || e.booking.display_status === "no_show" || e.booking.display_status === "pending")) return false;
  if (e.mail && !e.interaction && MAIL_NOT_SENT.includes(e.mail.status)) return false;
  return true;
}

export const recentExchanges = (entries: ActivityEntry[], max = 3, now = Date.now()) => entries.filter((e) => isPastExchange(e, now)).slice(0, max);

export function nextBooking(bookings: Booking[], now = Date.now()): Booking | null {
  return (
    bookings
      .filter((b) => ms(b.starts_at) > now && (b.display_status === "a_venir" || b.display_status === "pending"))
      .sort((a, b) => ms(a.starts_at) - ms(b.starts_at))[0] ?? null
  );
}

export const emailThread = (mail: MailMessage, mails: MailMessage[]) =>
  (mail.provider_thread_id ? mails.filter((m) => m.provider_thread_id === mail.provider_thread_id) : [mail]).sort((a, b) => ms(a.sent_at ?? a.updated_at) - ms(b.sent_at ?? b.updated_at));

export type JournalEntry = { key: string; at: string; interaction?: Interaction; log?: ClaudeLogEntry };

/** Changements de champs et traces système : consultables, mais hors du fil principal. */
export function buildJournal(interactions: Interaction[], claudeLog: ClaudeLogEntry[]): JournalEntry[] {
  return [
    ...interactions.filter((i) => !EXCHANGE_KINDS[i.kind]).map((i) => ({ key: i.id, at: i.occurred_at, interaction: i })),
    ...claudeLog.filter((l) => l.table_name !== "interactions").map((l) => ({ key: `log-${l.id}`, at: l.created_at, log: l })),
  ].sort((a, b) => ms(b.at) - ms(a.at));
}
