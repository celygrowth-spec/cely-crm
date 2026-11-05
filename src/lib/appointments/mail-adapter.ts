import "server-only";
// Adaptateur Rendez-vous → module Mail. Point de raccordement unique, à appeler par le module Mail
// (son worker ou sa file d'envoi). Ce module ne contient AUCUN envoi, AUCUNE file et AUCUN fournisseur :
// il expose des rappels prêts à être mis en file par le module Mail, et reçoit le résultat de l'envoi.
// Contrat : docs/integrations/appointments-mail.md
import type { SupabaseClient } from "@supabase/supabase-js";
import { appUrl } from "./config";
import { buildVariables, renderTemplate } from "./reminders";
import { manageRef, serverRpcKey } from "./secrets";
import { publicClient, rpc } from "./server";
import type { EventSnapshot } from "./types";

/** Rappel prêt à être mis en file par le module Mail. */
export type ReminderMessage = {
  /** identifiant de cette échéance (une ligne d'échéancier) */
  reminderId: string;
  /** identifiant stable du rappel, conservé lors d'un report */
  reminderKey: string;
  /** à utiliser comme clé d'unicité dans la file Mail : jamais deux envois pour la même clé */
  dedupKey: string;
  /** à repasser à isReminderStillValid / markReminder : refusé si le rappel a été modifié entre-temps */
  revision: number;
  bookingId: string;
  bookingVersion: number;
  sendAt: string;
  /** au-delà, ne plus envoyer (rendez-vous commencé) */
  validUntil: string;
  to: { email: string; name: string };
  subject: string;
  text: string;
  variables: Record<string, string>;
  crm: { companyId: string | null; personId: string | null };
};

type DueRow = {
  reminder_id: string; reminder_key: string; dedup_key: string; revision: number; send_at: string; subject: string; body: string;
  booking_id: string; booking_version: number; starts_at: string; ends_at: string; invitee_timezone: string;
  first_name: string; last_name: string; email: string; company_name: string | null; meeting_url: string | null;
  event: EventSnapshot; company_id: string | null; person_id: string | null;
};

export function manageLinks(bookingId: string, origin?: string | null) {
  const base = `${appUrl(origin)}/rdv/gerer/${manageRef(bookingId)}`;
  return { cancel: `${base}?action=annuler`, reschedule: `${base}?action=reporter` };
}

export function renderReminder(row: DueRow, origin?: string | null): ReminderMessage {
  const vars = buildVariables({ ...row, event: row.event }, manageLinks(row.booking_id, origin));
  return {
    reminderId: row.reminder_id,
    reminderKey: row.reminder_key,
    dedupKey: row.dedup_key,
    revision: row.revision,
    bookingId: row.booking_id,
    bookingVersion: row.booking_version,
    sendAt: row.send_at,
    validUntil: row.starts_at,
    to: { email: row.email, name: `${row.first_name} ${row.last_name}` },
    subject: renderTemplate(row.subject, vars).text,
    text: renderTemplate(row.body, vars).text,
    variables: vars,
    crm: { companyId: row.company_id, personId: row.person_id },
  };
}

const client = (sb?: SupabaseClient) => sb ?? publicClient();

/** Rappels échus à mettre en file (vide tant que l'envoi n'est pas raccordé, ou en suspension globale). */
export async function dueReminders(opts: { sb?: SupabaseClient; limit?: number; graceMinutes?: number; origin?: string | null } = {}): Promise<ReminderMessage[]> {
  const rows = await rpc<DueRow[]>(client(opts.sb), "appt_mail_due_reminders", {
    p_server_key: serverRpcKey(), p_limit: opts.limit ?? 50, p_grace_minutes: opts.graceMinutes ?? 15,
  });
  return (rows ?? []).map((r) => renderReminder(r, opts.origin));
}

/** À appeler juste avant l'envoi effectif. */
export async function isReminderStillValid(reminderId: string, revision: number, sb?: SupabaseClient): Promise<boolean> {
  return rpc<boolean>(client(sb), "appt_mail_reminder_valid", { p_reminder: reminderId, p_revision: revision, p_server_key: serverRpcKey() });
}

/** Résultat réel de l'envoi (jamais appelé par le module Rendez-vous lui-même). */
export async function markReminder(
  reminderId: string, revision: number, result: { status: "sent"; messageId?: string } | { status: "failed"; error: string }, sb?: SupabaseClient,
): Promise<boolean> {
  return rpc<boolean>(client(sb), "appt_mail_mark_reminder", {
    p_reminder: reminderId, p_revision: revision, p_status: result.status,
    p_message_id: result.status === "sent" ? (result.messageId ?? null) : null,
    p_error: result.status === "failed" ? result.error : null,
    p_server_key: serverRpcKey(),
  });
}

/** Déclare l'envoi opérationnel. Les échéances antérieures ne seront jamais envoyées. */
export async function connectMailDelivery(sb?: SupabaseClient): Promise<string> {
  return rpc<string>(client(sb), "appt_mail_connect", { p_server_key: serverRpcKey() });
}

export type AppointmentMailEvent = {
  event_id: number; kind: "confirmed" | "rescheduled" | "cancelled"; actor: string; created_at: string; data: Record<string, unknown>;
  booking_id: string; booking_version: number; status: string; starts_at: string; email: string; company_id: string | null; person_id: string | null;
};

/** Réservations, reports et annulations, à lire par curseur (event_id croissant). */
export async function bookingEventsSince(afterEventId: number, limit = 100, sb?: SupabaseClient): Promise<AppointmentMailEvent[]> {
  return rpc<AppointmentMailEvent[]>(client(sb), "appt_mail_events", { p_after: afterEventId, p_limit: limit, p_server_key: serverRpcKey() });
}
