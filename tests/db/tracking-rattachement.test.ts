// Tracking site · lots 3 et 4 : un rendez-vous de la réservation publique reçoit la source de sa visite ;
// première et dernière source ; source de la fiche jamais écrasée ; aucun doublon ; annulation ; parcours ; retour.
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V1 = id(1), V2 = id(2), V3 = id(3), U1 = id(100);
const DAY = 86_400_000;
let db: Db;
let pv = 1000;

/** Prochain lundi à au moins 14 jours, 10 h à Paris (heure d'hiver ou d'été : le créneau reste dans les plages). */
function slot(offsetHours = 0) {
  let d = new Date(Date.now() + 14 * DAY);
  while (d.getUTCDay() !== 1) d = new Date(d.getTime() + DAY);
  return `${d.toISOString().slice(0, 10)}T${String(9 + offsetHours).padStart(2, "0")}:00:00.000Z`;
}

beforeEach(async () => {
  db = await createDb();
  pv = 1000;
  await db.rpc("appt_register_server_key", { p_hash: sha(KEY) });
  const schedule = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  await db.query(`insert into appt_event_types (name, slug, duration_min, schedule_id, min_notice_min, horizon_days) values ('Appel découverte', 'appel-decouverte', 30, $1, 0, 365)`, [schedule]);
  await db.as("anon");
});

const collect = (event: Record<string, unknown>) => db.rpc<string>("site_collect", { p_server_key: KEY, p_event: event });
const visit = (v: string, path: string, more: Record<string, unknown> = {}) => collect({ type: "pv", visit_id: v, pageview_id: id(pv++), path, ...more });
const LINKEDIN = { channel: "campaign", source: "linkedin", utm_source: "linkedin", utm_medium: "post", utm_campaign: "lancement" };

async function book(o: { email?: string; company?: string | null; calendar?: boolean; hours?: number } = {}) {
  await db.as("anon");
  const bid = randomUUID();
  const res = await db.rpc<{ status: string; id?: string }>("appt_book", {
    p_server_key: KEY, p_booking_id: bid, p_slug: "appel-decouverte", p_starts_at: slot(o.hours ?? 0),
    p_invitee: JSON.stringify({ first_name: "Léa", last_name: "Test", email: o.email ?? "lea@atelier.example.test", company_name: o.company === undefined ? "[TEST] Atelier" : o.company, timezone: "Europe/Paris" }),
    p_answers: "{}", p_busy: "[]", p_calendar_target: o.calendar ?? false, p_token_hash: sha(`tok-${bid}`), p_idempotency_key: `key-${bid}`, p_hold_minutes: 10,
  });
  return { ...res, id: res.id ?? bid, token: `tok-${bid}` };
}
const attach = (booking: string, o: { visit?: string; visitor?: string; source?: string; detail?: string } = {}) => db.rpc<string>("site_attach_booking", {
  p_server_key: KEY, p_booking: booking, p_visit: o.visit ?? null, p_visitor: o.visitor ?? null, p_declared_source: o.source ?? null, p_declared_detail: o.detail ?? null,
});
const owner = async <T>(sql: string, params?: unknown[]) => {
  await db.as("owner");
  const rows = (await db.query<T>(sql, params)).rows;
  await db.as("anon");
  return rows;
};
const ago = async (v: string, interval: string) => {
  await db.exec(`reset role; update site_visits set started_at = now() - interval '${interval}' where id = '${v}'; update site_pageviews set at = now() - interval '${interval}' where visit_id = '${v}';`);
  await db.as("anon");
};

