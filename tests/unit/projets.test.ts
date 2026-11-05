// Projets / portail : codes d'accès, empreintes, et lecture des changements Google (fetch simulé).
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";

beforeAll(() => {
  process.env.APPOINTMENTS_SECRET = "s".repeat(48);
  process.env.GOOGLE_CALENDAR_CLIENT_ID = "id";
  process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "secret";
});
afterEach(() => vi.unstubAllGlobals());

describe("codes d'accès", () => {
  test("20 caractères Crockford (100 bits), uniques, saisie tolérante, empreinte poivrée", async () => {
    const { generateCode, normalizeCode, codeHash, newSessionToken, sessionHash } = await import("@/lib/projects/portal-auth");
    const codes = new Set(Array.from({ length: 500 }, () => generateCode().code));
    expect(codes.size).toBe(500);
    const { code, hint } = generateCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
    expect(code.endsWith(hint)).toBe(true);
    expect(normalizeCode(` ${code.toLowerCase().replace(/-/g, " ")} `)).toBe(code.replace(/-/g, ""));
    expect(normalizeCode("o0-il")).toBe("0011");
    expect(codeHash(code)).toBe(codeHash(code.toLowerCase()));
    expect(codeHash(code)).toMatch(/^[0-9a-f]{64}$/);
    // l'empreinte dépend du secret serveur : sans lui, un code ne se vérifie pas hors ligne
    const { createHash } = await import("node:crypto");
    expect(codeHash(code)).not.toBe(createHash("sha256").update(code.replace(/-/g, "")).digest("hex"));
    const s = newSessionToken();
    expect(s.token.length).toBeGreaterThanOrEqual(43);
    expect(sessionHash(s.token)).toBe(s.hash);
  });
});

describe("changements faits dans Google Agenda", () => {
  test("seuls les événements de l'outil sont lus ; pagination ; jeton suivant", async () => {
    const { listEventChanges } = await import("@/lib/appointments/google");
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      const page = url.includes("pageToken=p2")
        ? { items: [{ id: "rdv11111111111141118111111111111111", status: "cancelled" }], nextSyncToken: "tok-2" }
        : { items: [
            { id: "autre-evenement", status: "confirmed", start: { dateTime: "2026-12-01T09:00:00Z" } },
            { id: "rdv22222222222242228222222222222222", status: "confirmed", start: { dateTime: "2026-12-01T10:00:00Z" }, end: { dateTime: "2026-12-01T10:30:00Z" } },
          ], nextPageToken: "p2" };
      return new Response(JSON.stringify(page), { status: 200 });
    }));
    const r = await listEventChanges("access", "primary", "tok-1");
    expect(r.nextSyncToken).toBe("tok-2");
    expect(r.events.map((e) => [e.bookingId, e.status])).toEqual([
      ["22222222-2222-4222-8222-222222222222", "confirmed"],
      ["11111111-1111-4111-8111-111111111111", "cancelled"],
    ]);
    expect(calls[0]).toContain("syncToken=tok-1");
  });

  test("jeton expiré : erreur 410 transmise pour relancer une synchronisation complète", async () => {
    const { listEventChanges, GoogleError } = await import("@/lib/appointments/google");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Sync token is no longer valid" } }), { status: 410 })));
    await expect(listEventChanges("a", "primary", "old")).rejects.toSatisfy((e: unknown) => e instanceof GoogleError && e.status === 410);
  });

  test("écart : déplacé ou supprimé dans Google ; rien si identique ou rendez-vous non confirmé", async () => {
    const { driftFor } = await import("@/lib/appointments/google-sync");
    const b = { id: "x", status: "confirmed", starts_at: "2026-12-01T09:00:00.000Z", ends_at: "2026-12-01T09:30:00.000Z", calendar_target: true, google_event_id: "rdvx" };
    const e = { id: "rdvx", bookingId: "x", status: "confirmed", start: "2026-12-01T10:00:00+01:00", end: "2026-12-01T10:30:00+01:00" };
    expect(driftFor(b, e)).toBeNull(); // même instant, autre fuseau
    expect(driftFor(b, { ...e, start: "2026-12-02T09:00:00Z", end: "2026-12-02T09:30:00Z" })).toEqual({ kind: "moved", start: "2026-12-02T09:00:00.000Z", end: "2026-12-02T09:30:00.000Z" });
    expect(driftFor(b, { ...e, status: "cancelled" })).toEqual({ kind: "deleted" });
    expect(driftFor({ ...b, status: "cancelled" }, { ...e, status: "cancelled" })).toBeNull();
  });
});
