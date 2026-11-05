// Rendez-vous, phase 2 : règles de rappel et échéances (vraies migrations sur PGlite).
// Génération, réservation tardive, annulation, report, personnalisation locale, versions,
// suspension, raccordement du module Mail sans stock d'anciens rappels.
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const SERVER_KEY = "test-server-key-0123456789abcdef0123456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const H = 3600_000;

let db: Db;
let typeId: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  const scheduleId = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  // planning ouvert en continu : n'importe quel créneau de 30 min est réservable
  await db.rpc("appt_save_schedule", {
    p_id: scheduleId,
    p_data: JSON.stringify({ name: "Continu", rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ weekday: d, start: "00:00", end: "24:00" })) }),
  });
  typeId = (await db.one<{ id: string }>(
    `insert into appt_event_types (name, slug, duration_min, schedule_id, min_notice_min, horizon_days) values ('Appel', 'appel', 30, $1, 0, 365) returning id`,
    [scheduleId],
  )).id;
  await rules(true, [
    { offset_value: 2, offset_unit: "days", subject: "Dans 2 jours", body: "Bonjour {{prenom}}" },
    { offset_value: 24, offset_unit: "hours", subject: "Demain", body: "Bonjour {{prenom}}" },
    { offset_value: 1, offset_unit: "hours", subject: "Dans 1 h", body: "Lien : {{lien_reunion}}" },
  ]);
});

async function rules(enabled: boolean, list: Record<string, unknown>[]) {
  await db.as("owner");
  await db.rpc("appt_save_reminder_rules", { p_type: typeId, p_enabled: enabled, p_rules: JSON.stringify(list.map((r) => ({ enabled: true, ...r }))) });
}

/** Créneau aligné sur 30 min, au moins `hours` heures plus tard. */
const slotIn = (hours: number) => new Date(Math.ceil((Date.now() + hours * H) / (30 * 60_000)) * 30 * 60_000).toISOString();

async function book(startsAt: string) {
  await db.as("anon");
  const id = randomUUID();
  const r = await db.rpc<{ status: string }>("appt_book", {
    p_server_key: SERVER_KEY, p_booking_id: id, p_slug: "appel", p_starts_at: startsAt,
    p_invitee: JSON.stringify({ first_name: "Alice", last_name: "Martin", email: `${id}@acme.fr` }), p_answers: "{}", p_busy: "[]",
    p_calendar_target: false, p_token_hash: sha(id), p_idempotency_key: `key-${id}`, p_hold_minutes: 10,
  });
  expect(r.status).toBe("confirmed");
  return id;
}

type Rem = { id: string; reminder_key: string; subject: string; status: string; status_reason: string | null; send_at: Date; booking_version: number; customized: boolean; revision: number; dedup_key: string; offset_minutes: number };
async function reminders(bookingId: string): Promise<Rem[]> {
  await db.query("reset role");
  return (await db.query<Rem>(`select * from appt_reminders where booking_id = $1 order by created_at, send_at`, [bookingId])).rows;
}
const active = (list: Rem[]) => list.filter((r) => r.status === "scheduled");

async function due(): Promise<{ reminder_id: string; dedup_key: string; revision: number }[]> {
  await db.as("anon");
  return db.rpc("appt_mail_due_reminders", { p_server_key: SERVER_KEY, p_limit: 50, p_grace_minutes: 15 });
}

