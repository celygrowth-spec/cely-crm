// Parcours complet de l'import Fireflies : vraies routes, vraies migrations (PGlite) sous le rôle anon,
// Fireflies simulé au niveau de fetch. Aucun appel réel, aucune donnée réelle.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, type Db } from "./harness";

const SECRET = "secret-rendez-vous-de-test-assez-long-pour-etre-accepte";
const HOOK_SECRET = "secret-webhook-de-test";
const CRON = "cron-secret-de-test-long";

let db: Db;
let dbDown = false;
const pending: (() => Promise<unknown>)[] = [];

// Même accès qu'en production : client sans session, donc rôle anon.
const sb = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (dbDown) return { data: null, error: { message: "indisponible", code: "503" } };
    await db.as("anon");
    try {
      return { data: await db.rpc(fn, args), error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
    }
  },
};

vi.mock("@/lib/appointments/server", () => ({ publicClient: () => sb }));
vi.mock("@/lib/auth", () => ({ getSession: vi.fn(async () => null) }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<unknown>) => pending.push(fn),
}));

const { POST: webhook } = await import("@/app/api/fireflies/webhook/route");
const { GET: cron } = await import("@/app/api/fireflies/cron/route");
const { signPayload } = await import("@/lib/fireflies/signature");
const { serverRpcKeyHash, serverRpcKey } = await import("@/lib/appointments/secrets");
const { drainImports } = await import("@/lib/fireflies/worker");

// --- Fireflies simulé -------------------------------------------------------
type Scenario = { status?: number; body?: unknown; headers?: Record<string, string> };
let calls: { query: string; id?: string; auth: string | null }[] = [];
let script: Scenario[] = [];
let list: { id: string }[] = [];
let meeting: Record<string, unknown>;

function sentences(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    index: i, speaker_name: i % 2 ? "Client" : "Moi", speaker_id: i % 2, text: `Phrase ${i}`, raw_text: `phrase ${i}`, start_time: i * 2, end_time: i * 2 + 1,
  }));
}
const baseMeeting = (id = "meetTest1") => ({
  id, title: "[TEST] Appel découverte", date: 1_790_000_000_000, duration: 30, organizer_email: "moi@celygrowth.com",
  participants: ["client@acme-test.fr", "moi@celygrowth.com"], transcript_url: `https://app.fireflies.ai/view/${id}`,
  meeting_link: "https://meet.google.com/abc-defg-hij", is_live: false,
  meeting_info: { silent_meeting: false, summary_status: "processing" }, summary: null, sentences: sentences(5),
  speakers: [{ id: 0, name: "Moi" }, { id: 1, name: "Client" }], meeting_attendees: [{ displayName: "Client", email: "client@acme-test.fr" }],
});

function fakeFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.fireflies.ai/graphql");
    const { query, variables } = JSON.parse(init.body as string);
    calls.push({ query, id: variables.id, auth: (init.headers as Record<string, string>).Authorization });
    const step = script.shift();
    if (step) return new Response(JSON.stringify(step.body ?? {}), { status: step.status ?? 200, headers: step.headers });
    if (query.includes("transcripts(")) return Response.json({ data: { transcripts: list } });
    return Response.json({ data: { user: { user_id: "ff-user-1", email: "moi@celygrowth.com" }, transcript: { ...meeting, id: variables.id } } });
  }));
}

// --- Aides ------------------------------------------------------------------
function hook(payload: object, opts: { sign?: string | null } = {}) {
  const raw = JSON.stringify(payload);
  const sig = opts.sign === undefined ? signPayload(raw, HOOK_SECRET) : opts.sign;
  return webhook(new Request("https://crm.test/api/fireflies/webhook", { method: "POST", body: raw, headers: sig ? { "x-hub-signature": sig } : {} }));
}
const event = (type: string, extra: object = {}, id = "meetTest1") => ({ event: type, meeting_id: id, timestamp: Date.now(), ...extra });
async function runAfter() {
  for (const fn of pending.splice(0)) await fn();
}
async function asOwner<T>(fn: () => Promise<T>) {
  await db.as("owner");
  return fn();
}
const rows = (sql: string) => asOwner(async () => (await db.query<Record<string, unknown>>(sql)).rows);
const overview = async (id = "meetTest1") =>
  asOwner(() => db.one<Record<string, unknown>>(`select * from fireflies_import_overview where meeting_id = $1`, [id]));
