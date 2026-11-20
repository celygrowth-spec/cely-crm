// Search Console et Bing : règles pures (dates, curseurs, pages), synchronisation reprise après interruption sans
// doublon, états « à reconnecter », et clé API Bing jamais reprise dans une erreur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BingError, listSites, pageQueryStats, queryStats } from "@/lib/tracking/seo/bing";
import { GscError } from "@/lib/tracking/seo/gsc";
import { seoJob, syncProvider, verifyProvider, type SeoDeps } from "@/lib/tracking/seo/job";
import { addDays, bingDay, bingRow, dayRange, gscRow, mergeRows, monthsBefore, nextHistoryDays, normalizePage, planGsc, readBingCursor, sameSite, type SeoRow } from "@/lib/tracking/seo/rules";

process.env.APPOINTMENTS_SECRET = "secret-de-test-0123456789-0123456789-0123456789";
const API_KEY = "cleapisecrete0123456789abcdef";

describe("règles", () => {
  test("page ramenée à un chemin", () => {
    expect(normalizePage("https://celygrowth.com/services/?utm=1#haut")).toBe("/services");
    expect(normalizePage("https://celygrowth.com")).toBe("/");
    expect(normalizePage("https://blog.celygrowth.com/a/b/")).toBe("/a/b");
    expect(normalizePage("/deja/un/chemin")).toBe("/deja/un/chemin");
    expect(normalizePage("")).toBe("");
    expect(normalizePage(null)).toBe("");
  });

  test("dates", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(dayRange("2026-11-17", "2026-11-19")).toEqual(["2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(dayRange("2026-11-19", "2026-11-17")).toEqual([]);
    expect(monthsBefore("2026-11-19", 16)).toBe("2025-07-19");
    expect(monthsBefore("2026-06-30", 16)).toBe("2025-02-28");
  });

  test("date de Bing : jour de l'horloge locale indiquée", () => {
    expect(bingDay("/Date(1316156400000-0700)/")).toBe("2011-09-16");
    expect(bingDay("/Date(1316131200000)/")).toBe("2011-09-16");
    expect(bingDay("/Date(1316131200000+0200)/")).toBe("2011-09-16");
    expect(bingDay("2011-09-16")).toBeNull();
    expect(bingDay(null)).toBeNull();
  });

  test("lignes Search Console et Bing", () => {
    expect(gscRow({ keys: ["2026-11-01", "https://celygrowth.com/services/", "agence growth"], clicks: 2, impressions: 40, position: 4.1264 }))
      .toEqual({ day: "2026-11-01", page: "/services", query: "agence growth", clicks: 2, impressions: 40, position: 4.13 });
    expect(gscRow({ keys: ["2026-11-01", "https://celygrowth.com/"] })).toBeNull();
    expect(gscRow({ keys: ["hier", "https://celygrowth.com/", "q"] })).toBeNull();
    const stat = { Query: "agence growth", Date: "/Date(1316156400000-0700)/", Clicks: 15, Impressions: 100, AvgImpressionPosition: 17, AvgClickPosition: 18 };
    expect(bingRow(stat, "query")).toEqual({ day: "2011-09-16", page: "", query: "agence growth", clicks: 15, impressions: 100, position: 17 });
    expect(bingRow(stat, "query", { page: "/services" })).toMatchObject({ page: "/services", query: "agence growth" });
    expect(bingRow({ ...stat, Query: "https://celygrowth.com/services/", AvgImpressionPosition: -1 }, "page")).toEqual({ day: "2011-09-16", page: "/services", query: "", clicks: 15, impressions: 100, position: null });
    expect(bingRow({ ...stat, Date: "?" }, "query")).toBeNull();
  });

  test("deux adresses, un même chemin : additionnées, position pondérée par les impressions", () => {
    const rows: SeoRow[] = [
      { day: "2026-11-01", page: "/a", query: "q", clicks: 1, impressions: 30, position: 2 },
      { day: "2026-11-01", page: "/a", query: "q", clicks: 2, impressions: 10, position: 6 },
      { day: "2026-11-01", page: "/a", query: "autre", clicks: 0, impressions: 5, position: null },
    ];
    expect(mergeRows(rows)).toEqual([
      { day: "2026-11-01", page: "/a", query: "q", clicks: 3, impressions: 40, position: 3 },
      { day: "2026-11-01", page: "/a", query: "autre", clicks: 0, impressions: 5, position: null },
    ]);
  });

  test("plan Search Console : premier passage, passage courant, passages manqués", () => {
    const first = planGsc({}, "2026-11-20");
    expect(first.end).toBe("2026-11-19");
    expect(first.recent).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(first.cursor).toEqual({ floor: "2025-07-19", history_until: "2026-11-15", recent_to: null });
    expect(nextHistoryDays(first.cursor, 3)).toEqual(["2026-11-15", "2026-11-14", "2026-11-13"]);

    const usual = planGsc({ floor: "2025-07-19", history_until: "2025-07-18", recent_to: "2026-11-19" }, "2026-11-21");
    expect(usual.recent).toEqual(["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"]);
    expect(nextHistoryDays(usual.cursor, 5)).toEqual([]);

    // dix jours sans passage : tout l'intervalle manqué est relu, sans trou
    const late = planGsc({ floor: "2025-07-19", history_until: "2026-01-01", recent_to: "2026-11-10" }, "2026-11-21");
    expect(late.recent[0]).toBe("2026-11-08");
    expect(late.recent.at(-1)).toBe("2026-11-20");
    expect(late.cursor.history_until).toBe("2026-01-01");
    expect(nextHistoryDays({ floor: "2025-12-31", history_until: "2026-01-01", recent_to: null }, 5)).toEqual(["2026-01-01", "2025-12-31"]);
  });

  test("curseur Bing illisible : le cycle repart du début", () => {
    expect(readBingCursor(null)).toEqual({ phase: "totals", pages: [], index: 0 });
    expect(readBingCursor({ phase: "page_queries", pages: ["https://a/", 3], index: 1 })).toEqual({ phase: "page_queries", pages: ["https://a/"], index: 1 });
    expect(readBingCursor({ phase: "queries", pages: ["x"], index: 4 })).toEqual({ phase: "queries", pages: [], index: 0 });
  });

  test("même site, avec ou sans barre finale", () => {
    expect(sameSite("https://CelyGrowth.com/", "https://celygrowth.com")).toBe(true);
    expect(sameSite("https://celygrowth.com/", "https://autre.example/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fausse base : les quatre fonctions à clé serveur, en mémoire
// ---------------------------------------------------------------------------
type Conn = { provider: string; site_url: string | null; status: string; last_error: string | null; cursor: unknown; history_done_at: string | null; last_sync_at: string | null; secret_enc: string };

function fakeDb(conns: Partial<Record<"gsc" | "bing", Partial<Conn>>>) {
  const state = new Map<string, Conn>();
  for (const [p, c] of Object.entries(conns)) state.set(p, { provider: p, site_url: "sc-domain:celygrowth.com", status: "connected", last_error: null, cursor: {}, history_done_at: null, last_sync_at: null, secret_enc: "v1.x.y.z", ...c });
  const rows = new Map<string, SeoRow & { provider: string }>();
  const calls: string[] = [];
  const sb = {
    rpc: async (fn: string, a: Record<string, unknown>) => {
      calls.push(fn);
      const c = state.get(a.p_provider as string);
      if (fn === "seo_server_connection") return { data: c ? { ...c } : null, error: null };
      if (!c) return { data: null, error: { code: "P0002", message: "non connecté" } };
      if (fn === "seo_server_upsert") {
        for (const day of (a.p_replace_days as string[] | null) ?? []) for (const [k, r] of rows) if (r.provider === c.provider && r.day === day) rows.delete(k);
        for (const r of a.p_rows as SeoRow[]) rows.set(`${c.provider}|${r.day}|${r.page}|${r.query}`, { ...r, provider: c.provider });
        return { data: (a.p_rows as SeoRow[]).length, error: null };
      }
      if (fn === "seo_server_progress") {
        if (a.p_cursor) c.cursor = a.p_cursor;
        if (a.p_history_done) c.history_done_at ??= "fait";
        if (a.p_synced) c.last_sync_at = "synchronisé";
        c.status = "connected";
        c.last_error = null;
      }
      if (fn === "seo_server_fail") {
        c.status = a.p_status as string;
        c.last_error = a.p_error as string;
      }
      return { data: null, error: null };
    },
  } as unknown as SupabaseClient;
  return { sb, state, rows, calls };
}

const NOW = Date.parse("2026-11-20T09:00:00Z");
/** Horloge qui avance d'une seconde à chaque lecture : le délai finit par être dépassé. */
function clock(stepMs = 0) {
  let t = NOW;
  return () => (t += stepMs);
}

function gscDeps(over: Partial<SeoDeps["gsc"]> = {}, now = clock()): Partial<SeoDeps> {
  const queryDay = vi.fn(async (_t: string, _s: string, day: string): Promise<SeoRow[]> => [
    { day, page: "/", query: "cely", clicks: 1, impressions: 10, position: 1 },
    { day, page: "/services", query: "agence growth", clicks: 0, impressions: 4, position: 8 },
  ]);
  return { now, decrypt: () => "jeton", gsc: { accessToken: async () => "acces", listSites: async () => ["sc-domain:celygrowth.com"], queryDay, ...over } };
}

describe("synchronisation Search Console", () => {
  test("interrompue par le délai puis reprise : aucun jour sauté, aucun doublon, historique terminé une fois", async () => {
    const db = fakeDb({ gsc: { cursor: { floor: "2026-11-01", history_until: null, recent_to: null } } });
    // premier passage : délai déjà dépassé après le premier lot → seuls les jours récents sont lus
    const d1 = gscDeps({}, clock(60_000));
    const r1 = await syncProvider(db.sb, "gsc", { deadline: NOW + 1000, deps: d1 });
    expect(r1).toMatchObject({ status: "ok", done: false });
    expect(db.state.get("gsc")!.cursor).toMatchObject({ recent_to: "2026-11-19" });
    expect(db.state.get("gsc")!.history_done_at).toBeNull();
    const afterFirst = db.rows.size;
    expect(afterFirst).toBe(8); // 4 jours × 2 lignes

    // deuxième passage : délai large → relit les jours récents (mêmes lignes) et remonte jusqu'au plancher
    const d2 = gscDeps();
    const r2 = await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: d2 });
    expect(r2).toMatchObject({ status: "ok", done: true });
    const days = new Set([...db.rows.values()].map((r) => r.day));
    expect([...days].sort()).toEqual(dayRange("2026-11-01", "2026-11-19"));
    expect(db.rows.size).toBe(19 * 2);
    expect(db.state.get("gsc")).toMatchObject({ history_done_at: "fait", last_sync_at: "synchronisé", status: "connected" });

    // troisième passage : seuls les 4 derniers jours sont relus, rien ne change
    const d3 = gscDeps();
    await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: d3 });
    expect((d3.gsc!.queryDay as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]).sort()).toEqual(["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]);
    expect(db.rows.size).toBe(19 * 2);
  });

  test("un jour relu perd les lignes que Google ne renvoie plus", async () => {
    const db = fakeDb({ gsc: { cursor: { floor: "2026-11-16", history_until: "2026-11-15", recent_to: "2026-11-19" }, history_done_at: "fait" } });
    await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: gscDeps() });
    expect(db.rows.size).toBe(8);
    await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: gscDeps({ queryDay: async (_t, _s, day) => [{ day, page: "/", query: "cely", clicks: 2, impressions: 12, position: 1 }] }) });
    expect(db.rows.size).toBe(4);
    expect([...db.rows.values()].every((r) => r.clicks === 2)).toBe(true);
  });

  test("jeton révoqué : « à reconnecter », message lisible, rien n'est écrit", async () => {
    const db = fakeDb({ gsc: {} });
    const r = await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: gscDeps({ accessToken: async () => { throw new GscError("Google a refusé l'accès (révoqué ou expiré) : reconnectez Search Console.", "reauth"); } }) });
    expect(r).toMatchObject({ status: "reconnect", done: false, rows: 0 });
    expect(db.state.get("gsc")).toMatchObject({ status: "reconnect", last_error: "Google a refusé l'accès (révoqué ou expiré) : reconnectez Search Console." });
    expect(db.rows.size).toBe(0);
  });

  test("erreur inconnue : état « erreur » sans le message d'origine ; secret illisible : à reconnecter", async () => {
    const db = fakeDb({ gsc: {} });
    const r = await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: gscDeps({ queryDay: async () => { throw new Error("jeton=ya29.secret"); } }) });
    expect(r.status).toBe("error");
    expect(JSON.stringify([r, db.state.get("gsc")])).not.toContain("ya29");
    const r2 = await syncProvider(db.sb, "gsc", { deadline: NOW + 60_000, deps: { ...gscDeps(), decrypt: () => { throw new Error("bad decrypt"); } } });
    expect(r2.status).toBe("reconnect");
  });

  test("non connecté ou propriété non choisie : rien n'est appelé", async () => {
    const none = fakeDb({});
    expect(await syncProvider(none.sb, "gsc", { deadline: NOW + 1000, deps: gscDeps() })).toMatchObject({ status: "skipped", connected: false });
    const noSite = fakeDb({ gsc: { site_url: null } });
    const deps = gscDeps();
    expect(await syncProvider(noSite.sb, "gsc", { deadline: NOW + 1000, deps })).toMatchObject({ status: "skipped", connected: true, done: false });
    expect(deps.gsc!.queryDay).not.toHaveBeenCalled();
  });
});

