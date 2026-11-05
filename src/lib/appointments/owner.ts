import "server-only";
// Lectures du back-office Rendez-vous (session du propriétaire, sous RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { appointmentsSecretOrNull } from "./config";
import { serverRpcKeyHash } from "./secrets";
import type { Reminder, ReminderRule } from "./reminders";
import type { Block, Booking, BookingEvent, EventType, GoogleConnection, Schedule } from "./types";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}

/**
 * Enregistre l'empreinte de la clé serveur si besoin (première visite, ou secret changé).
 * Renvoie false si APPOINTMENTS_SECRET manque : la page publique reste alors fermée.
 */
export async function ensureServerKey(sb: SupabaseClient): Promise<boolean> {
  if (!appointmentsSecretOrNull()) return false;
  const hash = serverRpcKeyHash();
  const { data } = await sb.rpc("appt_server_key_registered", { p_hash: hash });
  if (data === true) return true;
  const { error } = await sb.rpc("appt_register_server_key", { p_hash: hash });
  return !error;
}

export const BOOKING_COLUMNS = "*";

export async function listEventTypes(sb: SupabaseClient): Promise<EventType[]> {
  return check(await sb.from("appt_event_types").select("*").order("position").order("created_at")) as EventType[];
}

export async function getEventType(sb: SupabaseClient, id: string): Promise<EventType | null> {
  return check(await sb.from("appt_event_types").select("*").eq("id", id).maybeSingle()) as EventType | null;
}

export async function listSchedules(sb: SupabaseClient): Promise<Schedule[]> {
  const [s, r, o] = await Promise.all([
    sb.from("appt_schedules").select("id, name, timezone, is_default").order("is_default", { ascending: false }).order("name"),
    sb.from("appt_schedule_rules").select("schedule_id, weekday, start_time, end_time").order("weekday").order("start_time"),
    sb.from("appt_schedule_overrides").select("schedule_id, on_date, start_time, end_time").order("on_date").order("start_time"),
  ]);
  const schedules = check(s) as Omit<Schedule, "rules" | "overrides">[];
  const rules = check(r) as { schedule_id: string; weekday: number; start_time: string; end_time: string }[];
  const overrides = check(o) as { schedule_id: string; on_date: string; start_time: string | null; end_time: string | null }[];
  const hm = (t: string | null) => (t ? t.slice(0, 5) : null);
  return schedules.map((x) => ({
    ...x,
    rules: rules.filter((y) => y.schedule_id === x.id).map((y) => ({ weekday: y.weekday, start: hm(y.start_time)!, end: hm(y.end_time)! })),
    overrides: overrides.filter((y) => y.schedule_id === x.id).map((y) => ({ date: y.on_date, start: hm(y.start_time), end: hm(y.end_time) })),
  }));
}

export async function listBlocks(sb: SupabaseClient): Promise<Block[]> {
  return check(await sb.from("appt_blocks").select("id, label, starts_at, ends_at, all_day").gte("ends_at", new Date().toISOString()).order("starts_at")) as Block[];
}

export type BookingFilters = { q?: string; status?: string; type?: string; from?: string; to?: string; crm?: string };

