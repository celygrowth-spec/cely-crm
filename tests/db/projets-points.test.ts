// Projets — phase 2 : phases et avancement réel, points de suivi liés aux rendez-vous (sans copie),
// report et annulation reflétés, récapitulatifs brouillon / publié, rattachement explicite uniquement.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let typeId: string;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let session: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  typeId = (await db.one<{ id: string }>(
    `insert into appt_event_types (name, slug, duration_min, schedule_id, google_meet) values ('Point de suivi', 'point', 45, $1, true) returning id`, [sched])).id;
  acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
  pid = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
  session = (await login(db, acme.people["alice@acme.fr"])).session;
});

const inDays = (d: number, h = 10) => { const t = new Date(Date.now() + d * 86400_000); t.setUTCHours(h, 0, 0, 0); return t.toISOString(); };

async function ownerBook(startsAt: string, person = acme.people["alice@acme.fr"], calendar = false) {
  await db.as("owner");
  const id = randomUUID();
  const r = await db.rpc<{ status: string }>("appt_owner_book", {
    p_booking_id: id, p_type: typeId, p_starts_at: startsAt, p_duration_min: null, p_person: person,
    p_calendar_target: calendar, p_token_hash: sha(id), p_idempotency_key: `k-${id}`,
  });
  return { id, status: r.status };
}

type View = { phases: { name: string; status: string }[]; milestones: unknown[]; meetings: { id: string; title: string; status: string; starts_at: string; meeting_url: string | null; has_recap: boolean }[] };

describe("phases et timeline", () => {
  test("l'avancement réel ne dépend pas des dates ; jalons internes masqués", async () => {
    await db.as("owner");
    await db.query(`insert into project_phases (project_id, position, name, start_date, end_date, status) values
      ($1, 1, 'Cadrage', '2026-01-01', '2026-01-31', 'en_cours'),
      ($1, 2, 'Production', '2099-01-01', '2099-02-01', 'a_venir')`, [pid]);
    await db.query(`insert into project_milestones (project_id, title, due_date, visible_to_client) values ($1, 'Livraison', '2099-02-01', true), ($1, 'Revue interne', '2099-01-15', false)`, [pid]);
    const v = await portal<View>(db, "portal_project", session, { p_project: pid });
    // date de fin passée : la phase reste « en cours » tant qu'elle n'est pas déclarée terminée
    expect(v.phases.map((p) => [p.name, p.status])).toEqual([["Cadrage", "en_cours"], ["Production", "a_venir"]]);
    expect(v.milestones).toHaveLength(1);
    await db.as("owner");
    await db.query(`update project_phases set status = 'termine' where name = 'Cadrage'`);
    expect((await db.one<{ completed_at: Date | null }>(`select completed_at from project_phases where name = 'Cadrage'`)).completed_at).not.toBeNull();
    expect((await db.one<{ current_phase_name: string | null }>(`select current_phase_name from project_overview where id = $1`, [pid])).current_phase_name).toBeNull();
  });
});

