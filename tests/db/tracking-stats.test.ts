// Tracking site · lots 6 et 7 : agrégats calculés en base (période, comparaison, filtres), rendez-vous annulés
// retirés des comptes, niveaux Search Console / Bing jamais additionnés, recommandations, lecture réservée au propriétaire.
import { beforeAll, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const at = (n: number) => `${day(n)}T10:00:00Z`;
let seq = 0;
const id = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const TO = day(0), FROM = day(29);

async function visit(o: { ago: number; channel: string; source?: string; campaign?: string; pages?: string[]; cta?: boolean; country?: string; device?: string; visitor?: string; referrer?: string }) {
  const v = id();
  const pages = o.pages ?? ["/"];
  await db.query(
    `insert into site_visits (id, visitor_id, started_at, last_seen_at, channel, source, referrer_host, utm_source, utm_medium, utm_campaign, country, device, entry_page, exit_page, pageviews, duration_s, cta_clicks)
     values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [v, o.visitor ?? null, at(o.ago), o.channel, o.source ?? null, o.referrer ?? null, o.campaign ? o.source : null, o.campaign ? "post" : null, o.campaign ?? null,
      o.country ?? "FR", o.device ?? "desktop", pages[0], pages.at(-1), pages.length, pages.length * 30, o.cta ? 1 : 0]);
  for (const p of pages) await db.query(`insert into site_pageviews (id, visit_id, at, path, duration_s, scroll_pct) values ($1, $2, $3, $4, 30, 60)`, [id(), v, at(o.ago), p]);
  return v;
}
const convert = (v: string, ago: number, o: { first?: string; declared?: string } = {}) => db.query(
  `insert into site_attributions (visit_id, converted_at, first_channel, first_source, first_campaign, last_channel, last_source, last_campaign, declared_source, demo)
   select id, $2, coalesce($3, channel), source, utm_campaign, channel, source, utm_campaign, $4, true from site_visits where id = $1`, [v, at(ago), o.first ?? null, o.declared ?? null]);
const report = <T,>(fn: string, f: Record<string, string> = {}, from = FROM, to = TO) => db.rpc<T>(fn, { p_from: from, p_to: to, p_f: f });

beforeAll(async () => {
  db = await createDb();
  await db.exec(`reset role;`);
  // période en cours : 6 visites, 2 rendez-vous ; période précédente : 2 visites
  const li = await visit({ ago: 3, channel: "campaign", source: "linkedin", campaign: "lancement", pages: ["/services", "/contact"], cta: true, country: "BE", device: "mobile" });
  await visit({ ago: 3, channel: "campaign", source: "linkedin", campaign: "lancement", pages: ["/services"] });
  const go = await visit({ ago: 5, channel: "organic", source: "google", pages: ["/growth", "/services"], cta: true });
  await visit({ ago: 6, channel: "ai", source: "chatgpt", pages: ["/growth"] });
  await visit({ ago: 7, channel: "referral", source: "malt.fr", referrer: "malt.fr", pages: ["/"] });
  await visit({ ago: 0, channel: "direct", pages: ["/"] });
  await visit({ ago: 40, channel: "organic", source: "google", pages: ["/"] });
  await visit({ ago: 41, channel: "direct", pages: ["/"] });
  await convert(li, 3, { declared: "LinkedIn" });
  await convert(go, 5, { first: "campaign", declared: "Recommandation" });
  await db.query(`insert into site_utm_links (name, path, utm_source, utm_medium, utm_campaign, url) values ('Post de lancement', '/services', 'linkedin', 'post', 'lancement', 'https://www.celygrowth.com/services?x')`);
  await db.query(`insert into site_bot_hits (day, bot, kind, status, path, hits) values ($1, 'GPTBot', 'ai', 'verified', '/growth', 4), ($1, 'GPTBot', 'ai', 'unverified', '/services', 9), ($1, 'Googlebot', 'search', 'verified', '/', 2)`, [day(2)]);
  // Search Console : page × requête uniquement ; Bing : quatre niveaux
  await db.query(`insert into seo_daily (provider, day, page, query, clicks, impressions, position) values
    ('gsc', $1, '/growth', 'growth marketing', 4, 100, 8), ('gsc', $1, '/services', 'growth marketing', 1, 100, 12), ('gsc', $1, '/growth', 'head of growth', 2, 50, 4),
    ('bing', $1, '', '', 9, 300, null), ('bing', $1, '', 'growth marketing', 3, 80, 6), ('bing', $1, '/growth', '', 5, 120, 7), ('bing', $1, '/growth', 'growth marketing', 2, 40, 6)`, [day(4)]);
  await db.as("owner");
});

describe("Vue d'ensemble", () => {
  test("chiffres clés, période précédente de même durée, courbe sans trou", async () => {
    const o = await report<{ kpis: Record<string, number>; previous: Record<string, number>; previous_from: string; previous_to: string; series: { bucket: string; points: { d: string; visits: number; by: Record<string, number> }[] } }>("site_stats_overview");
    expect(o.kpis).toMatchObject({ visits: 6, visitors: 6, bookings: 2, ai_visits: 1, cta_visits: 2, rate: 33.33 });
    expect(o.previous).toMatchObject({ visits: 2, bookings: 0 });
    expect([o.previous_from, o.previous_to]).toEqual([day(59), day(30)]);
    expect(o.series.bucket).toBe("day");
    expect(o.series.points).toHaveLength(30);
    expect(o.series.points.reduce((n, p) => n + p.visits, 0)).toBe(6);
    expect(o.series.points.find((p) => p.visits === 2)?.by).toEqual({ campaign: 2 });
  });
  test("filtres : source, campagne, page, pays, appareil ; rendez-vous filtrés avec leur visite", async () => {
    const k = async (f: Record<string, string>) => (await report<{ kpis: { visits: number; bookings: number } }>("site_stats_overview", f)).kpis;
    expect(await k({ channel: "campaign" })).toMatchObject({ visits: 2, bookings: 1 });
    expect(await k({ campaign: "lancement", country: "BE" })).toMatchObject({ visits: 1, bookings: 1 });
    expect(await k({ page: "/services" })).toMatchObject({ visits: 3, bookings: 2 });
    expect(await k({ device: "mobile" })).toMatchObject({ visits: 1, bookings: 1 });
    expect(await k({ channel: "ai" })).toMatchObject({ visits: 1, bookings: 0 });
  });
  test("une seule journée, une année entière, une période vide : toujours une réponse lisible", async () => {
    const one = await report<{ kpis: { visits: number }; series: { points: unknown[] } }>("site_stats_overview", {}, day(3), day(3));
    expect(one.kpis.visits).toBe(2);
    expect(one.series.points).toHaveLength(1);
    const year = await report<{ series: { bucket: string; points: unknown[] } }>("site_stats_overview", {}, day(364), TO);
    expect(year.series.bucket).toBe("week");
    expect(year.series.points.length).toBeGreaterThanOrEqual(52);
    expect(year.series.points.length).toBeLessThanOrEqual(54);
    const empty = await report<{ kpis: Record<string, number>; series: { points: { visits: number }[] } }>("site_stats_overview", {}, "2020-01-01", "2020-01-07");
    expect(empty.kpis).toMatchObject({ visits: 0, bookings: 0, rate: 0 });
    expect(empty.series.points).toHaveLength(7);
  });
});

describe("onglets", () => {
  test("Sources : première et dernière source, référents, déclaré contre mesuré", async () => {
    const r = await report<{ channels: { channel: string; visits: number; bookings_first: number; bookings_last: number; previous_visits: number }[]; referrers: { host: string; visits: number }[]; declared: { declared: string; measured: string; n: number }[] }>("site_stats_sources");
    const ch = (c: string) => r.channels.find((x) => x.channel === c);
    expect(r.channels).toHaveLength(8);
    expect(ch("campaign")).toMatchObject({ visits: 2, bookings_first: 2, bookings_last: 1 });
    expect(ch("organic")).toMatchObject({ visits: 1, bookings_first: 0, bookings_last: 1, previous_visits: 1 });
    expect(r.referrers).toEqual([expect.objectContaining({ host: "malt.fr", visits: 1 })]);
    expect(r.declared).toEqual(expect.arrayContaining([{ declared: "LinkedIn", measured: "campaign", n: 1 }, { declared: "Recommandation", measured: "campaign", n: 1 }]));
  });
  test("Campagnes : visites comptées même sans rendez-vous, lien du générateur rapproché par ses UTM", async () => {
    const r = await report<{ campaigns: Record<string, unknown>[]; links: Record<string, unknown>[]; top: string[] }>("site_stats_campaigns");
    expect(r.campaigns).toMatchObject([{ campaign: "lancement", visits: 2, visitors: 2, pageviews: 3, bookings: 1, bookings_first: 1 }]);
    expect(r.links).toMatchObject([{ name: "Post de lancement", visits: 2, pageviews: 3, bookings: 1 }]);
    expect(r.top).toEqual(["lancement"]);
  });
  test("Pages : entrées, sorties, pages qui convertissent", async () => {
    const r = await report<{ pages: Record<string, unknown>[] }>("site_stats_pages");
    const p = (path: string) => r.pages.find((x) => x.path === path);
    expect(p("/services")).toMatchObject({ views: 3, visits: 3, entries: 2, exits: 2, bookings: 2, bounces: 1 });
    expect(p("/growth")).toMatchObject({ views: 2, entries: 2, exits: 1, bookings: 1 });
    expect(p("/contact")).toMatchObject({ entries: 0, exits: 1, exit_rate: 100 });
  });
  test("IA : visites par moteur ; robots non vérifiés à part ; pages jamais lues par un robot d'IA", async () => {
    const r = await report<{ engines: Record<string, unknown>[]; bots: Record<string, unknown>[]; bot_pages: Record<string, unknown>[]; unread: { path: string }[] }>("site_stats_ai");
    expect(r.engines).toMatchObject([{ source: "chatgpt", visits: 1, bookings: 0 }]);
    expect(r.bots.find((b) => b.bot === "GPTBot")).toMatchObject({ hits: 13, verified: 4, unverified: 9, pages: 2 });
    // un passage non vérifié (nom usurpé) ne compte pas comme une lecture de la page
    expect(r.bot_pages.filter((b) => b.bot === "GPTBot")).toMatchObject([{ path: "/growth", hits: 4 }]);
    expect(r.unread.map((u) => u.path)).toEqual(expect.arrayContaining(["/services", "/"]));
    expect(r.unread.map((u) => u.path)).not.toContain("/growth");
  });
  test("Géographie et Prospects", async () => {
    const g = await report<{ countries: Record<string, unknown>[]; devices: Record<string, unknown>[] }>("site_stats_geo");
    expect(g.countries).toEqual(expect.arrayContaining([expect.objectContaining({ country: "BE", visits: 1, bookings: 1 }), expect.objectContaining({ country: "FR", visits: 5, bookings: 1 })]));
    expect(g.devices).toEqual(expect.arrayContaining([expect.objectContaining({ device: "mobile", visits: 1, bookings: 1 })]));
    const p = await report<{ prospects: { first: { channel: string }; last: { channel: string }; booked: boolean; visits: number }[] }>("site_stats_prospects");
    expect(p.prospects).toHaveLength(2);
    expect(p.prospects.map((x) => `${x.first.channel}>${x.last.channel}`).sort()).toEqual(["campaign>campaign", "campaign>organic"]);
  });
  test("SEO : les niveaux de Bing ne sont jamais additionnés ; position pondérée ; page → rendez-vous", async () => {
    const r = await report<{ totals: { clicks: number; impressions: number }; queries: Record<string, unknown>[]; pages: Record<string, unknown>[] }>("site_stats_seo");
    // Search Console : 4 + 1 + 2 ; Bing : le niveau site seulement
    expect(r.totals).toMatchObject({ clicks: 16, impressions: 550 });
    expect(r.queries.find((q) => q.provider === "gsc" && q.query === "growth marketing")).toMatchObject({ clicks: 5, impressions: 200, position: 10, page: "/growth", page_bookings: 1 });
    expect(r.queries.find((q) => q.provider === "bing" && q.query === "growth marketing")).toMatchObject({ clicks: 3, impressions: 80 });
    expect(r.pages.find((p) => p.provider === "bing" && p.page === "/growth")).toMatchObject({ clicks: 5, impressions: 120 });
    expect(r.pages.find((p) => p.provider === "gsc" && p.page === "/growth")).toMatchObject({ clicks: 6, queries: 2, visits: 1, bookings: 1 });
    const one = await report<{ positions: { by: Record<string, number> }[]; totals: { clicks: number } }>("site_stats_seo", { query: "growth marketing", provider: "gsc" });
    expect(one.totals.clicks).toBe(7);
    expect(one.positions.filter((p) => p.by.gsc).map((p) => p.by.gsc)).toEqual([10]);
  });
});

describe("rendez-vous annulé ou replanifié", () => {
  test("un rendez-vous annulé sort des statistiques ; la visite reste comptée", async () => {
    await db.exec(`reset role;`);
    const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
    const type = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Appel', 'appel', 30, $1) returning id`, [sched])).id;
    const b = (await db.one<{ id: string }>(
      `insert into appt_bookings (event_type_id, status, starts_at, ends_at, schedule_timezone, invitee_timezone, first_name, last_name, email, email_norm, event_snapshot, manage_token_hash, idempotency_key)
       values ($1, 'confirmed', now() + interval '3 days', now() + interval '3 days 30 minutes', 'Europe/Paris', 'Europe/Paris', 'Léa', 'Test', 'lea@example.test', 'lea@example.test', '{"name":"Appel"}', repeat('a', 64), 'k-annule-0001') returning id`, [type])).id;
    const v = await visit({ ago: 1, channel: "email", source: "mail.google.com", pages: ["/contact"] });
    await db.query(`insert into site_attributions (booking_id, visit_id, converted_at, first_channel, last_channel) values ($1, $2, $3, 'email', 'email')`, [b, v, at(1)]);
    await db.as("owner");
    const k = async () => (await report<{ kpis: { visits: number; bookings: number } }>("site_stats_overview", { channel: "email" })).kpis;
    expect(await k()).toEqual(expect.objectContaining({ visits: 1, bookings: 1 }));
    // replanifié : même rendez-vous, nouvelle date ; toujours un seul rendez-vous compté
    await db.exec(`reset role; update appt_bookings set starts_at = starts_at + interval '2 days', ends_at = ends_at + interval '2 days';`);
    await db.as("owner");
    expect(await k()).toEqual(expect.objectContaining({ visits: 1, bookings: 1 }));
    await db.exec(`reset role; update appt_bookings set status = 'cancelled';`);
    await db.as("owner");
    expect(await k()).toEqual(expect.objectContaining({ visits: 1, bookings: 0 }));
    const p = await report<{ prospects: { counted: boolean; booking_status: string | null }[] }>("site_stats_prospects", { channel: "email" });
    expect(p.prospects).toMatchObject([{ counted: false, booking_status: "cancelled" }]);
  });
});

