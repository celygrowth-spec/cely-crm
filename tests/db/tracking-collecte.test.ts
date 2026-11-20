// Tracking site · collecte : le point public n'écrit que des événements, par la clé serveur ; lecture réservée au
// propriétaire ; aucun doublon ; consentement donné puis retiré ; exclusion du propriétaire ; limite d'abus ; robots.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const V1 = id(1), V2 = id(2), U1 = id(100);
let db: Db;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
  await db.as("anon");
});

const collect = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  db.rpc<string>("site_collect", { p_server_key: KEY, p_event: event, ...extra });
const pv = (visit: string, n: number, path: string, more: Record<string, unknown> = {}) =>
  collect({ type: "pv", visit_id: visit, pageview_id: id(n), path, ...more });
const asOwner = async <T>(sql: string) => {
  await db.as("owner");
  const rows = (await db.query<T>(sql)).rows;
  await db.as("anon");
  return rows;
};
const LINKEDIN = { channel: "campaign", source: "linkedin", utm_source: "linkedin", utm_medium: "social", utm_campaign: "lancement", utm_raw: { utm_source: "LinkedIn" }, country: "FR", device: "mobile", browser: "Safari" };

describe("visite anonyme", () => {
  test("pages, temps passé, défilement, entrée et sortie ; aucune donnée identifiante", async () => {
    expect(await pv(V1, 10, "/services", { visit: LINKEDIN })).toBe("ok");
    expect(await pv(V1, 11, "/contact")).toBe("ok");
    expect(await collect({ type: "pe", visit_id: V1, pageview_id: id(10), duration_s: 40, scroll_pct: 80 })).toBe("ok");
    // mise à jour du même écran : le temps n'est pas compté deux fois
    expect(await collect({ type: "pe", visit_id: V1, pageview_id: id(10), duration_s: 65, scroll_pct: 60 })).toBe("ok");
    expect(await collect({ type: "pe", visit_id: V1, pageview_id: id(11), duration_s: 20, scroll_pct: 30 })).toBe("ok");
    const [v] = await asOwner<Record<string, unknown>>(`select * from site_visits`);
    expect(v).toMatchObject({
      visitor_id: null, channel: "campaign", source: "linkedin", utm_campaign: "lancement", utm_raw: { utm_source: "LinkedIn" }, country: "FR",
      device: "mobile", entry_page: "/services", exit_page: "/contact", pageviews: 2, duration_s: 85, max_scroll: 80, is_returning: false,
    });
    expect(Object.keys(v).some((k) => /ip|email|agent/.test(k))).toBe(false);
    expect(await asOwner(`select * from site_visitors`)).toEqual([]);
  });

  test("renvoi du même événement (double clic, nouvel essai) : aucun doublon", async () => {
    await pv(V1, 10, "/", { visit: LINKEDIN });
    await pv(V1, 10, "/", { visit: LINKEDIN });
    const cta = { type: "cta", visit_id: V1, event_id: id(20), path: "/", label: "Prendre rendez-vous" };
    expect(await collect(cta)).toBe("ok");
    expect(await collect(cta)).toBe("ok");
    const form = { type: "form", visit_id: V1, event_id: id(21), path: "/contact", label: "contact", declared_source: "LinkedIn", email: "lea@example.test" };
    await collect(form);
    await collect(form);
    expect(await asOwner(`select pageviews, cta_clicks, forms from site_visits`)).toEqual([{ pageviews: 1, cta_clicks: 1, forms: 1 }]);
    expect(await asOwner(`select kind, declared_source from site_events order by kind`)).toEqual([{ kind: "cta", declared_source: null }, { kind: "form", declared_source: "LinkedIn" }]);
    // sans consentement, l'adresse du formulaire n'est rattachée à rien
    expect(await asOwner(`select * from site_visitors`)).toEqual([]);
  });

  test("événement sans visite ouverte, identifiant illisible ou valeur aberrante : ignoré sans erreur", async () => {
    expect(await collect({ type: "cta", visit_id: V1, event_id: id(20), path: "/" })).toBe("ignored");
    expect(await collect({ type: "pv", visit_id: "pas-un-uuid", pageview_id: id(1), path: "/" })).toBe("ignored");
    await pv(V1, 10, "/");
    expect(await collect({ type: "pe", visit_id: V1, pageview_id: id(10), duration_s: "beaucoup", scroll_pct: 10 })).toBe("ignored");
    expect(await collect({ type: "pe", visit_id: V1, pageview_id: id(10), duration_s: 999999, scroll_pct: 900 })).toBe("ok");
    expect(await asOwner(`select duration_s, max_scroll from site_visits`)).toEqual([{ duration_s: 3600, max_scroll: 100 }]);
    expect(await collect({ type: "supprimer_tout", visit_id: V1 })).toBe("ignored");
    // une source inconnue ne casse rien : la visite est classée en direct
    await pv(V2, 30, "/", { visit: { channel: "n'importe quoi", country: "france", device: "frigo" } });
    expect(await asOwner(`select channel, country, device from site_visits where id = '${V2}'`)).toEqual([{ channel: "direct", country: null, device: "desktop" }]);
  });
});