export async function listBookings(sb: SupabaseClient, f: BookingFilters = {}, limit = 300): Promise<Booking[]> {
  let q = sb.from("appt_booking_overview").select("*");
  if (f.from) q = q.gte("starts_at", f.from);
  if (f.to) q = q.lt("starts_at", f.to);
  if (f.type) q = q.eq("event_type_id", f.type);
  if (f.status) q = q.eq("display_status", f.status);
  if (f.crm === "to_link") q = q.eq("crm_status", "to_link").eq("status", "confirmed");
  if (f.q) {
    const term = f.q.replace(/[%,()]/g, " ").trim();
    if (term) q = q.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,email.ilike.%${term}%,company_name.ilike.%${term}%,crm_company_name.ilike.%${term}%`);
  }
  const asc = !f.status || f.status === "a_venir";
  return check(await q.order("starts_at", { ascending: asc }).limit(limit)) as Booking[];
}

export type BookingDetail = {
  booking: Booking;
  events: BookingEvent[];
  reminders: Reminder[];
  remindersOff: boolean;
  reminderSettings: ReminderSettings;
};

export async function getBooking(sb: SupabaseClient, id: string): Promise<BookingDetail | null> {
  const [b, e, r, off, s] = await Promise.all([
    sb.from("appt_booking_overview").select("*").eq("id", id).maybeSingle(),
    sb.from("appt_booking_events").select("id, kind, actor, data, created_at").eq("booking_id", id).order("id"),
    sb.from("appt_reminders").select("*").eq("booking_id", id).order("send_at").order("created_at"),
    sb.from("appt_bookings").select("reminders_off").eq("id", id).maybeSingle(),
    getReminderSettings(sb),
  ]);
  const booking = check(b) as Booking | null;
  if (!booking) return null;
  return {
    booking,
    events: check(e) as BookingEvent[],
    reminders: check(r) as Reminder[],
    remindersOff: !!(check(off) as { reminders_off: boolean } | null)?.reminders_off,
    reminderSettings: s,
  };
}

export type ReminderSettings = { paused: boolean; mailConnectedAt: string | null };

export async function getReminderSettings(sb: SupabaseClient): Promise<ReminderSettings> {
  const row = check(await sb.from("appt_settings").select("reminders_paused, mail_connected_at").maybeSingle()) as
    | { reminders_paused: boolean; mail_connected_at: string | null }
    | null;
  return { paused: !!row?.reminders_paused, mailConnectedAt: row?.mail_connected_at ?? null };
}

export async function listReminderRules(sb: SupabaseClient, typeId: string): Promise<ReminderRule[]> {
  return check(
    await sb.from("appt_reminder_rules").select("id, enabled, offset_value, offset_unit, subject, body").eq("event_type_id", typeId).order("position"),
  ) as ReminderRule[];
}

export async function companyBookings(sb: SupabaseClient, companyId: string): Promise<Booking[]> {
  return check(await sb.from("appt_booking_overview").select("*").eq("company_id", companyId).order("starts_at", { ascending: false }).limit(50)) as Booking[];
}

export async function getGoogleConnection(sb: SupabaseClient): Promise<GoogleConnection | null> {
  return check(
    await sb
      .from("appt_google_connection")
      .select("google_email, scopes, calendars, check_calendar_ids, destination_calendar_id, status, last_error, connected_at")
      .maybeSingle(),
  ) as GoogleConnection | null;
}

export async function getSettings(sb: SupabaseClient): Promise<{ display_name: string; intro: string | null }> {
  return (check(await sb.from("appt_settings").select("display_name, intro").maybeSingle()) as { display_name: string; intro: string | null } | null) ?? {
    display_name: "Cely Growth",
    intro: null,
  };
}

export type Overview = {
  next: Booking | null;
  today: Booking[];
  week: Booking[];
  toLink: Booking[];
  toQualify: Booking[];
  outOfSync: Booking[];
};

export async function overview(sb: SupabaseClient, todayStart: string, tomorrowStart: string, weekEnd: string): Promise<Overview> {
  const now = new Date().toISOString();
  const [upcoming, toLink, toQualify, outOfSync] = await Promise.all([
    sb.from("appt_booking_overview").select("*").eq("status", "confirmed").gte("ends_at", todayStart).lt("starts_at", weekEnd).order("starts_at").limit(200),
    sb.from("appt_booking_overview").select("*").eq("crm_status", "to_link").in("status", ["confirmed"]).order("starts_at").limit(50),
    sb.from("appt_booking_overview").select("*").eq("display_status", "a_renseigner").order("starts_at", { ascending: false }).limit(50),
    sb.from("appt_booking_overview").select("*").eq("calendar_out_of_sync", true).order("updated_at").limit(20),
  ]);
  const list = check(upcoming) as Booking[];
  const nextRes = check(await sb.from("appt_booking_overview").select("*").eq("status", "confirmed").gte("starts_at", now).order("starts_at").limit(1)) as Booking[];
  return {
    next: nextRes[0] ?? null,
    today: list.filter((b) => b.starts_at < tomorrowStart && b.ends_at >= todayStart),
    week: list.filter((b) => b.starts_at >= tomorrowStart),
    toLink: check(toLink) as Booking[],
    toQualify: check(toQualify) as Booking[],
    outOfSync: check(outOfSync) as Booking[],
  };
}
