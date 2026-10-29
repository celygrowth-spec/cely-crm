// Le connecteur refuse toute requête sans jeton OAuth valide et indique où s'authentifier.
import { beforeAll, describe, expect, test, vi } from "vitest";

beforeAll(() => {
  process.env.SUPABASE_URL = "https://projet-test.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
});

vi.mock("@supabase/supabase-js", async (orig) => {
  const real = await orig<typeof import("@supabase/supabase-js")>();
  return {
    ...real,
    // simule Supabase : seul « oauth-token » est valide et porte un client_id ; « session-token » est un jeton de session classique
    createClient: () => ({
      auth: {
        getClaims: async (t: string) =>
          t === "oauth-token"
            ? { data: { claims: { sub: "u1", client_id: "claude", exp: 9999999999 } }, error: null }
            : t === "session-token"
              ? { data: { claims: { sub: "u1" } }, error: null }
              : { data: null, error: new Error("invalid") },
      },
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { user_id: "u1" } }) }) }) }),
    }),
  };
});

const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

async function call(token?: string) {
  const { POST } = await import("@/app/api/mcp/route");
  return POST(
    new Request("https://crm.example.com/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(initialize),
    }),
  );
}

describe("connecteur MCP : authentification", () => {
  test("sans jeton : 401 et lien vers les métadonnées OAuth", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/api/mcp");
  });

  test("jeton invalide : 401", async () => {
    expect((await call("forged")).status).toBe(401);
  });

  test("jeton de session (sans client OAuth) : refusé", async () => {
    expect((await call("session-token")).status).toBe(401);
  });

  test("jeton OAuth du propriétaire : accepté", async () => {
    const res = await call("oauth-token");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("cely-crm");
  });

  test("métadonnées de ressource protégée : Supabase Auth comme serveur d'autorisation", async () => {
    const { GET } = await import("@/app/.well-known/oauth-protected-resource/route");
    const res = GET(new Request("https://crm.example.com/.well-known/oauth-protected-resource"));
    const json = await res.json();
    expect(json.authorization_servers).toEqual(["https://projet-test.supabase.co/auth/v1"]);
  });
});

describe("connecteur MCP : périmètre des outils", () => {
  test("outils prévus uniquement : ni envoi, ni fusion, ni suppression", async () => {
    const { registerTools } = await import("@/lib/mcp/tools");
    const names: string[] = [];
    registerTools({ registerTool: (n: string) => names.push(n) } as never, () => ({}) as never);
    expect(names.sort()).toEqual([
      "add_person",
      "create_company",
      "create_task",
      "get_company",
      "list_followups",
      "list_pipelines",
      "log_interaction",
      "move_company",
      "postpone_task",
      "search_companies",
    ]);
    expect(names.some((n) => /send|merge|delete|bulk/.test(n))).toBe(false);
  });
});
