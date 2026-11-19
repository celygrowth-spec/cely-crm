// Connecteur Make : adresses acceptées, validation stricte du retour, appel sortant (enveloppe, erreurs lisibles,
// adresse jamais renvoyée ni journalisée).
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { returnSchema, scenarioKey, webhookAllowed } from "@/lib/make/rules";

const HOOK = "https://hook.eu2.make.com/abcdefgh12345678";
const REQ = "11111111-1111-4111-8111-111111111111";

describe("règles", () => {
  test("identifiant tiré du nom", () => {
    expect(scenarioKey("Créer le devis")).toBe("creer_le_devis");
    expect(scenarioKey("  Relance — facture n°2 ")).toBe("relance_facture_n_2");
  });

  test("seules les adresses de webhook Make sont acceptées, sauf l'origine de test fournie", () => {
    expect(webhookAllowed(HOOK)).toBe(true);
    expect(webhookAllowed("https://hook.make.com/abcdefgh12345678")).toBe(true);
    for (const bad of ["http://hook.eu2.make.com/abcdefgh12345678", "https://hook.eu2.make.com.pirate.test/abcdefgh12345678", "https://exemple.test/hook", "https://hook.eu2.make.com/abc?x=1", "http://127.0.0.1:4010/hook", "http://169.254.169.254/latest"])
      expect(webhookAllowed(bad)).toBe(false);
    expect(webhookAllowed("http://127.0.0.1:4010/hook/devis", "http://127.0.0.1:4010")).toBe(true);
    expect(webhookAllowed("http://127.0.0.1:40100/hook", "http://127.0.0.1:4010")).toBe(false);
    expect(webhookAllowed("http://127.0.0.1:4010.pirate.test/hook", "http://127.0.0.1:4010")).toBe(false);
  });

  test("retour : champs connus seulement, vides tolérés, date ramenée au jour", () => {
    const ok = returnSchema.parse({ event: "quote.signed", request_id: REQ, quote: { number: " D-41 ", url: "https://exemple.test/d/41", signed_at: "2026-11-25T10:00:00Z" }, error: null });
    expect(ok.quote).toEqual({ number: "D-41", url: "https://exemple.test/d/41", signed_at: "2026-11-25" });
    expect(returnSchema.parse({ event: "quote.created", request_id: REQ, quote: { number: "", url: null } }).quote).toEqual({});
    for (const bad of [
      { event: "quote.deleted", request_id: REQ },
      { event: "quote.created", request_id: "abc" },
      { event: "quote.created", request_id: REQ, admin: true },
      { event: "quote.created", request_id: REQ, quote: { url: "javascript:alert(1)" } },
      { event: "quote.created", request_id: REQ, quote: { number: "x".repeat(61) } },
      { event: "quote.error", request_id: REQ, error: { message: "x".repeat(301) } },
    ]) expect(returnSchema.safeParse(bad).success).toBe(false);
  });
});

describe("appel d'un scénario", () => {
  const logged: Record<string, unknown>[] = [];
  let enc = "";
  const sb = {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: enc ? { name: "Créer le devis", key: "creer_le_devis", webhook_enc: enc } : null, error: null }) }) }) }),
    rpc: async (_: string, args: Record<string, unknown>) => { logged.push(args); return { data: null, error: null }; },
  } as unknown as SupabaseClient;

  beforeEach(async () => {
    vi.stubEnv("APPOINTMENTS_SECRET", "secret-de-test-suffisamment-long-0123456789abcdef");
    vi.stubEnv("APP_URL", "https://crm.exemple.test");
    logged.length = 0;
    enc = (await import("@/lib/appointments/secrets")).encryptSecret(HOOK);
  });

  test("enveloppe marquée, adresse de retour, résultat noté au journal sans le contenu", async () => {
    const { callScenario } = await import("@/lib/make/service");
    const f = vi.fn(async () => new Response("Accepted", { status: 200 }));
    expect(await callScenario(sb, "creer_le_devis", "test", REQ, {}, { test: true, fetcher: f as unknown as typeof fetch })).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(HOOK);
    expect(JSON.parse(String(init.body))).toMatchObject({ event: "test", test: true, request_id: REQ, callback_url: "https://crm.exemple.test/api/make/retour" });
    expect(logged).toEqual([{ p_scenario: "Créer le devis", p_event: "test", p_ok: true, p_error: null }]);
  });

  test("Make en panne, lent ou webhook supprimé : message lisible, jamais l'adresse", async () => {
    const { callScenario } = await import("@/lib/make/service");
    const cases: [typeof fetch, RegExp][] = [
      [(async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, /injoignable/],
      [(async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); }) as unknown as typeof fetch, /à temps/],
      [(async () => new Response("", { status: 410 })) as unknown as typeof fetch, /introuvable/],
      [(async () => new Response("", { status: 500 })) as unknown as typeof fetch, /code 500/],
    ];
    for (const [fetcher, message] of cases) {
      const r = await callScenario(sb, "creer_le_devis", "quote.create", REQ, {}, { fetcher });
      expect(r.ok).toBe(false);
      expect((r as { error: string }).error).toMatch(message);
    }
    expect(JSON.stringify(logged)).not.toContain("hook.eu2");
    expect(logged.every((l) => l.p_ok === false)).toBe(true);
  });

  test("scénario absent : rien n'est appelé ni journalisé", async () => {
    const { callScenario } = await import("@/lib/make/service");
    enc = "";
    const f = vi.fn();
    expect(await callScenario(sb, "creer_le_devis", "quote.create", REQ, {}, { fetcher: f as unknown as typeof fetch })).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  test("secret du retour : comparaison stricte", async () => {
    const { bearerMatches } = await import("@/lib/make/service");
    const s = "secret-partage-avec-make-0123456789";
    expect(bearerMatches(`Bearer ${s}`, s)).toBe(true);
    for (const bad of [null, "", s, `Bearer ${s}x`, `bearer ${s}`, "Bearer "]) expect(bearerMatches(bad, s)).toBe(false);
  });
});