describe("consentement", () => {
  test("accepté en cours de visite : le rattachement commence là ; visite suivante = visiteur récurrent", async () => {
    await pv(V1, 10, "/services", { visit: LINKEDIN });
    expect(await collect({ type: "consent", visit_id: V1, visitor_id: U1 })).toBe("ok");
    await pv(V2, 11, "/", { visitor_id: U1, visit: { channel: "direct" } });
    expect(await asOwner(`select id, visitor_id, channel, is_returning from site_visits order by started_at, id`)).toEqual([
      { id: V1, visitor_id: U1, channel: "campaign", is_returning: false },
      { id: V2, visitor_id: U1, channel: "direct", is_returning: true },
    ]);
    const [u] = await asOwner<{ months: number }>(`select round(extract(epoch from (expires_at - first_seen_at)) / 86400 / 30.4)::int as months from site_visitors`);
    expect(u.months).toBe(13);
  });

  test("formulaire d'un visiteur consentant : son adresse permet de retrouver sa fiche", async () => {
    await pv(V1, 10, "/contact", { visitor_id: U1 });
    await collect({ type: "form", visit_id: V1, event_id: id(21), path: "/contact", email: " Lea@Example.test " });
    expect(await asOwner(`select email_norm from site_visitors`)).toEqual([{ email_norm: "lea@example.test" }]);
  });

  test("retiré : l'identifiant est supprimé, ses visites restent comptées mais anonymes", async () => {
    await pv(V1, 10, "/", { visitor_id: U1, visit: LINKEDIN });
    await pv(V2, 11, "/", { visitor_id: U1 });
    // seul le navigateur qui porte l'identifiant sur une de ses visites peut le retirer
    expect(await collect({ type: "withdraw", visit_id: V2, visitor_id: id(999) })).toBe("ignored");
    expect(await collect({ type: "withdraw", visit_id: V2, visitor_id: U1 })).toBe("ok");
    expect(await asOwner(`select * from site_visitors`)).toEqual([]);
    expect(await asOwner(`select visitor_id, utm_campaign from site_visits order by id`)).toEqual([
      { visitor_id: null, utm_campaign: "lancement" }, { visitor_id: null, utm_campaign: null }]);
  });

  test("identifiant de plus de 13 mois : plus rattaché, puis purgé", async () => {
    await pv(V1, 10, "/", { visitor_id: U1 });
    await db.exec(`reset role; update site_visitors set expires_at = now() - interval '1 day'`);
    await db.as("anon");
    await pv(V2, 11, "/", { visitor_id: U1 });
    expect(await asOwner(`select visitor_id from site_visits where id = '${V2}'`)).toEqual([{ visitor_id: null }]);
    expect(await db.rpc("site_purge", { p_server_key: KEY })).toBe(1);
    expect(await asOwner(`select count(*)::int as n from site_visits`)).toEqual([{ n: 2 }]);
  });
});

