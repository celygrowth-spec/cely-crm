// Déclenchement de la tâche Claude : jeton envoyé au seul point d'entrée prévu, jamais dans les erreurs.
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const URL_OK = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABC/fire";
const TOKEN = "sk-ant-oat01-secret";

afterEach(() => {
  delete process.env.DIAGNOSTIC_ROUTINE_URL;
  delete process.env.DIAGNOSTIC_ROUTINE_TOKEN;
});

const configure = (url = URL_OK) => {
  process.env.DIAGNOSTIC_ROUTINE_URL = url;
  process.env.DIAGNOSTIC_ROUTINE_TOKEN = TOKEN;
};
const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("fireRoutine", () => {
  test("sans configuration : rien n'est appelé", async () => {
    const { fireRoutine, routineConfig } = await import("@/lib/crm/diagnostic-trigger");
    const f = reply(200, {});
    expect(routineConfig()).toBeNull();
    await expect(fireRoutine("d1", f)).rejects.toThrow(/non configuré/);
    expect(f).not.toHaveBeenCalled();
  });

  test("une adresse autre que /fire d'Anthropic est ignorée", async () => {
    configure("https://exemple.com/v1/claude_code/routines/trig_01ABC/fire");
    const { routineConfig } = await import("@/lib/crm/diagnostic-trigger");
    expect(routineConfig()).toBeNull();
  });

  test("envoie le seul identifiant du dossier et rend l'adresse de la session", async () => {
    configure();
    const { fireRoutine } = await import("@/lib/crm/diagnostic-trigger");
    const f = reply(200, { type: "routine_fire", claude_code_session_url: "https://claude.ai/code/session_01X" });
    expect(await fireRoutine("d1", f)).toBe("https://claude.ai/code/session_01X");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toBe(JSON.stringify({ text: "d1" }));
  });

  test("les erreurs ne contiennent jamais le jeton", async () => {
    configure();
    const { fireRoutine } = await import("@/lib/crm/diagnostic-trigger");
    for (const status of [401, 429, 500]) {
      const err = await fireRoutine("d1", reply(status, { error: TOKEN })).catch((e: Error) => e.message);
      expect(err).not.toContain(TOKEN);
    }
    const down = await fireRoutine("d1", vi.fn(async () => { throw new Error(TOKEN); })).catch((e: Error) => e.message);
    expect(down).not.toContain(TOKEN);
  });
});

describe("triggerDiagnostic", () => {
  const sb = (claimed: boolean) => {
    const calls: [string, unknown][] = [];
    return { calls, client: { rpc: vi.fn(async (fn: string, args: unknown) => { calls.push([fn, args]); return { data: fn === "diagnostic_claim_trigger" ? claimed : null, error: null }; }) } };
  };
  const ID = "7da410d4-26e1-4f74-89fa-cc0512614f28";

  test("étape déjà réservée : aucun lancement en double", async () => {
    configure();
    const { triggerDiagnostic } = await import("@/lib/crm/diagnostic-trigger");
    const s = sb(false);
    const f = reply(200, {});
    expect(await triggerDiagnostic(s.client as never, ID, "start", f)).toEqual({ triggered: false });
    expect(f).not.toHaveBeenCalled();
  });

  test("échec : l'erreur est enregistrée pour pouvoir relancer", async () => {
    configure();
    const { triggerDiagnostic } = await import("@/lib/crm/diagnostic-trigger");
    const s = sb(true);
    const out = await triggerDiagnostic(s.client as never, ID, "start", reply(500, {}));
    expect(out.triggered).toBe(false);
    expect(s.calls.at(-1)).toEqual(["diagnostic_trigger_result", { p_id: ID, p_session_url: null, p_error: expect.stringContaining("500") }]);
  });

  test("succès : l'adresse de la session est conservée", async () => {
    configure();
    const { triggerDiagnostic } = await import("@/lib/crm/diagnostic-trigger");
    const s = sb(true);
    await triggerDiagnostic(s.client as never, ID, "answers", reply(200, { claude_code_session_url: "https://claude.ai/code/session_01Y" }));
    expect(s.calls.at(-1)).toEqual(["diagnostic_trigger_result", { p_id: ID, p_session_url: "https://claude.ai/code/session_01Y", p_error: null }]);
  });
});

describe("stageOf", () => {
  test("révision si la dernière version reçue porte un retour, sinon slides ou lancement", async () => {
    const { stageOf } = await import("@/lib/crm/diagnostic-rules");
    const v = (version: number, feedback: string | null) => ({ id: String(version), version, file_id: null, status: "ready" as const, created_at: "", ready_at: "", feedback, feedback_at: null });
    expect(stageOf({ answers_sent_at: null, versions: [] })).toBe("start");
    expect(stageOf({ answers_sent_at: "x", versions: [] })).toBe("answers");
    expect(stageOf({ answers_sent_at: "x", versions: [v(1, "retour")] })).toBe("revision");
    expect(stageOf({ answers_sent_at: "x", versions: [v(1, "retour"), v(2, null)] })).toBe("answers");
  });
});