describe("génération", () => {
  test("une échéance par règle active, délais exacts avant le début", async () => {
    const start = slotIn(24 * 5);
    const b = await book(start);
    const list = active(await reminders(b));
    expect(list.map((r) => r.subject)).toEqual(["Dans 2 jours", "Demain", "Dans 1 h"]);
    expect(list.map((r) => (Date.parse(start) - new Date(r.send_at).getTime()) / 60_000)).toEqual([2880, 1440, 60]);
    expect(new Set(list.map((r) => r.dedup_key)).size).toBe(3);
  });

  test("réservation tardive : les échéances dépassées ne sont jamais créées", async () => {
    const b = await book(slotIn(30));
    expect(active(await reminders(b)).map((r) => r.subject)).toEqual(["Demain", "Dans 1 h"]);
  });

  test("rappels désactivés pour le type, ou règle désactivée : rien n'est programmé", async () => {
    await rules(true, [{ offset_value: 1, offset_unit: "hours", subject: "x", body: "y", enabled: false }]);
    expect(await reminders(await book(slotIn(48)))).toEqual([]);
    await rules(false, [{ offset_value: 1, offset_unit: "hours", subject: "x", body: "y" }]);
    expect(await reminders(await book(slotIn(72)))).toEqual([]);
  });

  test("règles invalides refusées (délai hors bornes, objet vide)", async () => {
    await expect(rules(true, [{ offset_value: 1, offset_unit: "minutes", subject: "x", body: "y" }])).rejects.toThrow();
    await expect(rules(true, [{ offset_value: 31, offset_unit: "days", subject: "x", body: "y" }])).rejects.toThrow();
    await expect(rules(true, [{ offset_value: 1, offset_unit: "hours", subject: " ", body: "y" }])).rejects.toThrow();
  });
});

describe("cycle de vie", () => {
  test("annulation : rappels restants annulés, rappels envoyés conservés", async () => {
    const b = await book(slotIn(24 * 5));
    const [first] = active(await reminders(b));
    await db.as("owner");
    await db.rpc("appt_mail_mark_reminder", { p_reminder: first.id, p_revision: first.revision, p_status: "sent", p_message_id: "m1" });
    await db.rpc("appt_cancel", { p_id: b, p_reason: null });
    const list = await reminders(b);
    expect(list.map((r) => r.status)).toEqual(["sent", "cancelled", "cancelled"]);
    expect(list[1].status_reason).toBe("Rendez-vous annulé");
  });

  test("report : recalcul, personnalisation conservée, ancienne version invalidée, clé stable", async () => {
    const start = slotIn(24 * 5);
    const b = await book(start);
    const [twoDays, day, hour] = active(await reminders(b));
    await db.as("owner");
    // personnalisation locale : le « 24 h » devient « 3 h » avec un autre objet
    await db.rpc("appt_reminder_update", { p_id: day.id, p_offset_value: 3, p_offset_unit: "hours", p_subject: "Perso", p_body: "Texte perso" });
    // annulation explicite du « 1 h » : ne doit pas réapparaître
    await db.rpc("appt_reminder_cancel", { p_id: hour.id });
    // le « 2 jours » a été envoyé
    await db.rpc("appt_mail_mark_reminder", { p_reminder: twoDays.id, p_revision: twoDays.revision, p_status: "sent" });

    const newStart = slotIn(24 * 8);
    const held = await db.rpc<{ hold_id: string }>("appt_reschedule_begin", { p_id: b, p_starts_at: newStart, p_busy: "[]" });
    await db.rpc("appt_reschedule_commit", { p_id: b, p_hold_id: held.hold_id, p_calendar_synced: true });

    const list = await reminders(b);
    const now = active(list);
    expect(now.map((r) => [r.subject, r.booking_version])).toEqual([["Dans 2 jours", 2], ["Perso", 2]]);
    expect(now.find((r) => r.subject === "Perso")!.customized).toBe(true);
    expect((Date.parse(newStart) - new Date(now.find((r) => r.subject === "Perso")!.send_at).getTime()) / 60_000).toBe(180);
    // même identité de rappel, nouvelle clé de déduplication
    expect(now.find((r) => r.subject === "Dans 2 jours")!.reminder_key).toBe(twoDays.reminder_key);
    expect(now.find((r) => r.subject === "Dans 2 jours")!.dedup_key).not.toBe(twoDays.dedup_key);
    expect(list.find((r) => r.id === day.id)).toMatchObject({ status: "superseded", status_reason: "Rendez-vous reporté" });
    expect(list.find((r) => r.id === twoDays.id)!.status).toBe("sent");
    expect(list.find((r) => r.id === hour.id)!.status).toBe("cancelled");
  });

  test("modifier les règles globales ne change pas les rendez-vous existants ; réapplication explicite avec aperçu", async () => {
    const b = await book(slotIn(24 * 5));
    await rules(true, [{ offset_value: 6, offset_unit: "hours", subject: "Nouveau", body: "x" }]);
    expect(active(await reminders(b)).map((r) => r.subject)).toEqual(["Dans 2 jours", "Demain", "Dans 1 h"]);
    await db.as("owner");
    const preview = await db.rpc<{ removed: unknown[]; added: { subject: string }[] }>("appt_reapply_rules_preview", { p_booking: b });
    expect(preview.removed).toHaveLength(3);
    expect(preview.added.map((a) => a.subject)).toEqual(["Nouveau"]);
    expect(await db.rpc("appt_type_reapply_preview", { p_type: typeId })).toEqual([expect.objectContaining({ id: b })]);
    await db.rpc("appt_reapply_rules", { p_booking: b });
    expect(active(await reminders(b)).map((r) => r.subject)).toEqual(["Nouveau"]);
    // les nouveaux rendez-vous prennent les règles actuelles
    expect(active(await reminders(await book(slotIn(24 * 6)))).map((r) => r.subject)).toEqual(["Nouveau"]);
  });

  test("rappel spécifique, délais déjà dépassés refusés, modèle global intact", async () => {
    const b = await book(slotIn(30));
    await db.as("owner");
    await expect(db.rpc("appt_reminder_add", { p_booking: b, p_offset_value: 2, p_offset_unit: "days", p_subject: "x", p_body: "y" })).rejects.toThrow(/déjà passée/);
    await db.rpc("appt_reminder_add", { p_booking: b, p_offset_value: 15, p_offset_unit: "minutes", p_subject: "Juste avant", p_body: "y" });
    expect(active(await reminders(b)).map((r) => r.subject)).toContain("Juste avant");
    await db.query("reset role");
    expect((await db.query(`select subject from appt_reminder_rules order by position`)).rows.map((r) => (r as { subject: string }).subject)).toEqual(["Dans 2 jours", "Demain", "Dans 1 h"]);
  });
});