describe("synchronisation Bing", () => {
  const row = (page: string, query: string): SeoRow => ({ day: "2026-11-09", page, query, clicks: 1, impressions: 10, position: page || query ? 3 : null });
  const bingDeps = (now = clock()): Partial<SeoDeps> => ({
    now, decrypt: () => API_KEY,
    bing: {
      listSites: async () => ["https://celygrowth.com/"],
      siteTotals: vi.fn(async () => [row("", "")]),
      queryStats: vi.fn(async () => [row("", "cely")]),
      pageStats: vi.fn(async () => ({ rows: [row("/", ""), row("/services", "")], urls: ["https://celygrowth.com/", "https://celygrowth.com/services", "https://celygrowth.com/contact", "https://celygrowth.com/blog"] })),
      pageQueryStats: vi.fn(async (_k: string, _s: string, url: string) => [row(normalizePage(url), "cely")]),
    },
  });

  test("cycle interrompu puis repris à la page en cours ; cycle suivant sans doublon", async () => {
    const db = fakeDb({ bing: { site_url: "https://celygrowth.com/" } });
    const d1 = bingDeps(clock(400));
    const r1 = await syncProvider(db.sb, "bing", { deadline: NOW + 1000, deps: d1 });
    expect(r1).toMatchObject({ status: "ok", done: false });
    const c1 = readBingCursor(db.state.get("bing")!.cursor);
    expect(d1.bing!.siteTotals).toHaveBeenCalledTimes(1);
    expect(db.state.get("bing")!.history_done_at).toBeNull();

    const d2 = bingDeps();
    const r2 = await syncProvider(db.sb, "bing", { deadline: NOW + 60_000, deps: d2 });
    expect(r2).toMatchObject({ status: "ok", done: true });
    // les étapes déjà faites ne sont pas refaites
    if (c1.phase !== "totals") expect(d2.bing!.siteTotals).not.toHaveBeenCalled();
    expect(db.state.get("bing")).toMatchObject({ history_done_at: "fait", last_sync_at: "synchronisé", cursor: {} });
    // site + 1 requête + 2 pages + 4 croisements
    expect(db.rows.size).toBe(8);

    const d3 = bingDeps();
    await syncProvider(db.sb, "bing", { deadline: NOW + 60_000, deps: d3 });
    expect(d3.bing!.pageQueryStats).toHaveBeenCalledTimes(4);
    expect(db.rows.size).toBe(8);
  });

  test("clé refusée : « à reconnecter » ; l'autre fournisseur continue et le passage signale l'échec", async () => {
    const db = fakeDb({ gsc: { cursor: { floor: "2026-11-16", history_until: "2026-11-15", recent_to: null } }, bing: { site_url: "https://celygrowth.com/" } });
    const deps = { ...gscDeps(), bing: { ...bingDeps().bing!, siteTotals: async () => { throw new BingError("Clé API refusée par Bing : générez-en une nouvelle dans Bing Webmaster Tools, puis reconnectez.", "auth"); } } };
    await expect(seoJob(db.sb, { deps })).rejects.toThrow(/Bing Webmaster Tools : Clé API refusée/);
    expect(db.state.get("bing")).toMatchObject({ status: "reconnect" });
    expect(db.state.get("gsc")).toMatchObject({ status: "connected", last_sync_at: "synchronisé" });
    expect(db.rows.size).toBe(8);
  });

  test("aucun connecteur : passage « non actif », sans erreur", async () => {
    expect(await seoJob(fakeDb({}).sb, { deps: gscDeps() })).toEqual({ skipped: "Search Console et Bing ne sont pas connectés" });
  });
});

