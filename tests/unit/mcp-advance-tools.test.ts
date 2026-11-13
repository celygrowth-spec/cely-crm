// Outils MCP move_company et make_client : mêmes fonctions SQL que le menu « Actions » de la fiche.
// Sans accord de l'utilisateur, make_client n'écrit rien ; le choix des relances est transmis tel quel.
// Les règles en base sont testées dans tests/db/fiche-pipeline-client.test.ts.
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test, vi } from "vitest";

const CO = "11111111-1111-4111-8111-111111111111";
const ST = "22222222-2222-4222-8222-222222222222";
const PJ = "33333333-3333-4333-8333-333333333333";
let detail: Record<string, unknown>;
let projects: { id: string; name: string }[];

vi.mock("@/lib/crm/service", async (orig) => ({ ...(await orig<object>()), getCompanyDetail: async () => detail }));
vi.mock("@/lib/sales/service", async (orig) => ({ ...(await orig<object>()), saleContext: async () => ({ projects, missions: [] }), prepareProject: async () => undefined }));

const { registerAdvanceTools } = await import("@/lib/mcp/advance-tools");
type Handler = (args: Record<string, unknown>, sb: SupabaseClient) => Promise<{ content: { text: string }[] }>;
type Config = { inputSchema: { parse: (v: unknown) => Record<string, unknown> } };
const tools = new Map<string, { config: Config; fn: Handler }>();
registerAdvanceTools(((name: string, config: Config, fn: Handler) => tools.set(name, { config, fn })) as never);

let calls: { fn: string; args: Record<string, unknown> }[];
const fake = {
  from: () => { throw new Error("aucune lecture directe attendue"); },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "company_make_client") return { data: { sale_id: "s", project_id: PJ, mission_id: null, created: { sale: true, project: true }, moved: true, stopped_followups: 0, kept_followups: 1, task_id: "t" }, error: null };
    if (fn === "company_add_to_pipeline") return { data: { status: "moved", stopped_followups: 0, kept_followups: 1, task_id: null }, error: null };
    return { data: null, error: { message: "inattendu" } };
  },
} as unknown as SupabaseClient;
const call = async (name: string, args: Record<string, unknown>) => {
  const t = tools.get(name)!;
  return (await t.fn(t.config.inputSchema.parse(args), fake)).content[0].text;
};

beforeEach(() => {
  calls = [];
  projects = [];
  detail = {
    company: { id: CO, name: "[TEST] Studio", deal_status: "open", pipeline_id: null, pipeline: null, stage: null, merged_into_id: null },
    people: [{ id: "p", is_primary: true }],
    participants: [{ status: "en_cours" }],
  };
});

describe("make_client", () => {
  test("sans accord : rien n'est écrit ; questions sur l'étape et les relances", async () => {
    const out = await call("make_client", { company_id: CO, request_id: "req-00000001" });
    expect(out).toMatch(/rien n'a été fait/);
    expect(out).toMatch(/Par quelle étape/);
    expect(out).toMatch(/1 relance\(s\) de prospection en cours/);
    expect(calls).toEqual([]);
  });

  test("accord donné mais choix manquant (projet existant) : toujours rien d'écrit", async () => {
    projects = [{ id: PJ, name: "Refonte" }];
    const out = await call("make_client", { company_id: CO, stage_id: ST, followups: "keep", confirmed_by_user: true, request_id: "req-00000002" });
    expect(out).toMatch(/« Refonte »/);
    expect(calls).toEqual([]);
  });

  test("avec accord et réponses : une seule écriture, même fonction que la fiche", async () => {
    const out = await call("make_client", { company_id: CO, stage_id: ST, followups: "keep", revenue: { mode: "ponctuel", amount_eur: 1200, date: "2026-11-20" }, confirmed_by_user: true, request_id: "req-00000003" });
    expect(out).toMatch(/fiche passée en client/);
    expect(calls.map((c) => c.fn)).toEqual(["company_make_client"]);
    expect(calls[0].args).toMatchObject({ p_company: CO, p_stage: ST, p_followups: "keep", p_idempotency_key: "mcp:req-00000003" });
    expect((calls[0].args.p_sale as { revenue: unknown }).revenue).toEqual({ mode: "ponctuel", amount: "1200.00", date: "2026-11-20", end_date: null });
  });

  test("fiche déjà cliente : refus", async () => {
    (detail.company as Record<string, unknown>).deal_status = "won";
    await expect(call("make_client", { company_id: CO, confirmed_by_user: true, request_id: "req-00000004" })).rejects.toThrow(/déjà cliente/);
  });
});

describe("move_company", () => {
  test("transmet le choix des relances et passe par company_add_to_pipeline", async () => {
    const out = await call("move_company", { company_id: CO, stage_id: ST, followups: "keep", request_id: "req-00000005" });
    expect(out).toMatch(/relances_conservees": 1/);
    expect(calls).toEqual([{ fn: "company_add_to_pipeline", args: expect.objectContaining({ p_stage: ST, p_followups: "keep", p_idempotency_key: "mcp:req-00000005" }) }]);
  });
});
