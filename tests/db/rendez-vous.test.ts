// Module Rendez-vous : règles en base (vraies migrations sur PGlite).
// Créneaux, fuseaux et changements d'heure, battements, limites, concurrence, idempotence,
// annulation, report, rattachement CRM et contrôle d'accès.
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const SERVER_KEY = "test-server-key-0123456789abcdef0123456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let db: Db;
let scheduleId: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  scheduleId = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
});

async function eventType(data: Record<string, unknown> = {}) {
  await db.as("owner");
  const row = { name: "Appel découverte", slug: "appel-decouverte", duration_min: 30, schedule_id: scheduleId, min_notice_min: 0, horizon_days: 365, ...data };
  const keys = Object.keys(row);
  const r = await db.query<{ id: string }>(
    `insert into appt_event_types (${keys.join(",")}) values (${keys.map((_, i) => `$${i + 1}`).join(",")}) returning id`,
    keys.map((k) => {
      const v = (row as Record<string, unknown>)[k];
      return typeof v === "object" && v !== null ? JSON.stringify(v) : v;
    }),
  );
  return r.rows[0].id;
}

async function slots(slug: string, from: string, to: string, busy: unknown[] = [], exclude: string | null = null): Promise<string[]> {
  await db.as("anon");
  const r = await db.rpc<string[] | null>("appt_public_slots", {
    p_server_key: SERVER_KEY, p_slug: slug, p_from: from, p_to: to, p_busy: JSON.stringify(busy), p_exclude_booking: exclude,
  });
  return (r ?? []).map((s) => new Date(s).toISOString());
}

const invitee = (o: Record<string, unknown> = {}) => ({ first_name: "Alice", last_name: "Martin", email: "alice@acme.fr", timezone: "Europe/Paris", ...o });

async function book(slug: string, startsAt: string, o: { invitee?: Record<string, unknown>; answers?: Record<string, string>; busy?: unknown[]; calendar?: boolean; key?: string; id?: string; token?: string } = {}) {
  await db.as("anon");
  const id = o.id ?? randomUUID();
  const res = await db.rpc<{ status: string; id?: string; booking_status?: string }>("appt_book", {
    p_server_key: SERVER_KEY, p_booking_id: id, p_slug: slug, p_starts_at: startsAt, p_invitee: JSON.stringify(o.invitee ?? invitee()),
    p_answers: JSON.stringify(o.answers ?? {}), p_busy: JSON.stringify(o.busy ?? []), p_calendar_target: o.calendar ?? false,
    p_token_hash: sha(o.token ?? `tok-${id}`), p_idempotency_key: o.key ?? `key-${id}`, p_hold_minutes: 10,
  });
  return { ...res, id: res.id ?? id, token: o.token ?? `tok-${id}` };
}

// Dates calculées à partir d'aujourd'hui : les tests ne se périment pas.
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(new Date(new Date(`${date}T12:00:00Z`).getTime() + n * DAY));
/** Premier lundi d'hiver (UTC+1 à Paris) au moins 14 jours après aujourd'hui. */
function winterMonday() {
  let d = new Date(Date.now() + 14 * DAY);
  for (;;) {
    const m = d.getUTCMonth();
    if (d.getUTCDay() === 1 && (m >= 10 || m <= 1) && !(m === 10 && d.getUTCDate() < 8)) return iso(d);
    d = new Date(d.getTime() + DAY);
  }
}
/** Prochain dernier dimanche du mois (changement d'heure européen) après demain. */
function nextLastSunday(month: number) {
  const now = new Date(Date.now() + 2 * DAY);
  for (let y = now.getUTCFullYear(); ; y++) {
    const d = new Date(Date.UTC(y, month + 1, 0, 12));
    while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() - 1);
    if (d > now) return iso(d);
  }
}
const MON = winterMonday();
const TUE = addDays(MON, 1);
const SPRING = nextLastSunday(2);
const AUTUMN = nextLastSunday(9);
const at = (date: string, hhmmUtc: string) => new Date(`${date}T${hhmmUtc}:00Z`).toISOString();

