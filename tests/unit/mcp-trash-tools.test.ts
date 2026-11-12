// Outil MCP « move_to_trash » : sans l'accord de l'utilisateur rien n'est écrit ; avec lui, une seule écriture
// (trash_put), jamais de suppression directe. Les règles en base sont testées dans tests/db/corbeille*.
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test } from "vitest";
import { registerTrashTools } from "@/lib/mcp/trash-tools";

const X = "22222222-2222-4222-8222-222222222222";
type Handler = (args: Record<string, unknown>, sb: SupabaseClient) => Promise<{ content: { text: string }[] }>;
type Config = { inputSchema: { parse: (v: unknown) => Record<string, unknown> } };
const tools = new Map<string, { config: Config; fn: Handler }>();
registerTrashTools(((name: string, config: Config, fn: Handler) => tools.set(name, { config, fn })) as never);

let calls: string[];
const preview = { kind: "finance_invoice", label: "Facture F-1", context: "[TEST] Acme", warnings: ["Son numéro reste réservé"], summary: { finance_payments: 2 } };
const fake = {
  from: () => { throw new Error("aucune lecture ni écriture directe attendue"); },
  rpc: async (fn: string) => {
    calls.push(fn);
    if (fn === "trash_preview") return { data: preview, error: null };
    if (fn === "trash_put") return { data: { trash_id: X, already: false, label: "Facture F-1", kind: "finance_invoice" }, error: null };
    return { data: null, error: { message: "inattendu" } };
  },
} as unknown as SupabaseClient;
const call = async (args: Record<string, unknown>) => {
  const t = tools.get("move_to_trash")!;
  return (await t.fn(t.config.inputSchema.parse(args), fake)).content[0].text;
};

beforeEach(() => { calls = []; });

describe("move_to_trash", () => {
  test("sans accord : rien n'est fait, la réponse dit ce qui partirait", async () => {
    const out = await call({ kind: "finance_invoice", id: X });
    expect(out).toMatch(/rien n'a été fait/);
    expect(out).toMatch(/2 règlements/);
    expect(out).toMatch(/reste réservé/);
    expect(calls).toEqual(["trash_preview"]);
  });

  test("avec accord : mise à la corbeille, restauration annoncée", async () => {
    const out = await call({ kind: "finance_invoice", id: X, confirmed_by_user: true });
    expect(out).toMatch(/mis à la corbeille/);
    expect(out).toMatch(/30 jours/);
    expect(calls).toEqual(["trash_preview", "trash_put"]);
  });

  test("type inconnu refusé avant tout appel", async () => {
    await expect(call({ kind: "pipeline", id: X, confirmed_by_user: true })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
