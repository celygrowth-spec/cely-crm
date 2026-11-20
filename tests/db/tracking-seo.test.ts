// Search Console et Bing : tables réservées au propriétaire, secrets hors de portée du navigateur, fonctions à clé
// serveur, écriture sans doublon, reprise par curseur, listes autorisées complétées (vérifications, passage « seo »).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
const BAD = "mauvaise-cle-mais-assez-longue-0123456789abcdef";
const SITE = "sc-domain:celygrowth.com";
const ENC = "v1.aaaa.bbbb.cccc";
let db: Db;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
});

const connect = (provider = "gsc", site: string | null = SITE, sites: string[] = [SITE, "https://autre.example/"]) =>
  db.rpc("seo_connect", { p_provider: provider, p_secret_enc: ENC, p_account_label: null, p_site_url: site, p_sites: JSON.stringify(sites) });
const upsert = (rows: unknown[], extra: Record<string, unknown> = {}) =>
  db.rpc<number>("seo_server_upsert", { p_server_key: KEY, p_provider: "gsc", p_rows: JSON.stringify(rows), ...extra });
const row = (day: string, page: string, query: string, clicks = 1, impressions = 10, position: number | null = 3.456) => ({ day, page, query, clicks, impressions, position });
const daily = async () => {
  await db.as("owner");
  return (await db.query<{ provider: string; day: string; page: string; query: string; clicks: number; impressions: number; position: string | null; demo: boolean }>(
    `select provider, day::text, page, query, clicks, impressions, position::text, demo from seo_daily order by provider, day, page, query`)).rows;
};

describe("accès", () => {
  test("propriétaire : lit la connexion et les chiffres, jamais le secret ; aucune écriture directe", async () => {
    await connect();
    await upsert([row("2026-11-01", "/services", "agence growth")]);
    expect((await db.query(`select provider, site_url, status from seo_connections`)).rows).toEqual([{ provider: "gsc", site_url: SITE, status: "connected" }]);
    expect((await db.query(`select count(*)::int n from seo_daily`)).rows).toEqual([{ n: 1 }]);
    await expect(db.query(`select * from seo_connection_secrets`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select secret_enc from seo_connection_secrets`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into seo_daily (provider, day) values ('gsc', '2026-11-02')`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`update seo_daily set clicks = 99`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from seo_daily`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`update seo_connections set status = 'connected'`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into seo_connection_secrets (provider, secret_enc) values ('gsc', 'v1.x')`)).rejects.toThrow(/permission denied/);
  });

  test("anonyme et autre compte : ni chiffres, ni connexion, ni secret, ni fonctions du propriétaire", async () => {
    await connect();
    await upsert([row("2026-11-01", "/services", "agence growth")]);
    await db.as("anon");
    for (const t of ["seo_daily", "seo_connections", "seo_connection_secrets"]) await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/);
    for (const [fn, args] of [
      ["seo_connect", { p_provider: "gsc", p_secret_enc: ENC }],
      ["seo_set_site", { p_provider: "gsc", p_site_url: SITE }],
      ["seo_disconnect", { p_provider: "gsc" }],
    ] as const) await expect(db.rpc(fn, args)).rejects.toThrow(/permission denied/);

    await db.as("stranger");
    expect((await db.query(`select * from seo_daily`)).rows).toEqual([]);
    expect((await db.query(`select * from seo_connections`)).rows).toEqual([]);
    await expect(db.query(`select * from seo_connection_secrets`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("seo_connect", { p_provider: "gsc", p_secret_enc: ENC })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("seo_set_site", { p_provider: "gsc", p_site_url: SITE })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("seo_disconnect", { p_provider: "gsc" })).rejects.toThrow(/Accès refusé/);

    // Claude (connecteur MCP, même compte) : les connecteurs se règlent dans l'application
    await db.as("claude");
    await expect(db.rpc("seo_disconnect", { p_provider: "gsc" })).rejects.toThrow(/dans l'application/);
    await db.as("owner");
    expect((await db.query(`select provider from seo_connections`)).rows).toEqual([{ provider: "gsc" }]);
  });

  test("fonctions à clé serveur : mauvaise clé refusée quel que soit le rôle ; bonne clé acceptée sans session", async () => {
    await connect();
    for (const who of ["anon", "stranger", "owner"] as const) {
      await db.as(who);
      await expect(db.rpc("seo_server_connection", { p_server_key: BAD, p_provider: "gsc" })).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("seo_server_upsert", { p_server_key: BAD, p_provider: "gsc", p_rows: "[]" })).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("seo_server_progress", { p_server_key: BAD, p_provider: "gsc", p_cursor: "{}" })).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("seo_server_fail", { p_server_key: BAD, p_provider: "gsc", p_status: "error", p_error: "x" })).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("seo_server_connection", { p_server_key: null, p_provider: "gsc" })).rejects.toThrow(/Accès refusé/);
    }
    await db.as("anon");
    const conn = await db.rpc<{ secret_enc: string; site_url: string; cursor: unknown }>("seo_server_connection", { p_server_key: KEY, p_provider: "gsc" });
    expect(conn).toMatchObject({ secret_enc: ENC, site_url: SITE, cursor: {}, status: "connected" });
    expect(await db.rpc("seo_server_connection", { p_server_key: KEY, p_provider: "bing" })).toBeNull();
    expect(await upsert([row("2026-11-01", "/", "cely")])).toBe(1);
    await expect(db.rpc("seo_server_connection", { p_server_key: KEY, p_provider: "yahoo" })).rejects.toThrow(/Fournisseur inconnu/);
    await expect(db.rpc("seo_server_upsert", { p_server_key: KEY, p_provider: "bing", p_rows: "[]" })).rejects.toThrow(/non connecté/);
  });

  test("un secret en clair est refusé", async () => {
    await expect(db.rpc("seo_connect", { p_provider: "bing", p_secret_enc: "ma-cle-api-en-clair", p_site_url: "https://celygrowth.com/" })).rejects.toThrow(/non chiffré/);
    await expect(db.rpc("seo_connect", { p_provider: "yahoo", p_secret_enc: ENC })).rejects.toThrow(/Fournisseur inconnu/);
  });
});