describe("exclusions et abus", () => {
  test("connexion du propriétaire : ses visites ne sont pas comptées", async () => {
    await db.as("owner");
    await db.rpc("site_exclude_ip", { p_ip_hash: "empreinte-du-proprietaire-0001" });
    await db.as("anon");
    expect(await pv(V1, 10, "/", {}, )).toBe("ok");
    expect(await collect({ type: "pv", visit_id: V2, pageview_id: id(11), path: "/" }, { p_ip_hash: "empreinte-du-proprietaire-0001" })).toBe("excluded");
    expect(await asOwner(`select id from site_visits`)).toEqual([{ id: V1 }]);
  });

  test("au-delà de 90 événements par minute pour une même connexion : refusé", async () => {
    let last = "";
    for (let i = 0; i < 92; i++) last = await collect({ type: "pv", visit_id: V1, pageview_id: id(1000 + i), path: "/" }, { p_rate_hash: "abuseur" });
    expect(last).toBe("rate_limited");
    // une autre connexion n'est pas pénalisée
    expect(await collect({ type: "pv", visit_id: V2, pageview_id: id(5000), path: "/" }, { p_rate_hash: "autre" })).toBe("ok");
    expect(await asOwner(`select pageviews from site_visits where id = '${V1}'`)).toEqual([{ pageviews: 90 }]);
  });
});

describe("robots", () => {
  test("un compteur par jour, robot, statut et page", async () => {
    const hit = (bot: string, kind: string, status: string, path: string) => db.rpc("site_bot_hit", { p_server_key: KEY, p_bot: bot, p_kind: kind, p_status: status, p_path: path });
    await hit("GPTBot", "ai", "verified", "/services");
    await hit("GPTBot", "ai", "verified", "/services");
    await hit("GPTBot", "ai", "unverified", "/services");
    await hit("Googlebot", "search", "verified", "/");
    expect(await asOwner(`select bot, kind, status, path, hits from site_bot_hits order by bot, status`)).toEqual([
      { bot: "GPTBot", kind: "ai", status: "unverified", path: "/services", hits: 1 },
      { bot: "GPTBot", kind: "ai", status: "verified", path: "/services", hits: 2 },
      { bot: "Googlebot", kind: "search", status: "verified", path: "/", hits: 1 },
    ]);
    expect(await asOwner(`select count(*)::int as n from site_visits`)).toEqual([{ n: 0 }]);
    await expect(hit("X", "inconnu", "verified", "/")).rejects.toThrow(/check constraint/);
  });
});

describe("droits", () => {
  test("mauvaise clé serveur : rien n'est écrit", async () => {
    for (const fn of ["site_collect", "site_bot_hit", "site_purge"]) {
      const args = fn === "site_collect" ? { p_event: { type: "pv", visit_id: V1, pageview_id: id(1), path: "/" } }
        : fn === "site_bot_hit" ? { p_bot: "GPTBot", p_kind: "ai", p_status: "verified", p_path: "/" } : {};
      await expect(db.rpc(fn, { p_server_key: "x".repeat(40), ...args })).rejects.toThrow(/Accès refusé/);
    }
  });

  test("anonyme et autre compte : aucune lecture, aucune écriture directe, pas d'exclusion", async () => {
    await pv(V1, 10, "/", { visitor_id: U1, visit: LINKEDIN });
    const tables = ["site_visits", "site_pageviews", "site_events", "site_visitors", "site_bot_hits", "site_rate", "site_excluded_ips"];
    for (const t of tables) await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from site_visits`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_exclude_ip", { p_ip_hash: "empreinte-quelconque-0001" })).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    for (const t of ["site_visits", "site_pageviews", "site_events", "site_visitors", "site_bot_hits"]) {
      expect((await db.query(`select * from ${t}`)).rows).toEqual([]);
    }
    for (const t of ["site_rate", "site_excluded_ips"]) await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/);
    // identifiant manipulé : lire une visite précise ne donne rien non plus
    expect((await db.query(`select * from site_visits where id = $1`, [V1])).rows).toEqual([]);
    await expect(db.query(`update site_visits set channel = 'direct'`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into site_visits (id, entry_page, exit_page) values ($1, '/', '/')`, [V2])).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_exclude_ip", { p_ip_hash: "empreinte-quelconque-0001" })).rejects.toThrow();
    // le propriétaire lit, sans pouvoir modifier à la main
    await db.as("owner");
    expect((await db.query(`select id from site_visits`)).rows).toEqual([{ id: V1 }]);
    await expect(db.query(`delete from site_visits`)).rejects.toThrow(/permission denied/);
  });
});