describe("points de suivi", () => {
  test("point créé par le propriétaire : rattaché à la fiche, visible si publié, aucune copie de la date", async () => {
    const b = await ownerBook(inDays(3));
    expect(b.status).toBe("confirmed");
    await db.as("owner");
    expect(await db.one(`select company_id, crm_status from appt_bookings where id = $1`, [b.id])).toMatchObject({ company_id: acme.id, crm_status: "linked" });
    const m = await db.rpc<string>("project_link_meeting", { p_project: pid, p_booking: b.id, p_visible: true, p_title: "Point d'étape", p_agenda: "Maquette" });
    let v = await portal<View>(db, "portal_project", session, { p_project: pid });
    expect(v.meetings).toEqual([expect.objectContaining({ id: m, title: "Point d'étape", status: "upcoming" })]);
    // report dans le module Rendez-vous → reflété sans aucune autre action
    await db.as("owner");
    const held = await db.rpc<{ hold_id: string }>("appt_reschedule_begin", { p_id: b.id, p_starts_at: inDays(5, 14), p_busy: "[]" });
    expect((held as unknown as { status: string }).status).toBe("held"); // le propriétaire choisit l'horaire
    await db.rpc("appt_reschedule_commit", { p_id: b.id, p_hold_id: held.hold_id, p_calendar_synced: true });
    v = await portal<View>(db, "portal_project", session, { p_project: pid });
    expect(new Date(v.meetings[0].starts_at).toISOString()).toBe(inDays(5, 14));
    await db.query("reset role");
    await db.query(`update appt_bookings set meeting_url = 'https://meet.google.com/abc-defg-hij' where id = $1`, [b.id]);
    v = await portal<View>(db, "portal_project", session, { p_project: pid });
    expect(v.meetings[0].meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    // annulation : le point reste identifiable, sans lien
    await db.as("owner");
    await db.rpc("appt_cancel", { p_id: b.id, p_reason: null });
    v = await portal<View>(db, "portal_project", session, { p_project: pid });
    expect(v.meetings[0]).toMatchObject({ status: "cancelled", meeting_url: null });
  });

  test("point non visible ; rendez-vous d'une autre fiche refusé ; double rattachement refusé ; chevauchement refusé", async () => {
    const b = await ownerBook(inDays(4));
    await db.as("owner");
    await db.rpc("project_link_meeting", { p_project: pid, p_booking: b.id, p_visible: false });
    expect((await portal<View>(db, "portal_project", session, { p_project: pid })).meetings).toEqual([]);
    await db.as("owner");
    await expect(db.rpc("project_link_meeting", { p_project: pid, p_booking: b.id })).rejects.toThrow(/déjà rattaché/);
    const other = await company(db, "Autre", [{ first_name: "Zoé", email: "zoe@autre.fr" }]);
    const ob = await ownerBook(inDays(6), other.people["zoe@autre.fr"]);
    await db.as("owner");
    await expect(db.rpc("project_link_meeting", { p_project: pid, p_booking: ob.id })).rejects.toThrow(/fiche CRM du projet/);
    expect((await ownerBook(inDays(4))).status).toBe("unavailable");
  });

  test("double clic : même clé, un seul rendez-vous ; avec agenda, en attente de l'événement Google", async () => {
    await db.as("owner");
    const id = randomUUID();
    const args = { p_booking_id: id, p_type: typeId, p_starts_at: inDays(8), p_duration_min: 30, p_person: acme.people["alice@acme.fr"], p_calendar_target: true, p_token_hash: sha(id), p_idempotency_key: "same-key-xyz" };
    expect(await db.rpc("appt_owner_book", args)).toMatchObject({ status: "pending" });
    expect(await db.rpc("appt_owner_book", { ...args, p_booking_id: randomUUID() })).toMatchObject({ status: "existing", id });
    // en attente : pas encore sur le portail
    await db.rpc("project_link_meeting", { p_project: pid, p_booking: id });
    expect((await portal<View>(db, "portal_project", session, { p_project: pid })).meetings).toEqual([]);
    await db.as("anon");
    await db.rpc("appt_confirm_booking", { p_server_key: SERVER_KEY, p_id: id, p_calendar_id: "primary", p_event_id: "rdvx", p_meeting_url: "https://meet.google.com/xyz" });
    const v = await portal<View>(db, "portal_project", session, { p_project: pid });
    expect(v.meetings[0]).toMatchObject({ meeting_url: "https://meet.google.com/xyz", status: "upcoming" });
  });
});

describe("récapitulatifs", () => {
  test("brouillon invisible, publication explicite, note interne jamais exposée", async () => {
    const b = await ownerBook(inDays(2));
    await db.as("owner");
    const m = await db.rpc<string>("project_link_meeting", { p_project: pid, p_booking: b.id });
    await expect(db.rpc("project_publish_recap", { p_meeting: m, p_publish: true })).rejects.toThrow(/introuvable|vide/);
    await db.query(`insert into meeting_recaps (meeting_id, summary, decisions, actions, internal_note) values ($1, 'Maquette validée', 'Couleur violette', '[{"text":"Envoyer les textes"}]', 'NOTE-PRIVEE-RECAP')`, [m]);
    let d = await portal<{ recap: unknown; has_recap: boolean }>(db, "portal_meeting", session, { p_project: pid, p_meeting: m });
    expect(d).toMatchObject({ recap: null, has_recap: false });
    await db.as("owner");
    await db.rpc("project_publish_recap", { p_meeting: m, p_publish: true });
    d = await portal(db, "portal_meeting", session, { p_project: pid, p_meeting: m });
    expect(d).toMatchObject({ has_recap: true, recap: { summary: "Maquette validée", decisions: "Couleur violette" } });
    expect(JSON.stringify(d)).not.toMatch(/NOTE-PRIVEE/);
    expect(JSON.stringify(await portal(db, "portal_project", session, { p_project: pid }))).not.toMatch(/NOTE-PRIVEE/);
    // aperçu administrateur : mêmes règles
    await db.as("owner");
    expect(JSON.stringify(await db.rpc("portal_preview_meeting", { p_project: pid, p_meeting: m }))).not.toMatch(/NOTE-PRIVEE/);
  });

  test("point d'un autre projet inaccessible même avec son identifiant", async () => {
    const p2 = await project(db, acme.id, "Autre projet", [acme.people["bob@acme.fr"]]);
    const b = await ownerBook(inDays(9), acme.people["bob@acme.fr"]);
    await db.as("owner");
    const m = await db.rpc<string>("project_link_meeting", { p_project: p2, p_booking: b.id });
    await expect(portal(db, "portal_meeting", session, { p_project: pid, p_meeting: m })).rejects.toThrow(/introuvable/);
    await expect(portal(db, "portal_meeting", session, { p_project: p2, p_meeting: m })).rejects.toThrow(/Projet introuvable/);
  });
});

describe("écarts Google", () => {
  test("écart signalé puis effacé ; jeton de synchronisation conservé ; accès refusé sans clé", async () => {
    const b = await ownerBook(inDays(3));
    await db.as("anon");
    await db.rpc("appt_google_drift", { p_booking: b.id, p_drift: JSON.stringify({ kind: "moved", start: inDays(4) }), p_server_key: SERVER_KEY });
    await db.rpc("appt_google_events_sync_state", { p_token: "tok-1", p_error: null, p_server_key: SERVER_KEY });
    await db.query("reset role");
    expect(await db.one(`select google_drift ->> 'kind' as k from appt_bookings where id = $1`, [b.id])).toMatchObject({ k: "moved" });
    await db.as("anon");
    await expect(db.rpc("appt_google_drift", { p_booking: b.id, p_drift: null, p_server_key: "x".repeat(40) })).rejects.toThrow(/Accès refusé/);
    await db.rpc("appt_google_drift", { p_booking: b.id, p_drift: null, p_server_key: SERVER_KEY });
    await db.query("reset role");
    expect(await db.one(`select google_drift from appt_bookings where id = $1`, [b.id])).toMatchObject({ google_drift: null });
  });
});
