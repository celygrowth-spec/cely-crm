// Fireflies : signature, conversion des réponses et accès publics au niveau du proxy.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { normalizeTranscript, safeTranscriptUrl } from "@/lib/fireflies/normalize";
import { signPayload, verifySignature } from "@/lib/fireflies/signature";
import {
  findMatchingLines, fold, formatCallDuration, formatOffset, mainParticipants, shortDescription, splitMatches, summaryText, transcriptToText,
} from "@/lib/fireflies/transcript-view";

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
    for (const path of ["/api/fireflies/status", "/api/fireflies/to-link", "/api/fireflies/rematch", "/api/fireflies/process", "/api/fireflies/backfill",
      "/api/fireflies/own-addresses", "/api/fireflies/calls", `/api/fireflies/calls/${CALL}/transcript`, `/api/fireflies/calls/${CALL}/note`,
      `/api/fireflies/calls/${CALL}/link`, `/api/fireflies/jobs/${CALL}/retry`]) {
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

describe("affichage de la transcription", () => {
  const line = (text: string, start: number | null = 0, speaker: string | null = "Ana") => ({ index: 0, speaker, speaker_id: null, text, start, end: null });

  test("heure relative et durée", () => {
    expect([formatOffset(0), formatOffset(65.9), formatOffset(3725), formatOffset(null), formatOffset(-1)]).toEqual(["0:00", "1:05", "1:02:05", "–", "–"]);
    expect([formatCallDuration(null), formatCallDuration(0.4), formatCallDuration(30), formatCallDuration(60), formatCallDuration(95)]).toEqual(["", "moins d'1 min", "30 min", "1 h", "1 h 35"]);
  });

  test("la copie contient toutes les lignes, jusqu'à la dernière", () => {
    const lines = Array.from({ length: 5000 }, (_, i) => line(`Phrase ${i}`, i));
    const text = transcriptToText(lines);
    expect(text.split("\n")).toHaveLength(5000);
    expect(text.split("\n")[0]).toBe("[0:00] Ana : Phrase 0");
    expect(text.endsWith("Ana : Phrase 4999")).toBe(true);
    expect(transcriptToText([line("x", null, null)])).toBe("[–] Intervenant inconnu : x");
  });

  test("recherche sans accents ni majuscules, positions exactes, sur toute la transcription", () => {
    expect(fold("Été À Noël")).toBe("ete a noel");
    expect(fold("Été").length).toBe(3);
    expect(splitMatches("L'Été, puis l'été", "ete")).toEqual([
      { text: "L'", match: false }, { text: "Été", match: true }, { text: ", puis l'", match: false }, { text: "été", match: true },
    ]);
    expect(splitMatches("abc", "")).toEqual([{ text: "abc", match: false }]);
    expect(splitMatches("abc", "x")).toEqual([{ text: "abc", match: false }]);
    const lines = Array.from({ length: 3000 }, (_, i) => line(i === 2999 ? "La phrase Exacte" : "autre"));
    expect(findMatchingLines(lines, "  phrase exacte ")).toEqual([2999]);
    expect(findMatchingLines(lines, "")).toEqual([]);
  });

  test("le texte importé garde ses balises comme simple texte", () => {
    const evil = "<img src=x onerror=alert(1)>";
    expect(splitMatches(evil, "img").map((p) => p.text).join("")).toBe(evil);
    expect(transcriptToText([line(evil)])).toContain(evil);
  });

  test("description et participants", () => {
    expect(shortDescription({ gist: "court", overview: "long" })).toBe("court");
    expect(summaryText({ gist: "court", overview: "long" })).toBe("long");
    expect(summaryText({ short_summary: ["a", "b"] })).toBe("a\nb");
    expect(summaryText({})).toBeNull();
    expect(mainParticipants({ speakers: [{ id: "1", name: "Ana" }, { id: "2", name: "Ana" }, { id: "3", name: "Léo" }], attendees: [], participants: ["x@y.fr"] })).toEqual({ shown: ["Ana", "Léo"], more: 0 });
    expect(mainParticipants({ speakers: [], attendees: [{ name: null, email: "a@b.fr" }], participants: [] }).shown).toEqual(["a@b.fr"]);
    expect(mainParticipants({ speakers: [], attendees: [], participants: ["a@b.fr", "c@d.fr", "e@f.fr", "g@h.fr"] })).toMatchObject({ more: 1 });
  });
});

describe("routes de l'historique", () => {
  const req = (url: string, body?: unknown) =>
    new NextRequest(`https://crm.test${url}`, { method: "POST", body: JSON.stringify(body ?? {}), headers: { origin: "https://crm.test" } });
  const notOwner = () => {
    const from = vi.fn();
    rpc.mockReset();
    rpc.mockResolvedValue({ data: false, error: null });
    session = { supabase: { rpc, from } as never };
  };

  beforeEach(() => {
    vi.stubEnv("APPOINTMENTS_SECRET", "x".repeat(40));
    vi.stubEnv("FIREFLIES_API_KEY", "cle");
  });

  test("sans session : la transcription et les listes ne sortent pas, et ne se mettent pas en cache", async () => {
    session = null;
    const { GET: transcript } = await import("@/app/api/fireflies/calls/[id]/transcript/route");
    const { GET: calls } = await import("@/app/api/fireflies/calls/route");
    const { GET: toLink } = await import("@/app/api/fireflies/to-link/route");
    const r = await transcript(new Request("https://crm.test/x"), { params: Promise.resolve({ id: CALL }) });
    expect(r.status).toBe(401);
    expect((await calls(new Request(`https://crm.test/x?company=${COMPANY}`))).status).toBe(401);
    expect((await toLink(new Request("https://crm.test/x"))).status).toBe(401);
  });

  test("identifiants invalides refusés", async () => {
    session = { supabase: { rpc } };
    const { GET: transcript } = await import("@/app/api/fireflies/calls/[id]/transcript/route");
    const { GET: calls } = await import("@/app/api/fireflies/calls/route");
    expect((await transcript(new Request("https://crm.test/x"), { params: Promise.resolve({ id: "pas-un-id" }) })).status).toBe(400);
    expect((await calls(new Request("https://crm.test/x"))).status).toBe(400);
    expect((await calls(new Request("https://crm.test/x?company=x"))).status).toBe(400);
  });

  test("transcription : réponse privée, jamais en cache partagé", async () => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { lines: [] }, error: null }) };
    session = { supabase: { rpc, from: () => chain } as never };
    const { GET } = await import("@/app/api/fireflies/calls/[id]/transcript/route");
    const r = await GET(new Request("https://crm.test/x"), { params: Promise.resolve({ id: CALL }) });
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });

  test("traitement et import historique : un compte connecté autre que le propriétaire est refusé", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    notOwner();
    const { POST: process } = await import("@/app/api/fireflies/process/route");
    const { POST: backfill } = await import("@/app/api/fireflies/backfill/route");
    expect(await (await process(req("/api/fireflies/process"))).json()).toEqual({ ok: false, error: "Accès refusé." });
    expect(await (await backfill(req("/api/fireflies/backfill", { from: "2026-01-01", to: "2026-02-01" }))).json()).toEqual({ ok: false, error: "Accès refusé." });
    expect(f).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("import historique : période bornée", async () => {
    session = { supabase: { rpc } };
    const { POST } = await import("@/app/api/fireflies/backfill/route");
    for (const body of [{ from: "2026-03-01", to: "2026-01-01" }, { from: "2024-01-01", to: "2026-01-01" }, { from: "hier", to: "2026-01-01" }, {}]) {
      expect((await POST(req("/api/fireflies/backfill", body))).status).toBe(400);
    }
  });

  test("note et adresses : données validées", async () => {
    session = { supabase: { rpc } };
    rpc.mockReset();
    const { POST: note } = await import("@/app/api/fireflies/calls/[id]/note/route");
    const { POST: own } = await import("@/app/api/fireflies/own-addresses/route");
    const call = { params: Promise.resolve({ id: CALL }) };
    expect((await note(req("/x", { note: "x".repeat(20001) }), call)).status).toBe(400);
    expect((await own(req("/x", { emails: ["pas-une-adresse"], domains: [] }))).status).toBe(400);
    expect((await own(req("/x", { emails: [], domains: ["<script>"] }))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("cloisonnement du code", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

  test("le portail client ne référence jamais Fireflies", () => {
    const files = ["src/app/portail", "src/app/api/portail", "src/components/portal"].flatMap(walk);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/fireflies/i);
  });

  test("le contenu importé n'est jamais injecté comme du HTML", () => {
    for (const f of [...walk("src/components/fireflies"), ...walk("src/app/(app)/appels"), "src/components/record-calls.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