describe("vérification", () => {
  test("accès confirmé : l'état « à reconnecter » est levé ; site disparu : signalé", async () => {
    const db = fakeDb({ gsc: { status: "reconnect", last_error: "révoqué" } });
    expect(await verifyProvider(db.sb, "gsc", gscDeps())).toMatchObject({ ok: true });
    expect(db.state.get("gsc")).toMatchObject({ status: "connected", last_error: null });
    expect(await verifyProvider(db.sb, "gsc", gscDeps({ listSites: async () => ["https://autre.example/"] }))).toMatchObject({ ok: false });
    expect(await verifyProvider(fakeDb({}).sb, "bing", gscDeps())).toEqual({ ok: false, message: "Bing Webmaster Tools n'est pas connecté." });
  });
});

describe("client Bing", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  beforeEach(() => vi.restoreAllMocks());

  test("appels GET uniquement ; la page est passée encodée en JSON ; réponses rangées par niveau", async () => {
    const seen: { url: URL; method: string }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      seen.push({ url: new URL(url), method: init?.method ?? "GET" });
      return json({ d: [{ __type: "QueryStats:#Microsoft.Bing.Webmaster.Api", AvgClickPosition: 18, AvgImpressionPosition: 17, Clicks: 15, Date: "/Date(1316156400000-0700)/", Impressions: 100, Query: "agence growth" }] });
    }) as typeof fetch;
    expect(await queryStats(API_KEY, "https://celygrowth.com/", fetcher)).toEqual([{ day: "2011-09-16", page: "", query: "agence growth", clicks: 15, impressions: 100, position: 17 }]);
    expect(await pageQueryStats(API_KEY, "https://celygrowth.com/", "https://celygrowth.com/services/", fetcher)).toEqual([{ day: "2011-09-16", page: "/services", query: "agence growth", clicks: 15, impressions: 100, position: 17 }]);
    expect(seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(seen[0].url.origin + seen[0].url.pathname).toBe("https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats");
    expect(seen[0].url.searchParams.get("siteUrl")).toBe("https://celygrowth.com/");
    expect(seen[1].url.pathname).toBe("/webmaster/api.svc/json/GetPageQueryStats");
    expect(seen[1].url.searchParams.get("page")).toBe('"https://celygrowth.com/services/"');
  });

  test("clé refusée, limite, panne réseau : erreurs lisibles, sans la clé ni l'adresse appelée", async () => {
    const errors: unknown[] = [];
    const attempt = async (fetcher: typeof fetch): Promise<BingError> => {
      try {
        await listSites(API_KEY, fetcher);
      } catch (e) {
        errors.push(e);
        return e as BingError;
      }
      throw new Error("l'appel aurait dû échouer");
    };
    expect((await attempt((async () => json({ ErrorCode: 3, Message: `InvalidApiKey ${API_KEY}` }, 400)) as typeof fetch)).kind).toBe("auth");
    expect((await attempt((async () => json({ ErrorCode: 4, Message: "ThrottleUser" }, 400)) as typeof fetch)).kind).toBe("throttle");
    expect((await attempt((async () => json({ ErrorCode: 8, Message: `bad ${API_KEY}` }, 400)) as typeof fetch)).kind).toBe("other");
    expect((await attempt((async (url: string) => { throw new Error(`fetch failed ${url}`); }) as typeof fetch)).kind).toBe("network");
    expect(errors).toHaveLength(4);
    for (const e of errors) {
      expect(e).toBeInstanceOf(BingError);
      expect(`${(e as Error).message} ${(e as Error).stack} ${JSON.stringify(e)}`).not.toContain(API_KEY);
      expect((e as Error).message).not.toContain("ssl.bing.com");
    }
  });

  test("seuls les sites vérifiés sont proposés", async () => {
    const fetcher = (async () => json({ d: [{ Url: "https://celygrowth.com/", IsVerified: true }, { Url: "https://brouillon.example/", IsVerified: false }] })) as typeof fetch;
    expect(await listSites(API_KEY, fetcher)).toEqual(["https://celygrowth.com/"]);
  });
});

describe("connexion Google : compte ouvert d'office", () => {
  test("avec le compte de l'agenda, Google l'ouvre directement ; sans lui, il propose le choix du compte", async () => {
    vi.stubEnv("GOOGLE_SEARCH_CONSOLE_CLIENT_ID", "client");
    vi.stubEnv("GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET", "secret");
    const { authorizationUrl } = await import("@/lib/tracking/seo/gsc");
    const base = { redirectUri: "https://crm.example.test/api/tracking/seo/google/callback", state: "s", codeChallenge: "c" };
    const hinted = new URL(authorizationUrl({ ...base, loginHint: "moi@example.test" })).searchParams;
    expect(hinted.get("login_hint")).toBe("moi@example.test");
    expect(hinted.get("prompt")).toBe("consent");
    const plain = new URL(authorizationUrl(base)).searchParams;
    expect(plain.get("login_hint")).toBeNull();
    expect(plain.get("prompt")).toBe("consent select_account");
    expect(plain.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    vi.unstubAllEnvs();
  });
});