describe("écriture des chiffres", () => {
  beforeEach(() => connect());

  test("relancer le même lot ne crée aucun doublon et remplace les valeurs", async () => {
    const lot = [row("2026-11-01", "/services", "agence growth", 2, 40, 4.126), row("2026-11-01", "/", "cely", 5, 50, 1), row("2026-11-02", "/", "cely", 1, 9, 1.5)];
    expect(await upsert(lot)).toBe(3);
    expect(await upsert(lot)).toBe(3);
    expect(await upsert([row("2026-11-01", "/services", "agence growth", 3, 44, 3.9)])).toBe(1);
    expect(await daily()).toEqual([
      { provider: "gsc", day: "2026-11-01", page: "/", query: "cely", clicks: 5, impressions: 50, position: "1.00", demo: false },
      { provider: "gsc", day: "2026-11-01", page: "/services", query: "agence growth", clicks: 3, impressions: 44, position: "3.90", demo: false },
      { provider: "gsc", day: "2026-11-02", page: "/", query: "cely", clicks: 1, impressions: 9, position: "1.50", demo: false },
    ]);
  });

  test("la même clé deux fois dans un lot : une seule ligne ; page et requête absentes rangées à vide ; position inconnue", async () => {
    expect(await upsert([row("2026-11-01", "/a", "q", 1, 5), row("2026-11-01", "/a", "q", 2, 8), { day: "2026-11-01", clicks: 7, impressions: 70 }])).toBe(2);
    expect(await daily()).toEqual([
      { provider: "gsc", day: "2026-11-01", page: "", query: "", clicks: 7, impressions: 70, position: null, demo: false },
      { provider: "gsc", day: "2026-11-01", page: "/a", query: "q", clicks: 2, impressions: 8, position: "3.46", demo: false },
    ]);
  });

  test("jour relu (données provisoires) : les lignes disparues chez le fournisseur sont retirées, les autres jours et la démonstration restent", async () => {
    await upsert([row("2026-11-01", "/a", "q1"), row("2026-11-01", "/a", "q2"), row("2026-11-02", "/a", "q1")]);
    await db.exec(`reset role; insert into public.seo_daily (provider, day, page, query, clicks, impressions, demo) values ('gsc', '2026-11-01', '/demo', 'demo', 1, 1, true), ('bing', '2026-11-01', '/a', 'q2', 1, 1, false);`);
    expect(await upsert([row("2026-11-01", "/a", "q1", 9, 90)], { p_replace_days: "{2026-11-01}" })).toBe(1);
    expect((await daily()).map((r) => `${r.provider} ${r.day} ${r.page} ${r.query} ${r.clicks}${r.demo ? " demo" : ""}`)).toEqual([
      "bing 2026-11-01 /a q2 1", "gsc 2026-11-01 /a q1 9", "gsc 2026-11-01 /demo demo 1 demo", "gsc 2026-11-02 /a q1 1",
    ]);
    // une vraie ligne remplace une ligne de démonstration de même clé
    await upsert([row("2026-11-01", "/demo", "demo", 4, 40)]);
    expect((await daily()).find((r) => r.page === "/demo")).toMatchObject({ clicks: 4, demo: false });
  });

  test("lot invalide refusé", async () => {
    await expect(db.rpc("seo_server_upsert", { p_server_key: KEY, p_provider: "gsc", p_rows: JSON.stringify({ day: "2026-11-01" }) })).rejects.toThrow(/Lot invalide/);
    await expect(upsert([{ day: "pas-une-date", page: "/", query: "q" }])).rejects.toThrow();
    expect(await daily()).toEqual([]);
  });
});