describe("créneaux", () => {
  test("plages hebdomadaires multiples, durée et pas, fuseau du planning", async () => {
    await eventType();
    const s = await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`);
    // 9h-12h et 14h-18h Paris = 8h-11h et 13h-17h UTC, créneaux de 30 min
    expect(s[0]).toBe(at(MON, "08:00"));
    expect(s).toContain(at(MON, "10:30"));
    expect(s).not.toContain(at(MON, "11:00"));
    expect(s).toContain(at(MON, "13:00"));
    expect(s.at(-1)).toBe(at(MON, "16:30"));
    expect(s).toHaveLength(6 + 8);
  });

  test("week-end fermé, exception « indisponible » et exception avec horaires remplaçants", async () => {
    await eventType();
    expect(await slots("appel-decouverte", `${addDays(MON, 5)}T00:00:00Z`, `${addDays(MON, 6)}T23:00:00Z`)).toEqual([]);
    await db.as("owner");
    await db.rpc("appt_save_schedule", {
      p_id: scheduleId,
      p_data: JSON.stringify({
        name: "Horaires", timezone: "Europe/Paris",
        rules: [1, 2, 3, 4, 5].map((d) => ({ weekday: d, start: "09:00", end: "12:00" })),
        overrides: [{ date: MON }, { date: TUE, start: "15:00", end: "16:00" }],
      }),
    });
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toEqual([]);
    expect(await slots("appel-decouverte", `${TUE}T00:00:00Z`, `${TUE}T23:59:00Z`)).toEqual([at(TUE, "14:00"), at(TUE, "14:30")]);
  });

  test("plages qui se chevauchent refusées", async () => {
    await db.as("owner");
    await expect(
      db.rpc("appt_save_schedule", {
        p_id: scheduleId,
        p_data: JSON.stringify({ name: "X", rules: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "11:00", end: "13:00" }] }),
      }),
    ).rejects.toThrow(/chevauchent/);
  });

  test("changement d'heure : 9 h Paris = 8 h UTC en hiver, 7 h UTC en été", async () => {
    await eventType();
    const fri = addDays(SPRING, -2);
    const mon = addDays(SPRING, 1);
    const before = await slots("appel-decouverte", `${fri}T00:00:00Z`, `${fri}T23:00:00Z`);
    const after = await slots("appel-decouverte", `${mon}T00:00:00Z`, `${mon}T23:00:00Z`);
    expect(before[0]).toBe(at(fri, "08:00"));
    expect(after[0]).toBe(at(mon, "07:00"));
  });

  test("nuit du changement d'heure : seules les heures réelles sont proposées", async () => {
    await eventType({ duration_min: 60 });
    await db.as("owner");
    await db.rpc("appt_save_schedule", {
      p_id: scheduleId,
      p_data: JSON.stringify({ name: "Nuit", rules: [], overrides: [{ date: SPRING, start: "01:00", end: "04:00" }, { date: AUTUMN, start: "01:00", end: "04:00" }] }),
    });
    // printemps : 01:00-04:00 locales ne durent que 2 h réelles
    expect(await slots("appel-decouverte", `${addDays(SPRING, -1)}T12:00:00Z`, `${SPRING}T12:00:00Z`)).toEqual([at(SPRING, "00:00"), at(SPRING, "01:00")]);
    // automne : 4 h réelles (2 h du matin existe deux fois)
    const sat = addDays(AUTUMN, -1);
    expect(await slots("appel-decouverte", `${sat}T12:00:00Z`, `${AUTUMN}T12:00:00Z`)).toEqual([
      at(sat, "23:00"), at(AUTUMN, "00:00"), at(AUTUMN, "01:00"), at(AUTUMN, "02:00"),
    ]);
  });

  test("autre fuseau de planning (New York)", async () => {
    await db.as("owner");
    const ny = await db.rpc<string>("appt_save_schedule", {
      p_id: null, p_data: JSON.stringify({ name: "NY", timezone: "America/New_York", rules: [{ weekday: 1, start: "09:00", end: "10:00" }] }),
    });
    await eventType({ slug: "ny", schedule_id: ny, duration_min: 60 });
    expect(await slots("ny", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toEqual([at(MON, "14:00")]);
  });

  test("délai minimum et horizon", async () => {
    await eventType({ min_notice_min: 43200 });
    const soon = addDays(iso(new Date()), 10);
    expect(await slots("appel-decouverte", `${soon}T00:00:00Z`, `${addDays(soon, 6)}T23:59:00Z`)).toEqual([]);
    await db.query(`reset role`);
    await db.query(`update appt_event_types set min_notice_min = 0, horizon_days = 1`);
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toEqual([]);
  });

  test("occupations Google (battements compris) et congés", async () => {
    await eventType({ buffer_before_min: 15 });
    const busy = [{ start: at(MON, "08:30"), end: at(MON, "09:00") }];
    const s = await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`, busy);
    expect(s).not.toContain(at(MON, "08:30"));
    expect(s).not.toContain(at(MON, "09:00")); // battement avant de 15 min touche l'occupation
    expect(s).toContain(at(MON, "09:30"));
    await db.as("owner");
    await db.rpc("appt_save_block", { p_id: null, p_label: "Congés", p_start_date: MON, p_end_date: MON, p_timezone: "Europe/Paris" });
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toEqual([]);
  });

  test("limite quotidienne par type", async () => {
    await eventType({ daily_limit: 1 });
    expect((await book("appel-decouverte", at(MON, "08:00"))).status).toBe("confirmed");
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toEqual([]);
    expect((await slots("appel-decouverte", `${TUE}T00:00:00Z`, `${TUE}T23:59:00Z`)).length).toBeGreaterThan(0);
    expect((await book("appel-decouverte", at(MON, "10:00"))).status).toBe("unavailable");
  });
});

