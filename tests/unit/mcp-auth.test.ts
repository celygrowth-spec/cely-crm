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
  test("outils prévus uniquement : ni envoi, ni fusion, suppressions limitées aux espaces client", async () => {
    const { registerTools } = await import("@/lib/mcp/tools");
    const names: string[] = [];
    registerTools({ registerTool: (n: string) => names.push(n) } as never, () => ({}) as never);
    expect(names.sort()).toEqual([
      "add_person",
      "add_project_member",
      "comment_project_idea",
      "comment_project_task",
      "confirm_diagnostic_version",
      "confirm_project_file_upload",
      "create_company",
      "create_project",
      "create_project_idea",
      "create_project_task",
      "create_task",
      "decide_project_idea",
      "delete_project_folder",
      "delete_project_task",
      "get_company",
      "get_diagnostic_email_thread",
      "get_diagnostic_file_url",
      "get_diagnostic_transcript",
      "get_library_file_url",
      "get_project",
      "get_project_file_url",
      "get_project_task",
      "idea_to_task",
      "link_project_meeting",
      "list_diagnostic_appointments",
      "list_diagnostic_calls",
      "list_diagnostic_emails",
      "list_diagnostic_files",
      "list_diagnostic_history",
      "list_followups",
      "list_linkable_bookings",
      "list_pipelines",
      "list_projects",
      "log_interaction",
      "move_company",
      "move_project_files",
      "open_diagnostic",
      "postpone_task",
      "preview_client_portal",
      "publish_meeting_recap",
      "remove_project_member",
      "rename_project_file",
      "report_diagnostic_failure",
      "revoke_portal_access",
      "save_diagnostic_questions",
      "save_diagnostic_research",
      "save_meeting_recap",
      "save_project_folder",
      "save_project_planning",
      "search_companies",
      "set_portal_access_expiry",
      "share_files_with_project",
      "start_diagnostic_version",
      "start_project_file_upload",
      "task_from_recap",
      "unlink_project_meeting",
      "unshare_project_file",
      "update_project",
      "update_project_meeting",
      "update_project_task",
    ]);
    expect(names.some((n) => /send|merge|bulk/.test(n))).toBe(false);
    expect(names.filter((n) => /delete/.test(n)).sort()).toEqual(["delete_project_folder", "delete_project_task"]);
  });

  test("la liste des outils se génère, espaces client compris", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    const res = await POST(
      new Request("https://crm.example.com/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer oauth-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const name of ["search_companies", "create_project", "save_project_planning", "publish_meeting_recap", "unshare_project_file"]) expect(body).toContain(`"${name}"`);
    expect(body).not.toContain("portal_access_issue");
  });
});