describe("À faire", () => {
  test("mot-clé à pousser, connecteurs à brancher, source en baisse ; chaque action porte son détail", async () => {
    await db.exec(`reset role;`);
    await db.query(`insert into seo_daily (provider, day, page, query, clicks, impressions, position) values ('gsc', $1, '/audit', 'audit marketing', 1, 400, 9)`, [day(2)]);
    for (let i = 0; i < 24; i++) await visit({ ago: 45, channel: "social", source: "linkedin", pages: ["/"] });
    for (let i = 0; i < 12; i++) await visit({ ago: 2, channel: "social", source: "linkedin", pages: ["/manifeste"] });
    await db.as("owner");
    const r = await db.rpc<{ kind: string; data: Record<string, unknown> }[]>("site_recommendations", { p_from: FROM, p_to: TO });
    const of = (kind: string) => r.filter((x) => x.kind === kind).map((x) => x.data);
    expect(of("connector")).toEqual([{ provider: "gsc", status: "missing" }, { provider: "bing", status: "missing" }]);
    expect(of("keyword")).toEqual(expect.arrayContaining([expect.objectContaining({ query: "audit marketing", position: 9, impressions: 400 })]));
    expect(of("keyword").some((k) => k.query === "head of growth")).toBe(false); // déjà en position 4
    expect(of("trend")).toEqual(expect.arrayContaining([expect.objectContaining({ scope: "channel", name: "social", visits: 12, previous: 24, change: -50 })]));
    expect(of("untagged")).toEqual([expect.objectContaining({ channel: "social", source: "linkedin", visits: 12 })]);
    expect(of("ai_unread")).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/manifeste" })]));
  });
});