describe("réservation", () => {
  test("réservation confirmée, créneau retiré pour tous les types (battements cumulés)", async () => {
    await eventType({ buffer_after_min: 15 });
    await eventType({ slug: "point-client", name: "Point client", buffer_before_min: 15 });
    const b = await book("appel-decouverte", at(MON, "08:00"));
    expect(b.status).toBe("confirmed");
    const s = await slots("point-client", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`);
    expect(s).not.toContain(at(MON, "08:00"));
    expect(s).not.toContain(at(MON, "08:30")); // 08:30-15 = 08:15 < fin+15 = 08:45
    expect(s).toContain(at(MON, "09:00"));
  });

  test("créneau hors planning ou déjà pris : refusé, rien n'est créé", async () => {
    await eventType();
    expect((await book("appel-decouverte", at(MON, "08:10"))).status).toBe("unavailable");
    expect((await book("appel-decouverte", at(MON, "11:30"))).status).toBe("unavailable");
    await book("appel-decouverte", at(MON, "08:00"));
    expect((await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "bob@x.fr" }) })).status).toBe("unavailable");
    await db.query("reset role");
    expect((await db.one<{ n: number }>(`select count(*)::int n from appt_bookings`)).n).toBe(1);
  });

  test("double clic : même clé d'idempotence, un seul rendez-vous", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"), { key: "same-key-123" });
    const b = await book("appel-decouverte", at(MON, "08:00"), { key: "same-key-123" });
    expect(a.status).toBe("confirmed");
    expect(b).toMatchObject({ status: "existing", id: a.id, booking_status: "confirmed" });
  });

  test("la contrainte d'exclusion protège même sans passer par la vérification", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"));
    await db.query("reset role");
    await expect(
      db.query(`insert into appt_reservations (booking_id, kind, occupied) select id, 'main', tstzrange($1, $2) from appt_bookings where id <> $3 limit 1`, [at(MON, "08:10"), at(MON, "08:20"), a.id]),
    ).resolves.toBeDefined(); // aucune autre réservation : rien à insérer
    const other = await book("appel-decouverte", at(MON, "09:00"));
    await db.query("reset role");
    await expect(
      db.query(`insert into appt_reservations (booking_id, kind, occupied) values ($1, 'main', tstzrange($2, $3))`, [other.id, at(MON, "08:10"), at(MON, "08:20")]),
    ).rejects.toThrow(/appt_reservations_no_overlap/);
  });

  test("champs obligatoires, téléphone si nécessaire, questions configurées", async () => {
    await eventType({
      location_kind: "phone",
      questions: [
        { id: "q1", label: "Votre besoin", kind: "long", required: true },
        { id: "q2", label: "Budget", kind: "choice", required: false, options: ["< 5 k€", "> 5 k€"] },
      ],
    });
    await expect(book("appel-decouverte", at(MON, "08:00"), { answers: { q1: "x" } })).rejects.toThrow(/téléphone est obligatoire/);
    await expect(book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ phone: "0600000000" }) })).rejects.toThrow(/Votre besoin/);
    await expect(book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ phone: "06" }), answers: { q1: "x", q2: "autre" } })).rejects.toThrow(/Choix invalide/);
    await expect(book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "pas-un-email" }) })).rejects.toThrow(/Email invalide/);
    const ok = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ phone: "06" }), answers: { q1: "Refonte", q2: "> 5 k€" } });
    expect(ok.status).toBe("confirmed");
    await db.query("reset role");
    const row = await db.one<{ answers: { label: string; value: string }[]; event_snapshot: { name: string } }>(`select answers, event_snapshot from appt_bookings where id = $1`, [ok.id]);
    expect(row.answers.map((a) => a.value)).toEqual(["Refonte", "> 5 k€"]);
    // modifier le type ne touche pas aux rendez-vous existants
    await db.query(`update appt_event_types set name = 'Autre nom', duration_min = 60`);
    const after = await db.one<{ event_snapshot: { name: string; duration_min: number }; ends_at: Date }>(`select event_snapshot, ends_at from appt_bookings where id = $1`, [ok.id]);
    expect(after.event_snapshot).toMatchObject({ name: "Appel découverte", duration_min: 30 });
    expect(new Date(after.ends_at).toISOString()).toBe(at(MON, "08:30"));
  });

  test("avec agenda : retenue « pending », confirmée après Google ; abandon libère le créneau", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"), { calendar: true });
    expect(a.status).toBe("pending");
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).not.toContain(at(MON, "08:00"));
    await db.as("anon");
    await db.rpc("appt_abandon_booking", { p_server_key: SERVER_KEY, p_id: a.id, p_reason: "Google indisponible" });
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toContain(at(MON, "08:00"));
    // confirmation impossible après abandon
    await db.as("anon");
    expect(await db.rpc("appt_confirm_booking", { p_server_key: SERVER_KEY, p_id: a.id, p_calendar_id: "primary", p_event_id: "e1" })).toMatchObject({ status: "expired" });

    const b = await book("appel-decouverte", at(MON, "08:00"), { calendar: true });
    await db.as("anon");
    expect(await db.rpc("appt_confirm_booking", { p_server_key: SERVER_KEY, p_id: b.id, p_calendar_id: "primary", p_event_id: "celyabc", p_meeting_url: "https://meet.google.com/x" })).toMatchObject({ status: "confirmed" });
    await db.query("reset role");
    expect(await db.one(`select status, google_event_id, meeting_url, calendar_synced_version, version from appt_bookings where id = $1`, [b.id])).toMatchObject({
      status: "confirmed", google_event_id: "celyabc", meeting_url: "https://meet.google.com/x", calendar_synced_version: 1, version: 1,
    });
  });

  test("retenue expirée (serveur interrompu) : le créneau est libéré et le rendez-vous part en reprise Google", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"), { calendar: true });
    await db.query("reset role");
    await db.query(`update appt_bookings set hold_expires_at = now() - interval '1 minute' where id = $1`, [a.id]);
    await db.query(`update appt_reservations set expires_at = now() - interval '1 minute' where booking_id = $1`, [a.id]);
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toContain(at(MON, "08:00"));
    const b = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "z@z.fr" }) });
    expect(b.status).toBe("confirmed");
    await db.as("anon");
    const backlog = await db.rpc<{ id: string; status: string }[]>("appt_calendar_backlog", { p_server_key: SERVER_KEY, p_limit: 20 });
    expect(backlog).toEqual([expect.objectContaining({ id: a.id, status: "expired" })]);
  });
});

describe("annulation et report", () => {
  test("annulation par lien privé : motif, créneau libéré, historique conservé", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"));
    await db.as("anon");
    await expect(db.rpc("appt_cancel", { p_id: a.id, p_reason: null, p_server_key: SERVER_KEY, p_token_hash: sha("mauvais") })).rejects.toThrow(/Lien invalide/);
    await expect(db.rpc("appt_cancel", { p_id: a.id, p_reason: null, p_server_key: "x".repeat(40), p_token_hash: sha(a.token) })).rejects.toThrow(/Accès refusé/);
    const r = await db.rpc("appt_cancel", { p_id: a.id, p_reason: "Empêchement", p_server_key: SERVER_KEY, p_token_hash: sha(a.token) });
    expect(r).toMatchObject({ status: "cancelled", version: 2 });
    expect(await db.rpc("appt_cancel", { p_id: a.id, p_reason: null, p_server_key: SERVER_KEY, p_token_hash: sha(a.token) })).toMatchObject({ already: true });
    expect(await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`)).toContain(at(MON, "08:00"));
    await db.query("reset role");
    expect(await db.one(`select status, cancel_reason, cancelled_by from appt_bookings where id = $1`, [a.id])).toMatchObject({ status: "cancelled", cancel_reason: "Empêchement", cancelled_by: "invitee" });
    const kinds = (await db.query<{ kind: string }>(`select kind from appt_booking_events where booking_id = $1 order by id`, [a.id])).rows.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(["created", "confirmed", "cancelled"]));
  });

  test("le jeton d'un rendez-vous ne donne aucun droit sur un autre", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"));
    const b = await book("appel-decouverte", at(MON, "09:00"), { invitee: invitee({ email: "b@b.fr" }) });
    await db.as("anon");
    await expect(db.rpc("appt_public_booking", { p_server_key: SERVER_KEY, p_id: b.id, p_token_hash: sha(a.token) })).rejects.toThrow(/Lien invalide/);
    await expect(db.rpc("appt_cancel", { p_id: b.id, p_reason: null, p_server_key: SERVER_KEY, p_token_hash: sha(a.token) })).rejects.toThrow(/Lien invalide/);
    expect(await db.rpc("appt_public_booking", { p_server_key: SERVER_KEY, p_id: a.id, p_token_hash: sha(a.token) })).toMatchObject({ id: a.id, status: "confirmed" });
  });

  test("report : nouveau créneau vérifié et retenu avant libération de l'ancien", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"));
    const other = await book("appel-decouverte", at(MON, "10:00"), { invitee: invitee({ email: "o@o.fr" }) });
    const auth = { p_server_key: SERVER_KEY, p_token_hash: sha(a.token) };
    await db.as("anon");
    expect(await db.rpc("appt_reschedule_begin", { p_id: a.id, p_starts_at: at(MON, "10:00"), p_busy: "[]", ...auth })).toMatchObject({ status: "unavailable" });
    // chevauche son propre ancien créneau : autorisé
    const held = await db.rpc<{ status: string; hold_id: string }>("appt_reschedule_begin", { p_id: a.id, p_starts_at: at(MON, "08:30"), p_busy: "[]", ...auth });
    expect(held.status).toBe("held");
    // pendant le report, ni l'ancien ni le nouveau créneau ne sont proposés
    const during = await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`);
    expect(during).not.toContain(at(MON, "08:00"));
    expect(during).not.toContain(at(MON, "08:30"));
    await db.as("anon");
    expect(await db.rpc("appt_reschedule_commit", { p_id: a.id, p_hold_id: held.hold_id, p_calendar_synced: true, ...auth })).toMatchObject({ status: "rescheduled", version: 2 });
    const after = await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`);
    expect(after).toContain(at(MON, "08:00"));
    expect(after).not.toContain(at(MON, "08:30"));
    await db.query("reset role");
    expect(await db.one(`select starts_at, ends_at, version, calendar_synced_version from appt_bookings where id = $1`, [a.id])).toMatchObject({
      starts_at: new Date(at(MON, "08:30")), ends_at: new Date(at(MON, "09:00")), version: 2,
    });
    expect((await db.one<{ status: string }>(`select status from appt_bookings where id = $1`, [other.id])).status).toBe("confirmed");
  });

  test("report qui échoue : l'ancien rendez-vous reste intact", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"));
    const auth = { p_server_key: SERVER_KEY, p_token_hash: sha(a.token) };
    await db.as("anon");
    const held = await db.rpc<{ hold_id: string }>("appt_reschedule_begin", { p_id: a.id, p_starts_at: at(MON, "09:00"), p_busy: "[]", ...auth });
    await db.rpc("appt_reschedule_abort", { p_id: a.id, p_hold_id: held.hold_id, p_reason: "Google indisponible", ...auth });
    const s = await slots("appel-decouverte", `${MON}T00:00:00Z`, `${MON}T23:59:00Z`);
    expect(s).toContain(at(MON, "09:00"));
    expect(s).not.toContain(at(MON, "08:00"));
    await db.as("anon");
    expect(await db.rpc("appt_reschedule_commit", { p_id: a.id, p_hold_id: held.hold_id, p_calendar_synced: true, ...auth })).toMatchObject({ status: "expired" });
    await db.query("reset role");
    expect(await db.one(`select status, starts_at, version from appt_bookings where id = $1`, [a.id])).toMatchObject({ status: "confirmed", starts_at: new Date(at(MON, "08:00")), version: 1 });
  });

  test("report non répercuté dans Google : repris par la synchronisation", async () => {
    await eventType();
    const a = await book("appel-decouverte", at(MON, "08:00"), { calendar: true });
    await db.as("anon");
    await db.rpc("appt_confirm_booking", { p_server_key: SERVER_KEY, p_id: a.id, p_calendar_id: "primary", p_event_id: "ev1" });
    await db.as("owner");
    const held = await db.rpc<{ hold_id: string }>("appt_reschedule_begin", { p_id: a.id, p_starts_at: at(MON, "09:00"), p_busy: "[]" });
    await db.rpc("appt_reschedule_commit", { p_id: a.id, p_hold_id: held.hold_id, p_calendar_synced: false });
    const backlog = await db.rpc<{ id: string; status: string; version: number }[]>("appt_calendar_backlog", { p_limit: 20 });
    expect(backlog).toEqual([expect.objectContaining({ id: a.id, status: "confirmed", version: 2 })]);
    await db.rpc("appt_mark_calendar", { p_id: a.id, p_version: 2 });
    expect(await db.rpc("appt_calendar_backlog", { p_limit: 20 })).toEqual([]);
  });
});