describe("curseur et états", () => {
  beforeEach(() => connect());
  const conn = () => db.rpc<{ cursor: Record<string, unknown>; status: string; history_done_at: string | null; last_sync_at: string | null }>("seo_server_connection", { p_server_key: KEY, p_provider: "gsc" });
  const progress = (args: Record<string, unknown>) => db.rpc("seo_server_progress", { p_server_key: KEY, p_provider: "gsc", ...args });

  test("import interrompu : le curseur enregistré est retrouvé tel quel, puis l'historique est marqué terminé une seule fois", async () => {
    await upsert([row("2026-11-10", "/", "cely")]);
    await progress({ p_cursor: JSON.stringify({ floor: "2025-07-18", history_until: "2026-11-09", recent_to: "2026-11-18" }) });
    // interruption : rien d'autre n'est écrit ; le passage suivant relit le curseur
    expect(await conn()).toMatchObject({ cursor: { floor: "2025-07-18", history_until: "2026-11-09", recent_to: "2026-11-18" }, history_done_at: null, last_sync_at: null });
    await upsert([row("2026-11-09", "/", "cely")]);
    await progress({ p_cursor: JSON.stringify({ floor: "2025-07-18", history_until: "2026-11-08", recent_to: "2026-11-18" }), p_synced: true });
    const mid = await conn();
    expect(mid.cursor.history_until).toBe("2026-11-08");
    expect(mid.last_sync_at).not.toBeNull();
    expect(mid.history_done_at).toBeNull();
    // curseur null : inchangé
    await progress({ p_cursor: null, p_history_done: true });
    const done = await conn();
    expect(done.cursor.history_until).toBe("2026-11-08");
    expect(done.history_done_at).not.toBeNull();
    await progress({ p_cursor: null, p_history_done: true });
    expect((await conn()).history_done_at).toBe(done.history_done_at);
    expect((await daily()).map((r) => r.day)).toEqual(["2026-11-09", "2026-11-10"]);
  });

  test("accès refusé par le fournisseur : « à reconnecter » avec son message ; une avance réussie rétablit l'état", async () => {
    await db.rpc("seo_server_fail", { p_server_key: KEY, p_provider: "gsc", p_status: "reconnect", p_error: "Google a refusé l'accès (révoqué ou expiré) : reconnectez Search Console." });
    await db.as("owner");
    expect((await db.query(`select status, last_error from seo_connections`)).rows).toEqual([{ status: "reconnect", last_error: "Google a refusé l'accès (révoqué ou expiré) : reconnectez Search Console." }]);
    await expect(db.rpc("seo_server_fail", { p_server_key: KEY, p_provider: "gsc", p_status: "connected", p_error: "x" })).rejects.toThrow(/État invalide/);
    await db.rpc("seo_server_fail", { p_server_key: KEY, p_provider: "gsc", p_status: "error", p_error: "x".repeat(900) });
    expect((await db.one<{ n: number }>(`select char_length(last_error) n from seo_connections`)).n).toBe(300);
    await progress({ p_cursor: null });
    expect((await db.query(`select status, last_error from seo_connections`)).rows).toEqual([{ status: "connected", last_error: null }]);
  });

  test("reconnexion : même propriété, l'avancement est gardé ; autre propriété, l'import repart de zéro sans toucher la démonstration", async () => {
    await upsert([row("2026-11-10", "/", "cely")]);
    await db.exec(`reset role; insert into public.seo_daily (provider, day, page, query, demo) values ('gsc', '2026-11-10', '/demo', 'demo', true);`);
    await db.as("owner");
    await progress({ p_cursor: JSON.stringify({ floor: "2025-07-18", history_until: "2026-11-09" }), p_history_done: true, p_synced: true });
    await db.rpc("seo_server_fail", { p_server_key: KEY, p_provider: "gsc", p_status: "reconnect", p_error: "révoqué" });
    // nouveau jeton, propriété non imposée : celle déjà choisie est gardée car toujours proposée
    await db.rpc("seo_connect", { p_provider: "gsc", p_secret_enc: "v1.nouveau.jeton.chiffre", p_site_url: null, p_sites: JSON.stringify([SITE, "https://autre.example/"]) });
    const same = await conn();
    expect(same).toMatchObject({ status: "connected", site_url: SITE, secret_enc: "v1.nouveau.jeton.chiffre", cursor: { history_until: "2026-11-09" } });
    expect(same.history_done_at).not.toBeNull();
    expect(await daily()).toHaveLength(2);

    await expect(db.rpc("seo_set_site", { p_provider: "gsc", p_site_url: "https://pirate.example/" })).rejects.toThrow(/ne fait pas partie/);
    await db.rpc("seo_set_site", { p_provider: "gsc", p_site_url: "https://autre.example/" });
    expect(await conn()).toMatchObject({ site_url: "https://autre.example/", cursor: {}, history_done_at: null, last_sync_at: null });
    expect((await daily()).map((r) => r.page)).toEqual(["/demo"]);
  });

  test("déconnexion : connexion et secret effacés, chiffres conservés", async () => {
    await upsert([row("2026-11-10", "/", "cely")]);
    await db.as("owner");
    await db.rpc("seo_disconnect", { p_provider: "gsc" });
    expect(await conn()).toBeNull();
    await db.exec(`reset role;`);
    expect((await db.query(`select 1 from public.seo_connection_secrets`)).rows).toEqual([]);
    expect(await daily()).toHaveLength(1);
  });
});