describe("droits", () => {
  const FNS = ["site_stats_overview", "site_stats_sources", "site_stats_campaigns", "site_stats_pages", "site_stats_prospects", "site_stats_seo", "site_stats_ai", "site_stats_geo"];
  test("anonyme : aucune fonction de lecture, aucune vue", async () => {
    await db.as("anon");
    for (const fn of FNS) await expect(report(fn)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_live", {})).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_recommendations", { p_from: FROM, p_to: TO })).rejects.toThrow(/permission denied/);
    for (const v of ["seo_queries", "seo_pages", "seo_totals", "seo_daily"]) await expect(db.query(`select * from ${v}`)).rejects.toThrow(/permission denied/);
    await db.as("owner");
  });
  test("autre compte connecté : des agrégats vides, quels que soient la période et les filtres demandés", async () => {
    await db.as("stranger");
    const o = await report<{ kpis: Record<string, number>; has_data: boolean }>("site_stats_overview", { channel: "campaign", campaign: "lancement" });
    expect(o).toMatchObject({ has_data: false, kpis: { visits: 0, visitors: 0, bookings: 0 } });
    expect((await report<{ campaigns: unknown[]; links: unknown[] }>("site_stats_campaigns"))).toMatchObject({ campaigns: [], links: [] });
    expect((await report<{ prospects: unknown[] }>("site_stats_prospects")).prospects).toEqual([]);
    expect((await report<{ queries: unknown[]; has_data: boolean; connections: unknown[] }>("site_stats_seo"))).toMatchObject({ queries: [], has_data: false, connections: [] });
    expect((await report<{ bots: unknown[]; engines: unknown[] }>("site_stats_ai"))).toMatchObject({ bots: [], engines: [] });
    expect(await db.rpc("site_live", {})).toMatchObject({ visitors: 0 });
    expect((await db.rpc<{ kind: string }[]>("site_recommendations", { p_from: FROM, p_to: TO })).filter((r) => r.kind !== "connector")).toEqual([]);
    expect(await db.rpc("site_filter_options", {})).toEqual({ campaigns: [], pages: [], countries: [] });
    await db.as("owner");
  });
});
