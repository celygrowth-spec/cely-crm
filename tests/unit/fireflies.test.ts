// Fireflies : signature, conversion des réponses et accès publics au niveau du proxy.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { normalizeTranscript, safeTranscriptUrl } from "@/lib/fireflies/normalize";
import { signPayload, verifySignature } from "@/lib/fireflies/signature";

const rpc = vi.fn();
let session: { supabase: { rpc: typeof rpc } } | null = null;
vi.mock("@/lib/auth", () => ({ getSession: async () => session }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getClaims: async () => ({ data: null }) } }),
}));

const base = {
  id: "m1",
  title: "Appel",
  date: 1_790_000_000_000,
  duration: 12.5,
  participants: ["a@acme.fr,B@Beta.fr", "a@acme.fr", "pas-une-adresse"],
  transcript_url: "https://app.fireflies.ai/view/m1",
  meeting_info: { summary_status: "processed", silent_meeting: false },
  summary: { overview: "Résumé", keywords: ["a"], action_items: null },
  sentences: [
    { index: 0, speaker_name: "Ana", speaker_id: 1, text: "Bonjour", raw_text: "bonjour", start_time: "1.5", end_time: 2 },
    { index: 1, speaker_name: null, text: null, raw_text: "brut", start_time: 3, end_time: 4 },
  ],
};

const CALL = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";

describe("signature", () => {
  test("accepte la signature exacte du corps brut, refuse tout écart", () => {
    const body = '{"event":"meeting.transcribed"}';
    const sig = signPayload(body, "secret-secret-secret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(body, sig, "secret-secret-secret")).toBe(true);
    expect(verifySignature(body + " ", sig, "secret-secret-secret")).toBe(false);
    expect(verifySignature(body, sig, "autre-secret-autre")).toBe(false);
    expect(verifySignature(body, null, "secret-secret-secret")).toBe(false);
    expect(verifySignature(body, "sha256=abc", "secret-secret-secret")).toBe(false);
  });
});

describe("conversion", () => {
  test("garde l'ordre, les intervenants, les horodatages ; nettoie les adresses", () => {
    const { call, lines } = normalizeTranscript(base);
    expect(lines).toEqual([
      { index: 0, speaker: "Ana", speaker_id: "1", text: "Bonjour", start: 1.5, end: 2 },
      { index: 1, speaker: null, speaker_id: null, text: "brut", start: 3, end: 4 },
    ]);
    expect(call.line_count).toBe(2);
    expect(call.participants).toEqual(["a@acme.fr", "b@beta.fr"]);
    expect(call.occurred_at).toBe(new Date(1_790_000_000_000).toISOString());
    expect(call.summary).toEqual({ overview: "Résumé", keywords: ["a"] });
    expect(call.summary_state).toBe("available");
  });

  test("états du résumé", () => {
    const state = (summary: unknown, summary_status: string | null, silent = false) =>
      normalizeTranscript({ ...base, summary, sentences: silent ? [] : base.sentences, meeting_info: { summary_status, silent_meeting: silent } }).call.summary_state;
    expect(state(null, "processing")).toBe("pending");
    expect(state(null, null)).toBe("pending");
    expect(state({ overview: "partiel" }, "processing")).toBe("pending");
    expect(state({ keywords: ["seul"] }, null)).toBe("pending");
    expect(state(null, "failed")).toBe("unavailable");
    expect(state(null, "skipped")).toBe("unavailable");
    expect(state(null, "processed")).toBe("unavailable");
    expect(state(null, null, true)).toBe("unavailable");
    expect(state({ overview: "ok" }, "processed")).toBe("available");
  });

  test("refuse une transcription vide non silencieuse, une réunion en direct, une ligne illisible", () => {
    expect(() => normalizeTranscript({ ...base, sentences: [] })).toThrow(/vide/);
    expect(() => normalizeTranscript({ ...base, is_live: true })).toThrow(/en cours/);
    expect(() => normalizeTranscript({ ...base, sentences: [{ text: 12 }] })).toThrow();
  });

  test("retire les caractères que Postgres refuse", () => {
    const { lines, call } = normalizeTranscript({ ...base, title: "A\u0000B", sentences: [{ text: "x\u0000y \ud83d" }] });
    expect(call.title).toBe("AB");
    expect(lines[0].text).toBe("xy �");
    expect(() => JSON.parse(JSON.stringify(lines))).not.toThrow();
  });

  test("seul un lien https fireflies.ai est conservé", () => {
    expect(safeTranscriptUrl("https://app.fireflies.ai/view/x")).toBe("https://app.fireflies.ai/view/x");
    for (const bad of ["javascript:alert(1)", "http://app.fireflies.ai/x", "https://fireflies.ai.evil.com/x", "https://evil.com/fireflies.ai", "https://u:p@app.fireflies.ai/", null, 3]) {
      expect(safeTranscriptUrl(bad)).toBeNull();
    }
  });
});

describe("proxy", () => {
  test("seuls le webhook et le passage planifié s'atteignent sans session", async () => {
    vi.stubEnv("SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "clé");
    const { proxy } = await import("@/proxy");
    const status = async (path: string) => (await proxy(new NextRequest(`https://crm.test${path}`))).status;
    expect(await status("/api/fireflies/webhook")).toBe(200);
    expect(await status("/api/fireflies/cron")).toBe(200);
    for (const path of ["/api/fireflies/status", "/api/fireflies/to-link", "/api/fireflies/rematch", `/api/fireflies/calls/${CALL}/link`]) {
      expect(await status(path)).toBe(401);
    }
    vi.unstubAllEnvs();
  });
});

describe("route de rattachement", () => {
  const post = async (body: unknown, id = CALL, origin = "https://crm.test") => {
    const { POST } = await import("@/app/api/fireflies/calls/[id]/link/route");
    return POST(
      new NextRequest(`https://crm.test/api/fireflies/calls/${id}/link`, { method: "POST", body: JSON.stringify(body), headers: { origin } }),
      { params: Promise.resolve({ id }) },
    );
  };

  beforeEach(() => {
    rpc.mockReset();
    rpc.mockResolvedValue({ data: null, error: null });
    session = { supabase: { rpc } };
  });

  test("sans session ou depuis une autre origine : refus, aucune écriture", async () => {
    expect((await post({ action: "ignore" }, CALL, "https://ailleurs.test")).status).toBe(403);
    session = null;
    expect((await post({ action: "ignore" })).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
  });

  test("données invalides : refus, aucune écriture", async () => {
    for (const r of [await post({ action: "supprimer" }), await post({ action: "link" }), await post({ action: "link", company_id: "x" }), await post({ action: "ignore" }, "pas-un-id")]) {
      expect(r.status).toBe(400);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  test("chaque action appelle sa fonction en base", async () => {
    expect((await post({ action: "link", company_id: COMPANY })).status).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith("fireflies_link_call", { p_call: CALL, p_company: COMPANY, p_person: null, p_booking: null });
    await post({ action: "ignore" });
    expect(rpc).toHaveBeenLastCalledWith("fireflies_ignore_call", { p_call: CALL });
    await post({ action: "reset" });
    expect(rpc).toHaveBeenLastCalledWith("fireflies_reset_call_link", { p_call: CALL });
  });

  test("le refus de la base est rendu lisible", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "Fiche introuvable", code: "P0002" } });
    const r = await post({ action: "link", company_id: COMPANY });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ ok: false, error: "Fiche introuvable" });
  });
});
