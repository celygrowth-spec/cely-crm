"use server";

// Server actions du back-office Rendez-vous : validation zod, puis tables (configuration, sous RLS)
// ou fonctions SQL (réservations, rattachement, qualification). Les opérations qui touchent
// Google Calendar passent par l'orchestration commune (src/lib/appointments/server.ts).
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";
import { z } from "zod";
import { run } from "@/lib/action";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { appUrl } from "@/lib/appointments/config";
import * as google from "@/lib/appointments/google";
import { blockSchema, eventTypeSchema, scheduleSchema, settingsSchema, slugify, type BlockInput, type EventTypeInput, type ScheduleInput } from "@/lib/appointments/schemas";
import { decryptSecret, manageRef, serverRpcKey } from "@/lib/appointments/secrets";
import { BookingError, cancelBooking, googleCreds, reconcileCalendar, rescheduleBooking, type RescheduleResult } from "@/lib/appointments/server";

function v<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}
const idv = (id: string) => v(z.uuid("Identifiant invalide"), id);

async function rpc<T = unknown>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}
async function q<T = unknown>(res: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<T> {
  const { data, error } = await res;
  if (error) {
    if (error.code === "23505") throw new CrmError("Ce lien est déjà utilisé par un autre type de rendez-vous.");
    throw new CrmError(friendlyError(error));
  }
  return data;
}
/** Erreurs de l'orchestration → message lisible (jamais présentées comme un succès). */
async function orchestrate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BookingError) throw new CrmError(e.message);
    throw e;
  }
}
async function origin() {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return appUrl(host ? `${proto}://${host}` : null);
}

// Types de rendez-vous ---------------------------------------------------------

export async function saveEventTypeAction(id: string | null, input: EventTypeInput) {
  return run(async (sb) => {
    const data = v(eventTypeSchema, input);
    if (id) {
      await q(sb.from("appt_event_types").update(data).eq("id", idv(id)));
      return { id };
    }
    const row = await q(sb.from("appt_event_types").insert(data).select("id").single());
    return row as { id: string };
  });
}

export async function duplicateEventTypeAction(id: string) {
  return run(async (sb) => {
    const src = (await q(sb.from("appt_event_types").select("*").eq("id", idv(id)).single())) as Record<string, unknown>;
    const base = slugify(`${src.slug as string}-copie`);
    let slug = base;
    for (let i = 2; i < 50; i++) {
      const { data } = await sb.from("appt_event_types").select("id").eq("slug", slug).maybeSingle();
      if (!data) break;
      slug = `${base}-${i}`;
    }
    const copy: Record<string, unknown> = { ...src, slug, name: `${src.name as string} (copie)`, active: false };
    for (const k of ["id", "created_at", "updated_at"]) delete copy[k];
    return (await q(sb.from("appt_event_types").insert(copy).select("id").single())) as { id: string };
  });
}

export async function setEventTypeActiveAction(id: string, active: boolean) {
  return run(async (sb) => {
    await q(sb.from("appt_event_types").update({ active }).eq("id", idv(id)));
  });
}

export async function deleteEventTypeAction(id: string) {
  return run(async (sb) => {
    const { count } = await sb.from("appt_bookings").select("id", { count: "exact", head: true }).eq("event_type_id", idv(id));
    if (count) throw new CrmError("Ce type a déjà des rendez-vous : désactivez-le plutôt (l'historique est conservé).");
    await q(sb.from("appt_event_types").delete().eq("id", id));
  });
}

// Disponibilités ---------------------------------------------------------------

export async function saveScheduleAction(id: string | null, input: ScheduleInput) {
  return run(async (sb) => {
    const data = v(scheduleSchema, input);
    return { id: await rpc<string>(sb, "appt_save_schedule", { p_id: id ? idv(id) : null, p_data: data }) };
  });
}

export async function deleteScheduleAction(id: string) {
  return run(async (sb) => {
    const { count } = await sb.from("appt_event_types").select("id", { count: "exact", head: true }).eq("schedule_id", idv(id));
    if (count) throw new CrmError("Ce planning est utilisé par un type de rendez-vous : changez d'abord le planning de ce type.");
    const s = (await q(sb.from("appt_schedules").select("is_default").eq("id", id).single())) as { is_default: boolean };
    if (s.is_default) throw new CrmError("Le planning par défaut ne peut pas être supprimé.");
    await q(sb.from("appt_schedules").delete().eq("id", id));
  });
}

export async function saveBlockAction(id: string | null, input: BlockInput) {
  return run(async (sb) => {
    const b = v(blockSchema, input);
    return {
      id: await rpc<string>(sb, "appt_save_block", {
        p_id: id ? idv(id) : null, p_label: b.label, p_start_date: b.start_date, p_end_date: b.end_date,
        p_start_time: b.start_time, p_end_time: b.end_time, p_timezone: b.timezone,
      }),
    };
  });
}

export async function deleteBlockAction(id: string) {
  return run(async (sb) => {
    await q(sb.from("appt_blocks").delete().eq("id", idv(id)));
  });
}

export async function saveSettingsAction(input: { display_name: string; intro: string | null }) {
  return run(async (sb) => {
    await q(sb.from("appt_settings").update(v(settingsSchema, input)).eq("id", true));
  });
}

// Rendez-vous --------------------------------------------------------------------