describe("rattachement CRM", () => {
  async function company(name: string, website: string | null, people: Record<string, unknown>[] = []) {
    await db.as("owner");
    return (await db.rpc<{ id: string }>("create_company", { p_company: JSON.stringify({ name, website }), p_people: JSON.stringify(people), p_force: true })).id;
  }
  const linkOf = (id: string) => db.one<{ company_id: string | null; person_id: string | null; crm_status: string; crm_candidates: { company_id: string; reasons: string[] }[] }>(
    `select company_id, person_id, crm_status, crm_candidates from appt_bookings where id = $1`, [id]);

  test("email connu : rattaché à la fiche existante, sans doublon ni écrasement", async () => {
    await eventType();
    const c = await company("Acme", "acme.fr", [{ first_name: "Alice", last_name: "M.", email: "Alice@Acme.fr", phone: "0101" }]);
    const b = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ phone: "0999", company_name: "ACME Industries" }) });
    await db.query("reset role");
    expect(await linkOf(b.id)).toMatchObject({ company_id: c, crm_status: "linked" });
    expect((await db.one<{ n: number }>(`select count(*)::int n from companies`)).n).toBe(1);
    expect(await db.one(`select phone, last_name from people where company_id = $1`, [c])).toMatchObject({ phone: "0101", last_name: "M." });
    const notes = await db.query<{ content: string }>(`select content from interactions where company_id = $1 and meta ? 'appointment_id'`, [c]);
    expect(notes.rows[0].content).toBe(`Rendez-vous réservé : Appel découverte le ${MON.split("-").reverse().join("/")} à 09h00`);
  });

  test("domaine professionnel = indice : « À rattacher » avec suggestion, rien de créé", async () => {
    await eventType();
    const c = await company("Acme", "acme.fr");
    const b = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "bob@acme.fr", company_name: "Acme" }) });
    await db.query("reset role");
    const l = await linkOf(b.id);
    expect(l.crm_status).toBe("to_link");
    expect(l.company_id).toBeNull();
    expect(l.crm_candidates.map((x) => x.company_id)).toEqual([c]);
    expect((await db.one<{ n: number }>(`select count(*)::int n from companies`)).n).toBe(1);
  });

  test("Gmail : aucune entreprise déduite du domaine ; nom seulement ressemblant : jamais fusionné", async () => {
    await eventType();
    await company("Dupont Conseil", null, [{ first_name: "Jean", last_name: "Dupont", email: "jean@gmail.com" }]);
    const b = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "paul@gmail.com", first_name: "Paul" }) });
    await db.query("reset role");
    expect(await linkOf(b.id)).toMatchObject({ crm_status: "to_link", crm_candidates: [], company_id: null });
    const b2 = await book("appel-decouverte", at(MON, "09:00"), { invitee: invitee({ email: "marc@outlook.fr", company_name: "Dupont Conseils" }) });
    await db.query("reset role");
    const l2 = await linkOf(b2.id);
    expect(l2.crm_status).toBe("to_link");
    expect(l2.crm_candidates[0].reasons[0]).toMatch(/proche/);
  });

  test("nouveau contact avec entreprise inconnue : fiche créée une seule fois", async () => {
    await eventType();
    const b = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "eve@nova.io", company_name: "Nova", website: "https://nova.io" }) });
    await db.query("reset role");
    const l = await linkOf(b.id);
    expect(l.crm_status).toBe("created");
    expect(await db.one(`select name, domain_norm from companies where id = $1`, [l.company_id])).toMatchObject({ name: "Nova", domain_norm: "nova.io" });
    // deuxième réservation du même contact : rattachée par email, pas de seconde fiche
    const b2 = await book("appel-decouverte", at(MON, "09:00"), { invitee: invitee({ email: "EVE@nova.io", company_name: "Nova SAS" }) });
    await db.query("reset role");
    expect(await linkOf(b2.id)).toMatchObject({ company_id: l.company_id, crm_status: "linked" });
    expect((await db.one<{ n: number }>(`select count(*)::int n from companies`)).n).toBe(1);
  });

  test("rattachement manuel : ajoute le contact à la fiche choisie", async () => {
    await eventType();
    const c = await company("Acme", "acme.fr");
    const b = await book("appel-decouverte", at(MON, "08:00"), { invitee: invitee({ email: "bob@acme.fr" }) });
    await db.as("owner");
    const r = await db.rpc<{ person_id: string }>("appt_link_booking", { p_id: b.id, p_company: c, p_person: null, p_add_person: true });
    expect(await linkOf(b.id)).toMatchObject({ company_id: c, crm_status: "linked", person_id: r.person_id });
    expect(await db.one(`select email, first_name from people where id = $1`, [r.person_id])).toMatchObject({ email: "bob@acme.fr", first_name: "Alice" });
  });

  test("qualification : réalisé → échange « rendez-vous » dans l'historique de la fiche ; pas de déplacement de pipeline", async () => {
    await eventType({ min_notice_min: 0 });
    const c = await company("Acme", "acme.fr", [{ first_name: "A", email: "alice@acme.fr" }]);
    const b = await book("appel-decouverte", at(MON, "08:00"));
    await db.query("reset role");
    await db.query(`update appt_bookings set starts_at = now() - interval '2 hours', ends_at = now() - interval '90 minutes' where id = $1`, [b.id]);
    await db.as("owner");
    expect((await db.one<{ display_status: string }>(`select display_status from appt_booking_overview where id = $1`, [b.id])).display_status).toBe("a_renseigner");
    await db.rpc("appt_set_outcome", { p_id: b.id, p_outcome: "done" });
    await db.rpc("appt_set_outcome", { p_id: b.id, p_outcome: "done" });
    expect((await db.one<{ n: number }>(`select count(*)::int n from interactions where company_id = $1 and kind = 'meeting'`, [c])).n).toBe(1);
    expect(await db.one(`select pipeline_id, stage_id from companies where id = $1`, [c])).toMatchObject({ pipeline_id: null, stage_id: null });
  });
});