const graphqlTranscriptCalls = () => calls.filter((c) => c.query.includes("transcript(id")).length;
const processed = (extra: object = {}) => ({ ...baseMeeting(), meeting_info: { silent_meeting: false, summary_status: "processed" }, summary: { overview: "Résumé de l'appel", gist: "En bref", action_items: "Rappeler lundi" }, ...extra });

beforeEach(async () => {
  vi.stubEnv("APPOINTMENTS_SECRET", SECRET);
  vi.stubEnv("FIREFLIES_API_KEY", "cle-api-de-test");
  vi.stubEnv("FIREFLIES_WEBHOOK_SECRET", HOOK_SECRET);
  vi.stubEnv("CRON_SECRET", CRON);
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(serverRpcKey()).digest("hex") });
  expect(serverRpcKeyHash()).toMatch(/^[0-9a-f]{64}$/);
  calls = [];
  script = [];
  list = [];
  dbDown = false;
  pending.length = 0;
  meeting = baseMeeting();
  fakeFetch();
});

describe("webhook", () => {
  test("signature absente ou fausse : refus, rien d'enregistré", async () => {
    expect((await hook(event("meeting.transcribed"), { sign: null })).status).toBe(401);
    expect((await hook(event("meeting.transcribed"), { sign: "sha256=" + "0".repeat(64) })).status).toBe(401);
    expect(await rows(`select id from fireflies_import_jobs`)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("secret non configuré : 503, Fireflies retentera", async () => {
    vi.stubEnv("FIREFLIES_WEBHOOK_SECRET", "");
    expect((await hook(event("meeting.transcribed"))).status).toBe(503);
  });

  test("base indisponible : 503 et pas d'accusé de réception", async () => {
    dbDown = true;
    expect((await hook(event("meeting.transcribed"))).status).toBe(503);
    expect(pending).toEqual([]);
    dbDown = false;
    expect((await hook(event("meeting.transcribed"))).status).toBe(200);
    expect(await rows(`select id from fireflies_import_jobs`)).toHaveLength(1);
  });

  test("la tâche est enregistrée avant la réponse, le traitement vient après", async () => {
    expect((await hook(event("meeting.transcribed"))).status).toBe(200);
    expect(calls).toEqual([]);
    expect((await overview()).display_state).toBe("importing");
    expect(pending).toHaveLength(1);
  });

  test("contenu invalide : 400 ; autre événement : ignoré", async () => {
    expect((await hook({ event: "meeting.transcribed", meeting_id: "a b; drop" })).status).toBe(400);
    expect((await hook(event("meeting.bot_joined"))).status).toBe(200);
    expect(await rows(`select id from fireflies_import_jobs`)).toEqual([]);
  });
});

describe("import", () => {
  test("appel de test : tout est enregistré, jusqu'à la dernière ligne, sans clé dans le navigateur", async () => {
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await runAfter();
    const [call] = await rows(`select * from fireflies_calls`);
    expect(call).toMatchObject({
      account_id: "ff-user-1", fireflies_id: "meetTest1", title: "[TEST] Appel découverte", line_count: 5, summary_state: "available",
      transcript_url: "https://app.fireflies.ai/view/meetTest1", participants: ["client@acme-test.fr", "moi@celygrowth.com"],
    });
    expect(call.summary).toEqual({ overview: "Résumé de l'appel", gist: "En bref", action_items: "Rappeler lundi" });
    const [t] = await rows(`select lines from fireflies_call_transcripts`);
    expect(t.lines).toEqual(sentences(5).map((s) => ({ index: s.index, speaker: s.speaker_name, speaker_id: String(s.speaker_id), text: s.text, start: s.start_time, end: s.end_time })));
    expect((await overview()).display_state).toBe("imported");
    expect(calls[0].auth).toBe("Bearer cle-api-de-test");
    const conn = await asOwner(() => db.one<Record<string, unknown>>(`select * from fireflies_connection`));
    expect(conn.account_email).toBe("moi@celygrowth.com");
    expect(conn.last_success_at).not.toBeNull();
    expect(conn.last_webhook_at).not.toBeNull();
  });

  test("même événement rejoué : un seul appel, aucune requête Fireflies de plus", async () => {
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await runAfter();
    expect(graphqlTranscriptCalls()).toBe(1);
    for (let i = 0; i < 3; i++) {
      expect((await hook(event("meeting.transcribed"))).status).toBe(200);
      await runAfter();
    }
    expect(graphqlTranscriptCalls()).toBe(1);
    expect(await rows(`select id from fireflies_calls`)).toHaveLength(1);
    expect(await rows(`select id from fireflies_import_jobs`)).toHaveLength(1);
  });

  test("résumé tardif : complète le même appel", async () => {
    await hook(event("meeting.transcribed"));
    await runAfter();
    const before = await rows(`select id, summary_state from fireflies_calls`);
    expect(before).toMatchObject([{ summary_state: "pending" }]);
    expect((await overview()).display_state).toBe("summary_pending");
    expect((await overview()).job_status).toBe("waiting_summary");

    meeting = processed();
    await hook(event("meeting.summarized"));
    await runAfter();
    const after = await rows(`select id, summary_state, summary from fireflies_calls`);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[0].id);
    expect(after[0].summary_state).toBe("available");
    expect((await overview()).display_state).toBe("imported");
    expect((await overview()).job_status).toBe("done");
  });

  test("les deux événements avant le traitement : une seule requête", async () => {
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await hook(event("meeting.summarized"));
    await runAfter();
    expect(graphqlTranscriptCalls()).toBe(1);
    expect(await rows(`select id from fireflies_calls`)).toHaveLength(1);
  });

  test("résumé jamais livré : abandon au bout de 7 jours, l'appel reste importé", async () => {
    await hook(event("meeting.transcribed"));
    await runAfter();
    await asOwner(() => db.exec(`reset role; update fireflies_import_jobs set summary_deadline = now() - interval '1 minute', next_attempt_at = now();`));
    expect(await drainImports(sb as never)).toEqual({ processed: 1, failed: 0 });
    expect((await overview()).display_state).toBe("imported");
    expect((await overview()).summary_state).toBe("unavailable");
    expect((await overview()).job_status).toBe("done");
  });

  test("renvoi après modification : version plus récente reprise, plus ancienne ignorée", async () => {
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await runAfter();
    meeting = processed({ title: "[TEST] Titre corrigé", sentences: sentences(7) });
    await hook(event("meeting.transcribed", { reprocessed_at: 2000 }));
    await runAfter();
    expect(graphqlTranscriptCalls()).toBe(2);
    expect(await rows(`select title, line_count from fireflies_calls`)).toEqual([{ title: "[TEST] Titre corrigé", line_count: 7 }]);
    await hook(event("meeting.transcribed", { reprocessed_at: 2000 }));
    await hook(event("meeting.transcribed", { reprocessed_at: 1000 }));
    await runAfter();
    expect(graphqlTranscriptCalls()).toBe(2);
  });

  test("un résumé reçu n'est pas effacé, une transcription non plus", async () => {
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await runAfter();
    meeting = { ...baseMeeting(), summary: null, sentences: [], meeting_info: { silent_meeting: true, summary_status: "skipped" } };
    await hook(event("meeting.transcribed", { reprocessed_at: 5 }));
    await runAfter();
    const [c] = await rows(`select summary_state, summary, line_count from fireflies_calls`);
    expect(c).toMatchObject({ summary_state: "available", line_count: 5 });
    expect((c.summary as { overview: string }).overview).toBe("Résumé de l'appel");
    const [t] = await rows(`select jsonb_array_length(lines) n from fireflies_call_transcripts`);
    expect(t.n).toBe(5);
  });

  test("événement arrivé pendant le traitement : retraité ensuite, jamais perdu", async () => {
    await hook(event("meeting.transcribed"));
    const claimed = (await sb.rpc("fireflies_claim_jobs", { p_server_key: serverRpcKey(), p_limit: 1 })).data as { id: string; lock_token: string }[];
    expect(await sb.rpc("fireflies_enqueue", { p_server_key: serverRpcKey(), p_meeting_id: "meetTest1", p_event: "meeting.summarized", p_reprocessed_at: null })).toMatchObject({ data: "rerun" });
    const r = await sb.rpc("fireflies_store_call", {
      p_server_key: serverRpcKey(), p_job_id: claimed[0].id, p_lock_token: claimed[0].lock_token, p_account: { id: "ff-user-1" },
      p_call: { fireflies_id: "meetTest1", title: "x", line_count: 0, summary_state: "pending" }, p_lines: [],
    });
    expect(r.data).toMatchObject({ status: "pending" });
    meeting = processed();
    await drainImports(sb as never);
    expect((await overview()).display_state).toBe("imported");
  });

  test("traitement périmé : ne peut rien écraser ; transcription tronquée : refusée", async () => {
    await hook(event("meeting.transcribed"));
    const [job] = (await sb.rpc("fireflies_claim_jobs", { p_server_key: serverRpcKey(), p_limit: 1 })).data as { id: string; lock_token: string }[];
    const store = (token: string, count: number) => sb.rpc("fireflies_store_call", {
      p_server_key: serverRpcKey(), p_job_id: job.id, p_lock_token: token, p_account: { id: "ff-user-1" },
      p_call: { fireflies_id: "meetTest1", title: "x", line_count: count, summary_state: "pending" }, p_lines: [{ text: "a" }],
    });
    expect((await store("00000000-0000-0000-0000-000000000000", 1)).error?.message).toMatch(/autre traitement/);
    expect((await store(job.lock_token, 2)).error?.message).toMatch(/incomplète/);
    expect(await rows(`select id from fireflies_calls`)).toEqual([]);
    expect((await store(job.lock_token, 1)).data).toMatchObject({ line_count: 1 });
  });

  test("très longue transcription : 20 000 lignes, complètes et dans l'ordre", async () => {
    meeting = processed({ sentences: sentences(20_000) });
    await hook(event("meeting.transcribed"));
    await runAfter();
    const [c] = await rows(`select line_count from fireflies_calls`);
    expect(c.line_count).toBe(20_000);
    const [t] = await rows(`select jsonb_array_length(lines) n, lines -> 0 ->> 'text' first, lines -> 19999 ->> 'text' last from fireflies_call_transcripts`);
    expect(t).toEqual({ n: 20_000, first: "Phrase 0", last: "Phrase 19999" });
  });
});

describe("reprises", () => {
  test("erreur temporaire : reprise rapide dans le même passage", async () => {
    script = [{ status: 503 }];
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await runAfter();
    expect(graphqlTranscriptCalls()).toBe(2);
    expect((await overview()).display_state).toBe("imported");
  });

  test("appel introuvable : échec définitif, sans reprise, relançable et clair", async () => {
    script = [{ body: { errors: [{ code: "object_not_found", message: "contenu de l'API à ne pas conserver" }] } }];
    await hook(event("meeting.transcribed"));
    await runAfter();
    const o = await overview();
    expect(o.display_state).toBe("failed");
    expect(o.last_error_code).toBe("object_not_found");
    expect(o.last_error).not.toMatch(/contenu/);
    expect(graphqlTranscriptCalls()).toBe(1);

    await db.as("claude");
    await expect(db.rpc("fireflies_retry_job", { p_job_id: o.job_id })).rejects.toThrow(/réservée/);
    await db.as("owner");
    await db.rpc("fireflies_retry_job", { p_job_id: o.job_id });
    meeting = processed();
    await drainImports(sb as never);
    expect((await overview()).display_state).toBe("imported");
  });

  test("réessais bornés : Échec après 8 tentatives", async () => {
    const key = serverRpcKey();
    await hook(event("meeting.transcribed"));
    let last = "";
    for (let i = 0; i < 20 && last !== "failed"; i++) {
      await db.exec(`reset role; update fireflies_import_jobs set next_attempt_at = now() where status = 'pending';`);
      const [job] = (await sb.rpc("fireflies_claim_jobs", { p_server_key: key, p_limit: 1 })).data as { id: string; lock_token: string }[];
      last = (await sb.rpc("fireflies_job_failed", { p_server_key: key, p_job_id: job.id, p_lock_token: job.lock_token, p_kind: "temporary", p_code: "network", p_message: "m", p_retry_after: null })).data as string;
    }
    const o = await overview();
    expect(o.display_state).toBe("failed");
    expect(o.attempts).toBe(8);
  });

  test("fonction coupée en plein travail : reprise à l'expiration du verrou, bornée elle aussi", async () => {
    const key = serverRpcKey();
    await hook(event("meeting.transcribed"));
    expect((await sb.rpc("fireflies_claim_jobs", { p_server_key: key, p_limit: 1 })).data).toHaveLength(1);
    expect((await sb.rpc("fireflies_claim_jobs", { p_server_key: key, p_limit: 1 })).data).toEqual([]); // verrou actif
    await db.exec(`reset role; update fireflies_import_jobs set locked_until = now() - interval '1 second';`);
    expect((await sb.rpc("fireflies_claim_jobs", { p_server_key: key, p_limit: 1 })).data).toMatchObject([{ attempts: 2 }]);
    await db.exec(`reset role; update fireflies_import_jobs set locked_until = now() - interval '1 second', attempts = 8;`);
    expect((await sb.rpc("fireflies_claim_jobs", { p_server_key: key, p_limit: 1 })).data).toEqual([]);
    expect((await overview()).display_state).toBe("failed");
  });

  test("quota atteint (429) : respecte Retry-After, plus aucune requête pendant le blocage", async () => {
    script = [{ status: 429, headers: { "Retry-After": "120" }, body: { errors: [{ code: "too_many_requests" }] } }];
    await hook(event("meeting.transcribed"));
    await hook(event("meeting.transcribed", {}, "meetTest2"));
    await runAfter();
    expect(graphqlTranscriptCalls()).toBe(1);
    const c = await asOwner(() => db.one<{ s: number }>(`select extract(epoch from api_paused_until - now())::int s from fireflies_connection`));
    expect(c.s).toBeGreaterThan(100);
    expect(await drainImports(sb as never)).toEqual({ processed: 0, failed: 0 });
    expect((await overview()).display_state).toBe("importing");
  });

  test("clé API refusée : message clair, pas de réessai immédiat", async () => {
    script = [{ status: 401 }];
    await hook(event("meeting.transcribed"));
    await runAfter();
    const o = await overview();
    expect(o.last_error_code).toBe("auth");
    expect(graphqlTranscriptCalls()).toBe(1);
    expect(o.display_state).toBe("importing");
  });
});

describe("synchronisation périodique", () => {
  const authorized = () => new Request("https://crm.test/api/fireflies/cron", { headers: { authorization: `Bearer ${CRON}` } });

  test("sans le secret : refusé, aucun appel à Fireflies", async () => {
    for (const r of [new Request("https://crm.test/x"), new Request("https://crm.test/x", { headers: { authorization: "Bearer mauvais-secret-de-test" } })]) {
      expect((await cron(r)).status).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  test("session d'un autre compte : refusée ; session du propriétaire : acceptée", async () => {
    const { getSession } = await import("@/lib/auth");
    const session = (owner: boolean) => ({ supabase: { rpc: async () => ({ data: owner }) }, user: { id: "u", email: null } }) as never;
    vi.mocked(getSession).mockResolvedValueOnce(session(false));
    expect((await cron(new Request("https://crm.test/x"))).status).toBe(401);
    expect(calls).toEqual([]);
    vi.mocked(getSession).mockResolvedValueOnce(session(true));
    expect((await cron(new Request("https://crm.test/x"))).status).toBe(200);
  });

  test("rattrape un webhook perdu, sans doublon d'un passage à l'autre", async () => {
    list = [{ id: "meetRattrape" }];
    meeting = processed();
    const res = await cron(authorized());
    expect(await res.json()).toEqual({ sync: { seen: 1, queued: 1 }, drain: { processed: 1, failed: 0 } });
    expect((await overview("meetRattrape")).display_state).toBe("imported");
    const first = graphqlTranscriptCalls();
    await cron(authorized());
    expect(graphqlTranscriptCalls()).toBe(first);
    expect(await rows(`select id from fireflies_calls`)).toHaveLength(1);
    expect((await asOwner(() => db.one<Record<string, unknown>>(`select last_sync_at from fireflies_connection`))).last_sync_at).not.toBeNull();
  });

  test("liste Fireflies indisponible : les tâches déjà en attente sont quand même traitées", async () => {
    await hook(event("meeting.transcribed"));
    script = [{ status: 500 }];
    meeting = processed();
    const body = await (await cron(authorized())).json();
    expect(body.sync.error).toBeTruthy();
    expect(body.drain.processed).toBe(1);
  });
});

describe("confidentialité", () => {
  beforeEach(async () => {
    meeting = processed();
    await hook(event("meeting.transcribed"));
    await runAfter();
  });

  const TABLES = ["fireflies_connection", "fireflies_calls", "fireflies_call_transcripts", "fireflies_import_jobs", "fireflies_import_overview"];

  test("portail client et visiteur (rôle anon) : aucune table lisible", async () => {
    await db.as("anon");
    for (const t of TABLES) await expect(db.query(`select * from public.${t}`)).rejects.toThrow(/permission denied/);
  });

  test("autre compte connecté : aucune ligne", async () => {
    await db.as("stranger");
    for (const t of TABLES) expect((await db.query(`select * from public.${t}`)).rows).toEqual([]);
  });

  test("connecteur Claude : aucune ligne", async () => {
    await db.as("claude");
    for (const t of TABLES) expect((await db.query(`select * from public.${t}`)).rows).toEqual([]);
  });

  test("le propriétaire lit, mais n'écrit pas directement", async () => {
    await db.as("owner");
    expect((await db.query(`select * from fireflies_calls`)).rows).toHaveLength(1);
    await expect(db.exec(`update fireflies_calls set title = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(db.exec(`delete from fireflies_call_transcripts`)).rejects.toThrow(/permission denied/);
  });

  test("sans la clé serveur : toutes les fonctions refusent, y compris pour le propriétaire", async () => {
    for (const who of ["anon", "owner"] as const) {
      await db.as(who);
      await expect(db.rpc("fireflies_enqueue", { p_server_key: "x".repeat(40), p_meeting_id: "m", p_event: "sync", p_reprocessed_at: null })).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("fireflies_claim_jobs", { p_server_key: null, p_limit: 1 })).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("fireflies_sync_done", { p_server_key: "" })).rejects.toThrow(/Accès refusé/);
    }
  });

  test("relance : ni anon, ni autre compte", async () => {
    const id = "00000000-0000-0000-0000-00000000dead";
    await db.as("anon");
    await expect(db.rpc("fireflies_retry_job", { p_job_id: id })).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    await expect(db.rpc("fireflies_retry_job", { p_job_id: id })).rejects.toThrow(/Accès refusé/);
  });

  test("la clé serveur écrit mais ne ressort aucun contenu", async () => {
    const r = await sb.rpc("fireflies_claim_jobs", { p_server_key: serverRpcKey(), p_limit: 1 });
    expect(JSON.stringify(r.data)).not.toMatch(/Résumé|Phrase/);
  });

  test("les journaux ne contiennent jamais la transcription ni la clé", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    script = [{ body: { errors: [{ code: "forbidden", message: "Phrase confidentielle" }] } }];
    await hook(event("meeting.transcribed", {}, "meetFail"));
    await runAfter();
    const logs = spy.mock.calls.flat().join(" ");
    expect(logs).toContain("forbidden");
    expect(logs).not.toMatch(/confidentielle|Phrase|cle-api-de-test|Résumé/);
    spy.mockRestore();
  });
});

test("le webhook répond même si Fireflies est lent : aucun appel avant la réponse", async () => {
  const f = vi.fn();
  vi.stubGlobal("fetch", f);
  expect((await hook(event("meeting.summarized"))).status).toBe(200);
  expect(f).not.toHaveBeenCalled();
});