describe("rendez-vous pris pendant une visite", () => {
  test("sans consentement : la source et les UTM de la visite, aucun identifiant ; la fiche créée reçoit la source", async () => {
    await visit(V1, "/services", { visit: LINKEDIN });
    const b = await book();
    expect(b.status).toBe("confirmed");
    expect(await attach(b.id, { visit: V1, visitor: U1, source: "LinkedIn", detail: "Un post de Célien" })).toBe("ok");
    const [a] = await owner<Record<string, unknown>>(`select * from site_conversions`);
    // l'identifiant annoncé par le navigateur n'est pas retenu : la visite n'a pas de consentement
    expect(a).toMatchObject({ visit_id: V1, visitor_id: null, first_channel: "campaign", first_source: "linkedin", first_campaign: "lancement",
      last_channel: "campaign", last_campaign: "lancement", declared_source: "LinkedIn", declared_detail: "Un post de Célien", counted: true, visits_before: 0 });
    expect(a.fiche_company_id).toBeTruthy();
    expect(await owner(`select s.name from companies c join lead_sources s on s.id = c.source_id`)).toEqual([{ name: "LinkedIn" }]);
    expect(await owner(`select * from site_visitors`)).toEqual([]);
  });

  test("avec consentement : campagne en première source, retour en direct en dernière source", async () => {
    await visit(V1, "/services", { visitor_id: U1, visit: LINKEDIN });
    await ago(V1, "5 days");
    await visit(V2, "/", { visitor_id: U1, visit: { channel: "direct" } });
    await visit(V2, "/contact", { visitor_id: U1 });
    const b = await book({ calendar: true });
    expect(b.status).toBe("pending");
    expect(await attach(b.id, { visit: V2, visitor: U1 })).toBe("ok");
    // la fiche est rattachée à la confirmation, après la réservation : la source suit
    await db.rpc("appt_confirm_booking", { p_server_key: KEY, p_id: b.id, p_calendar_id: "primary", p_event_id: "ev1" });
    expect(await owner(`select visit_id, visitor_id, first_visit_id, first_channel, first_campaign, last_channel, visits_before, fiche_company_id is not null as fiche from site_conversions`))
      .toEqual([{ visit_id: V2, visitor_id: U1, first_visit_id: V1, first_channel: "campaign", first_campaign: "lancement", last_channel: "direct", visits_before: 1, fiche: true }]);
    expect(await owner(`select s.name from companies c join lead_sources s on s.id = c.source_id`)).toEqual([{ name: "LinkedIn" }]);
    const company = (await owner<{ id: string }>(`select id from companies`))[0].id;
    await db.as("owner");
    const j = await db.rpc<{ first: { channel: string; campaign: string }; last: { channel: string }; visits: { id: string; pages: { path: string }[] }[]; bookings: { counted: boolean; visit_id: string }[] }>("site_company_journey", { p_company: company });
    expect(j.first).toMatchObject({ channel: "campaign", campaign: "lancement" });
    expect(j.last).toMatchObject({ channel: "direct" });
    expect(j.visits.map((v) => [v.id, v.pages.map((p) => p.path)])).toEqual([[V1, ["/services"]], [V2, ["/", "/contact"]]]);
    expect(j.bookings).toMatchObject([{ counted: true, visit_id: V2 }]);
  });

  test("double envoi : une seule attribution ; rendez-vous inconnu ou sans rien à garder : ignoré", async () => {
    await visit(V1, "/", { visit: LINKEDIN });
    const b = await book();
    expect(await attach(b.id, { visit: V1 })).toBe("ok");
    expect(await attach(b.id, { visit: V1, source: "Autre" })).toBe("existing");
    expect(await attach(randomUUID(), { visit: V1 })).toBe("ignored");
    const c = await book({ email: "autre@ailleurs.example.test", company: "[TEST] Ailleurs", hours: 1 });
    expect(await attach(c.id, { visit: randomUUID() })).toBe("ignored");
    expect(await owner(`select count(*)::int as n, count(declared_source)::int as d from site_attributions`)).toEqual([{ n: 1, d: 0 }]);
    await expect(db.rpc("site_attach_booking", { p_server_key: "x".repeat(40), p_booking: b.id })).rejects.toThrow(/Accès refusé/);
  });

  test("réservation ouverte sans visite du site : seule la source déclarée est gardée", async () => {
    const b = await book();
    expect(await attach(b.id, { source: "Recommandation", detail: "Par Julie" })).toBe("ok");
    expect(await owner(`select visit_id, first_channel, declared_source, counted from site_conversions`)).toEqual([{ visit_id: null, first_channel: null, declared_source: "Recommandation", counted: true }]);
    // aucune source mesurée : la source de la fiche reste vide plutôt que devinée
    expect(await owner(`select source_id from companies`)).toEqual([{ source_id: null }]);
  });

  test("rendez-vous annulé : il n'est plus compté, l'attribution reste lisible", async () => {
    await visit(V1, "/", { visit: LINKEDIN });
    const b = await book();
    await attach(b.id, { visit: V1 });
    await db.rpc("appt_cancel", { p_id: b.id, p_reason: "Empêchement", p_server_key: KEY, p_token_hash: sha(b.token) });
    expect(await owner(`select counted, booking_status from site_conversions`)).toEqual([{ counted: false, booking_status: "cancelled" }]);
  });
});