describe("contrôle d'accès", () => {
  test("sans clé serveur, le public n'a accès à rien", async () => {
    await eventType();
    await db.as("anon");
    await expect(db.rpc("appt_public_event", { p_server_key: "faux".repeat(10), p_slug: "appel-decouverte" })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("appt_public_event", { p_server_key: null, p_slug: "appel-decouverte" })).rejects.toThrow(/Accès refusé/);
    await expect(db.query(`select * from appt_bookings`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from appt_event_types`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select appt_private.compute_slots(null, now(), now(), '[]', null)`)).rejects.toThrow(/permission denied/);
    expect(await db.rpc("appt_public_event", { p_server_key: SERVER_KEY, p_slug: "appel-decouverte" })).toMatchObject({ slug: "appel-decouverte", timezone: "Europe/Paris" });
  });

  test("autre compte et jeton Claude : refusés ; clé serveur et jeton Google illisibles", async () => {
    await eventType();
    await db.as("stranger");
    expect((await db.query(`select * from appt_event_types`)).rows).toEqual([]);
    await expect(db.rpc("appt_register_server_key", { p_hash: "0".repeat(64) })).rejects.toThrow(/Accès refusé/);
    await db.as("claude");
    await expect(db.rpc("appt_set_note", { p_id: randomUUID(), p_note: "x" })).rejects.toThrow(/réservée à l'application/);
    await db.as("owner");
    await expect(db.query(`select server_key_hash from appt_settings`)).rejects.toThrow(/permission denied/);
    await db.rpc("appt_save_google_connection", { p_email: "moi@gmail.com", p_refresh_token_enc: "enc", p_scopes: "s", p_calendars: JSON.stringify([{ id: "moi@gmail.com", primary: true }]) });
    await expect(db.query(`select refresh_token_enc from appt_google_connection`)).rejects.toThrow(/permission denied/);
    expect(await db.one(`select check_calendar_ids, destination_calendar_id from appt_google_connection`)).toMatchObject({ check_calendar_ids: ["moi@gmail.com"], destination_calendar_id: "moi@gmail.com" });
  });

  test("les points d'entrée publics restent appelables après toutes les migrations", async () => {
    await db.query("reset role");
    const r = await db.query<{ fn: string; ok: boolean }>(`
      select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as ok
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname in ('appt_public_event','appt_public_slots','appt_book','appt_cancel','appt_public_booking')`);
    expect(r.rows.every((x) => x.ok)).toBe(true);
    const owner = await db.query<{ ok: boolean }>(`select has_function_privilege('anon', 'public.appt_set_note(uuid, text)', 'execute') as ok`);
    expect(owner.rows[0].ok).toBe(false);
  });
});