describe("raccordement au module Mail", () => {
  async function makeDue(bookingId: string, subject: string, minutesAgo: number) {
    await db.query("reset role");
    await db.query(`update appt_reminders set send_at = now() - make_interval(mins => $3) where booking_id = $1 and subject = $2`, [bookingId, subject, minutesAgo]);
  }

  test("tant que l'envoi n'est pas raccordé : rien n'est remis, rien n'est marqué envoyé", async () => {
    const b = await book(slotIn(24 * 5));
    await makeDue(b, "Demain", 1);
    expect(await due()).toEqual([]);
    expect(active(await reminders(b))).toHaveLength(3);
  });

  test("raccordement : jamais de stock d'anciens rappels ; fenêtre de validité ; suspension ; désactivation par rendez-vous", async () => {
    const b = await book(slotIn(24 * 5));
    await makeDue(b, "Dans 2 jours", 5); // échu AVANT le raccordement
    await db.as("anon");
    await db.rpc("appt_mail_connect", { p_server_key: SERVER_KEY });
    expect(await due()).toEqual([]);
    await makeDue(b, "Demain", 0); // échéance atteinte après le raccordement
    await db.query(`update appt_settings set mail_connected_at = now() - interval '1 second'`);
    await db.query(`update appt_reminders set send_at = now() where booking_id = $1 and subject = 'Demain'`, [b]);
    let list = await due();
    expect(list).toHaveLength(1);
    // suspension globale
    await db.as("owner");
    await db.query(`update appt_settings set reminders_paused = true`);
    expect(await due()).toEqual([]);
    await db.as("owner");
    await db.query(`update appt_settings set reminders_paused = false`);
    // désactivation pour ce rendez-vous
    await db.rpc("appt_booking_reminders_off", { p_booking: b, p_off: true });
    expect(await due()).toEqual([]);
    await db.as("owner");
    await db.rpc("appt_booking_reminders_off", { p_booking: b, p_off: false });
    list = await due();
    expect(list).toHaveLength(1);
    // trop ancien (hors fenêtre de 15 min) : jamais remis
    await db.query("reset role");
    await db.query(`update appt_settings set mail_connected_at = now() - interval '2 hours'`);
    await makeDue(b, "Demain", 30);
    await makeDue(b, "Dans 2 jours", 60);
    expect(await due()).toEqual([]);
  });

  test("marquage : refusé si le rappel a changé ; un seul envoi par clé", async () => {
    const b = await book(slotIn(24 * 5));
    const r = active(await reminders(b)).find((x) => x.subject === "Demain")!;
    await db.as("anon");
    await db.rpc("appt_mail_connect", { p_server_key: SERVER_KEY });
    await db.as("owner");
    await db.rpc("appt_reminder_update", { p_id: r.id, p_offset_value: 20, p_offset_unit: "hours", p_subject: "Modifié", p_body: "x" });
    await db.as("anon");
    expect(await db.rpc("appt_mail_reminder_valid", { p_reminder: r.id, p_revision: r.revision, p_server_key: SERVER_KEY })).toBe(false);
    expect(await db.rpc("appt_mail_mark_reminder", { p_reminder: r.id, p_revision: r.revision, p_status: "sent", p_server_key: SERVER_KEY })).toBe(false);
    expect(await db.rpc("appt_mail_reminder_valid", { p_reminder: r.id, p_revision: r.revision + 1, p_server_key: SERVER_KEY })).toBe(true);
    expect(await db.rpc("appt_mail_mark_reminder", { p_reminder: r.id, p_revision: r.revision + 1, p_status: "sent", p_message_id: "msg-1", p_server_key: SERVER_KEY })).toBe(true);
    expect(await db.rpc("appt_mail_mark_reminder", { p_reminder: r.id, p_revision: r.revision + 1, p_status: "sent", p_server_key: SERVER_KEY })).toBe(false);
    await db.query("reset role");
    await expect(db.query(`insert into appt_reminders (booking_id, reminder_key, origin, booking_version, offset_value, offset_unit, offset_minutes, send_at, subject, body)
      select booking_id, reminder_key, origin, booking_version, offset_value, offset_unit, offset_minutes, send_at, subject, body from appt_reminders where id = $1`, [r.id])).rejects.toThrow(/dedup/);
  });

  test("événements de rendez-vous lisibles par curseur ; accès refusé sans clé ni compte", async () => {
    const b = await book(slotIn(24 * 5));
    await db.as("owner");
    await db.rpc("appt_cancel", { p_id: b, p_reason: null });
    await db.as("anon");
    const ev = await db.rpc<{ event_id: number; kind: string }[]>("appt_mail_events", { p_after: 0, p_limit: 100, p_server_key: SERVER_KEY });
    expect(ev.map((e) => e.kind)).toEqual(["confirmed", "cancelled"]);
    expect(await db.rpc("appt_mail_events", { p_after: ev[0].event_id, p_limit: 100, p_server_key: SERVER_KEY })).toHaveLength(1);
    await expect(db.rpc("appt_mail_due_reminders", { p_server_key: null, p_limit: 5, p_grace_minutes: 15 })).rejects.toThrow(/Accès refusé/);
    await db.as("stranger");
    await expect(db.rpc("appt_reminder_cancel", { p_id: randomUUID() })).rejects.toThrow(/Accès refusé/);
    await expect(db.query(`update appt_settings set mail_connected_at = now()`)).rejects.toThrow(/permission denied/);
  });
});