describe("fiche existante", () => {
  test("prospect déjà connu : le rendez-vous et les visites rejoignent sa fiche ; une source saisie à la main n'est jamais remplacée", async () => {
    await db.as("owner");
    const source = (await db.one<{ id: string }>(`select id from lead_sources where name = 'Recommandation'`)).id;
    const acme = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "[TEST] Acme", source_id: source }, p_people: [{ first_name: "Paul", email: "paul@acme.example.test" }] })).id;
    await db.as("anon");
    await visit(V1, "/", { visitor_id: U1, visit: { channel: "organic", source: "google" } });
    const b = await book({ email: "paul@acme.example.test", company: "Acme" });
    await attach(b.id, { visit: V1 });
    expect(await owner(`select fiche_company_id from site_conversions`)).toEqual([{ fiche_company_id: acme }]);
    expect(await owner(`select count(*)::int as n from companies`)).toEqual([{ n: 1 }]);
    expect(await owner(`select source_id from companies`)).toEqual([{ source_id: source }]);
  });

  test("fiche rattachée à la main plus tard : la source vide est remplie à ce moment-là, sans doublon de source", async () => {
    await db.as("owner");
    const acme = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "[TEST] Acme" }, p_people: [{ first_name: "Paul", email: "paul@acme.example.test" }] })).id;
    await db.as("anon");
    await visit(V1, "/", { visit: { channel: "ai", source: "chatgpt" } });
    await visit(V2, "/", { visit: { channel: "ai", source: "perplexity" } });
    // même domaine professionnel, autre personne : le CRM demande de choisir la fiche
    const b = await book({ email: "nina@acme.example.test", company: "Acme" });
    await attach(b.id, { visit: V1 });
    expect(await owner(`select crm_status from appt_bookings`)).toEqual([{ crm_status: "to_link" }]);
    expect(await owner(`select source_id from companies`)).toEqual([{ source_id: null }]);
    await db.as("owner");
    await db.rpc("appt_link_booking", { p_id: b.id, p_company: acme, p_person: null, p_add_person: true });
    expect((await db.query(`select s.name from companies c join lead_sources s on s.id = c.source_id`)).rows).toEqual([{ name: "IA générative" }]);
    expect((await db.query(`select fiche_company_id from site_conversions`)).rows).toEqual([{ fiche_company_id: acme }]);
    expect((await db.query(`select count(*)::int as n from lead_sources where name = 'IA générative'`)).rows).toEqual([{ n: 1 }]);
  });
});

describe("Aujourd'hui : un prospect identifié revient sur le site", () => {
  test("retour après le rendez-vous, page à forte intention en tête ; visiteur anonyme ou visite d'avant : rien", async () => {
    await visit(V1, "/", { visitor_id: U1, visit: LINKEDIN });
    const b = await book();
    await attach(b.id, { visit: V1 });
    await ago(V1, "3 days");
    await db.exec(`reset role; update site_attributions set converted_at = now() - interval '3 days';`);
    await db.as("owner");
    expect(await db.rpc("site_return_signals", { p_days: 7 })).toEqual([]);
    await db.as("anon");
    await visit(V2, "/actualites/referencement-ia", { visitor_id: U1 });
    await visit(V2, "/services/offre-decouverte", { visitor_id: U1 });
    await visit(V3, "/services", {}); // anonyme : jamais relié à une fiche
    await db.as("owner");
    const s = await db.rpc<Record<string, unknown>[]>("site_return_signals", { p_days: 7 });
    expect(s).toMatchObject([{ company_name: "[TEST] Atelier", visits: 1, intent: true, intent_page: "/services/offre-decouverte" }]);
    await db.as("stranger");
    expect(await db.rpc("site_return_signals", { p_days: 7 })).toEqual([]);
  });
});

describe("droits", () => {
  test("anonyme et autre compte : ni attribution, ni parcours, ni vue ; identifiant de fiche manipulé sans effet", async () => {
    await visit(V1, "/", { visitor_id: U1, visit: LINKEDIN });
    const b = await book();
    await attach(b.id, { visit: V1 });
    const company = (await owner<{ id: string }>(`select id from companies`))[0].id;
    for (const t of ["site_attributions", "site_conversions", "site_identified"]) await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_company_journey", { p_company: company })).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_return_signals", { p_days: 7 })).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    for (const t of ["site_attributions", "site_conversions", "site_identified"]) expect((await db.query(`select * from ${t}`)).rows).toEqual([]);
    expect(await db.rpc("site_company_journey", { p_company: company })).toMatchObject({ first: null, visits: [], bookings: [], declared: [] });
    await expect(db.query(`update site_attributions set first_channel = 'direct'`)).rejects.toThrow(/permission denied/);
    await db.as("owner");
    expect(await db.rpc<{ visits: unknown[] }>("site_company_journey", { p_company: company })).toMatchObject({ visits: [{ id: V1 }], bookings: [{ counted: true }] });
  });
});