describe("listes autorisées", () => {
  test("vérifications des deux connecteurs et passage « seo » acceptés, sans retirer les valeurs existantes", async () => {
    for (const key of ["search_console", "bing_webmaster", "gmail", "claude_mcp"]) await db.query(`insert into connector_checks (key, ok, message) values ($1, true, 'ok')`, [key]);
    await expect(db.query(`insert into connector_checks (key, ok) values ('inconnu', true)`)).rejects.toThrow(/check constraint/);
    for (const job of ["seo", "corbeille", "agenda"]) await db.rpc("job_report", { p_server_key: KEY, p_job: job, p_ok: true });
    await expect(db.rpc("job_report", { p_server_key: KEY, p_job: "inconnu", p_ok: true })).rejects.toThrow(/check constraint/);
    expect((await db.query(`select job from scheduled_jobs order by job`)).rows.map((r) => (r as { job: string }).job)).toEqual(["agenda", "corbeille", "seo"]);
  });

  test("la migration se rejoue sans erreur ni perte", async () => {
    await connect();
    await upsert([row("2026-11-10", "/", "cely")]);
    await db.exec(`reset role;`);
    await db.exec(readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261125140400_tracking_seo.sql"), "utf8"));
    await db.as("owner");
    expect(await daily()).toHaveLength(1);
    expect((await db.query(`select provider from seo_connections`)).rows).toEqual([{ provider: "gsc" }]);
    const defs = (await db.query<{ d: string }>(`select pg_get_constraintdef(oid) d from pg_constraint where conname in ('connector_checks_key_check', 'scheduled_jobs_job_check')`)).rows.map((r) => r.d).join(" ");
    for (const v of ["search_console", "bing_webmaster", "'seo'"]) expect(defs.split(v).length - 1).toBe(1);
  });
});