export async function setOutcomeAction(id: string, outcome: "done" | "no_show" | null) {
  return run(async (sb) => {
    await rpc(sb, "appt_set_outcome", { p_id: idv(id), p_outcome: outcome });
  });
}

export async function setNoteAction(id: string, note: string) {
  return run(async (sb) => {
    await rpc(sb, "appt_set_note", { p_id: idv(id), p_note: v(z.string().max(5000, "5 000 caractères maximum"), note) });
  });
}

export async function cancelBookingAction(id: string, reason: string | null) {
  // la suppression de l'événement Google est tentée aussitôt ; sinon la reprise s'en charge
  return run(async (sb) => orchestrate(async () => cancelBooking({ kind: "owner", sb }, idv(id), reason?.trim().slice(0, 1000) || null, await origin())));
}

export async function rescheduleBookingAction(id: string, startsAt: string): Promise<{ ok: true; data: RescheduleResult } | { ok: false; error: string }> {
  return run(async (sb) => {
    const { data } = await sb.from("appt_bookings").select("event_type_id").eq("id", idv(id)).single();
    const type = data ? ((await q(sb.from("appt_event_types").select("slug, active").eq("id", data.event_type_id).single())) as { slug: string; active: boolean }) : null;
    if (!type) throw new CrmError("Rendez-vous introuvable");
    if (!type.active) throw new CrmError("Ce type de rendez-vous est désactivé : réactivez-le pour proposer de nouveaux créneaux.");
    return orchestrate(async () => rescheduleBooking({ kind: "owner", sb }, id, type.slug, v(z.iso.datetime({ offset: true }), startsAt), await origin()));
  });
}

/** Lien privé du rendez-vous (à transmettre au contact ; sert aussi au choix d'un nouveau créneau). */
export async function manageLinkAction(id: string) {
  return run(async (sb) => {
    const { data } = await sb.from("appt_bookings").select("id").eq("id", idv(id)).maybeSingle();
    if (!data) throw new CrmError("Rendez-vous introuvable");
    const ref = manageRef(id);
    return { ref, url: `${await origin()}/rdv/gerer/${ref}` };
  });
}

export async function linkBookingAction(id: string, companyId: string, personId: string | null) {
  return run(async (sb) => rpc(sb, "appt_link_booking", { p_id: idv(id), p_company: idv(companyId), p_person: personId ? idv(personId) : null, p_add_person: true }));
}

/** Nouvelle fiche à partir d'un rendez-vous « à rattacher » (contrôle des doublons du CRM). */
export async function createFicheFromBookingAction(id: string, name: string, force = false) {
  return run(async (sb) => {
    const b = (await q(sb.from("appt_bookings").select("first_name, last_name, email, phone, website").eq("id", idv(id)).single())) as {
      first_name: string; last_name: string; email: string; phone: string | null; website: string | null;
    };
    const companyName = v(z.string().trim().min(1, "Nom de la fiche obligatoire").max(200), name);
    const res = await rpc<{ status: string; id?: string; candidates?: unknown[] }>(sb, "create_company", {
      p_company: { name: companyName, website: b.website },
      p_people: [{ first_name: b.first_name, last_name: b.last_name, email: b.email, phone: b.phone, is_primary: true }],
      p_force: force,
      p_idempotency_key: `appt-fiche-${id}`,
    });
    if (res.status !== "created" || !res.id) return res;
    await rpc(sb, "appt_link_booking", { p_id: id, p_company: res.id, p_person: null, p_add_person: true });
    return res;
  });
}

export async function retryCalendarSyncAction() {
  return run(async (sb) => orchestrate(async () => reconcileCalendar(sb, await origin(), 20)));
}

// Google Calendar ----------------------------------------------------------------

export async function setGoogleCalendarsAction(check: string[], destination: string | null) {
  return run(async (sb) => {
    const ids = v(z.array(z.string().min(1).max(300)).max(30), check);
    await rpc(sb, "appt_set_google_calendars", { p_check: ids, p_destination: destination, p_calendars: null });
  });
}

export async function refreshGoogleCalendarsAction() {
  return run(async (sb) =>
    orchestrate(async () => {
      const creds = await googleCreds(sb);
      if (!creds) throw new CrmError("Aucun agenda Google connecté.");
      const calendars = await google.listCalendars(creds.token);
      const conn = (await q(sb.from("appt_google_connection").select("check_calendar_ids, destination_calendar_id").single())) as {
        check_calendar_ids: string[]; destination_calendar_id: string | null;
      };
      await rpc(sb, "appt_set_google_calendars", { p_check: conn.check_calendar_ids, p_destination: conn.destination_calendar_id, p_calendars: calendars });
      await rpc(sb, "appt_google_status", { p_server_key: null, p_ok: true, p_error: null });
      return calendars.length;
    }),
  );
}

export async function disconnectGoogleAction() {
  return run(async (sb) => {
    // révocation chez Google (jeton propre au module Rendez-vous : n'affecte pas Gmail)
    const { data } = await sb.rpc("appt_server_google", { p_server_key: serverRpcKey() });
    const enc = (data as { refresh_token_enc?: string } | null)?.refresh_token_enc;
    if (enc) await google.revoke(decryptSecret(enc)).catch(() => undefined);
    await rpc(sb, "appt_disconnect_google", {});
  });
}

export async function newIdempotencyKey() {
  return randomUUID();
}
