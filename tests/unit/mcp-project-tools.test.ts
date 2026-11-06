// Outils MCP des espaces client : ce qui est exposé, ce qui ne l'est pas, et l'attente de l'accord de
// l'utilisateur (aucune écriture sans lui). Les droits en base sont testés dans tests/db/mcp-espaces-client.
import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, test } from "vitest";
import { registerProjectTools } from "@/lib/mcp/project-tools";
import { projectPatchSchema, taskPatchSchema } from "@/lib/projects/schemas";

const P = "11111111-1111-4111-8111-111111111111";
const X = "22222222-2222-4222-8222-222222222222";
type Handler = (args: Record<string, unknown>, sb: SupabaseClient) => Promise<{ content: { text: string }[] }>;
type Config = { readOnly?: boolean; inputSchema: { parse: (v: unknown) => Record<string, unknown> } };
const tools = new Map<string, { config: Config; fn: Handler }>();
registerProjectTools(((name: string, config: Config, fn: Handler) => tools.set(name, { config, fn })) as never);

/** Faux client Supabase : lectures servies par `rows`, écritures comptées. */
let writes: string[];
function fake(rows: Record<string, unknown>): SupabaseClient {
  const chain = (table: string) => {
    let write = false;
    const q: Record<string, unknown> = {};
    const self = () => q;
    for (const m of ["select", "eq", "order", "limit", "not", "in"]) q[m] = self;
    for (const m of ["insert", "update", "upsert", "delete"]) q[m] = () => { writes.push(`${m}:${table}`); write = true; return q; };
    const result = () => ({ data: write ? [{ id: X }] : (rows[table] ?? null), error: null });
    q.maybeSingle = async () => result();
    q.single = async () => ({ data: write ? { id: X } : (rows[table] ?? null), error: null });
    q.then = (ok: (v: unknown) => unknown) => ok(result());
    return q;
  };
  return {
    from: chain,
    rpc: async (fn: string) => {
      if (!fn.startsWith("idem_")) writes.push(`rpc:${fn}`);
      return { data: fn === "project_create" ? X : (rows[`rpc:${fn}`] ?? null), error: null };
    },
  } as unknown as SupabaseClient;
}
const call = async (name: string, args: Record<string, unknown>, rows: Record<string, unknown> = {}) => {
  const t = tools.get(name)!;
  return (await t.fn(t.config.inputSchema.parse(args), fake(rows))).content[0].text;
};
const WAITING = /rien n'a été fait/;
const rid = "demande-12345";

beforeEach(() => {
  writes = [];
});

describe("périmètre", () => {
  test("aucun outil de code d'accès, d'effacement de fichier, ni de rendez-vous", () => {
    const names = [...tools.keys()];
    expect(names).toContain("create_project");
    for (const banned of [/issue/, /generate/, /regenerate/, /delete_project_file/, /delete_file/, /delete_project$/, /create_meeting/, /reschedule/, /cancel/]) {
      expect(names.filter((n) => banned.test(n))).toEqual([]);
    }
  });

  test("les outils d'écriture ne sont pas annoncés comme lecture seule", () => {
    const read = [...tools].filter(([, t]) => t.config.readOnly).map(([n]) => n).sort();
    expect(read).toEqual(["get_project", "get_project_file_url", "get_project_task", "list_linkable_bookings", "list_projects", "preview_client_portal"]);
  });
});

describe("sans l'accord de l'utilisateur, rien n'est écrit", () => {
  const draft = { projects: { portal_published: false, company_id: X } };
  const live = { projects: { portal_published: true, company_id: X } };
  const cases: [string, string, Record<string, unknown>, Record<string, unknown>][] = [
    ["publier", "update_project", { project_id: P, portal_published: true }, draft],
    ["archiver", "update_project", { project_id: P, status: "archive" }, draft],
    ["modifier un projet publié", "update_project", { project_id: P, name: "Nouveau" }, live],
    ["ajouter un contact à un projet publié", "add_project_member", { project_id: P, person_id: X }, live],
    ["retirer un contact", "remove_project_member", { project_id: P, person_id: X }, draft],
    ["régler l'expiration", "set_portal_access_expiry", { person_id: X, expires_at: null }, draft],
    ["révoquer un accès", "revoke_portal_access", { person_id: X }, draft],
    ["rattacher un point visible", "link_project_meeting", { project_id: P, booking_id: X, visible: true }, draft],
    ["détacher un point", "unlink_project_meeting", { meeting_id: X }, { project_meetings: { id: X } }],
    ["publier un récapitulatif", "publish_meeting_recap", { meeting_id: X, publish: true }, draft],
    ["modifier un récapitulatif publié", "save_meeting_recap", { meeting_id: X, actions: [], links: [] }, { project_meetings: { id: X }, meeting_recaps: { status: "published" } }],
    ["tâche pour le client", "create_project_task", { project_id: P, title: "T", assignee_kind: "client", request_id: rid }, draft],
    ["supprimer une tâche", "delete_project_task", { task_id: X }, { project_tasks: { title: "T" } }],
    ["action en tâche", "task_from_recap", { meeting_id: X, action_index: 0 }, draft],
    ["idée sur un projet publié", "create_project_idea", { project_id: P, title: "I", request_id: rid }, live],
    ["dossier visible", "save_project_folder", { project_id: P, name: "D", visible_to_client: true, client_can_upload: false }, draft],
    ["supprimer un dossier", "delete_project_folder", { folder_id: X, target_folder_id: null }, { project_folders: { name: "D" } }],
    ["fichier à la racine", "confirm_project_file_upload", { project_id: P, file_id: X, folder_id: null }, draft],
    ["partager à la racine", "share_files_with_project", { project_id: P, file_ids: [X], folder_id: null }, draft],
    ["retirer un fichier", "unshare_project_file", { project_file_id: X }, { project_files: { id: X } }],
  ];
  test.each(cases)("%s", async (_label, name, args, rows) => {
    expect(await call(name, args, rows)).toMatch(WAITING);
    expect(writes).toEqual([]);
  });

  test("le planning signale ce qui serait supprimé", async () => {
    const r = await call("save_project_planning", { project_id: P, phases: [], milestones: [] }, { ...draft, project_phases: [{ id: X, name: "Cadrage" }], project_milestones: [] });
    expect(r).toMatch(WAITING);
    expect(r).toContain("Cadrage");
    expect(writes).toEqual([]);
  });

  test("un déplacement que la base refuse sans confirmation est présenté comme non fait", async () => {
    const r = await call("move_project_files", { project_id: P, project_file_ids: [X], folder_id: null }, { "rpc:project_files_move": { confirm: 2 } });
    expect(r).toMatch(WAITING);
    expect(r).toContain("2 document");
  });
});

describe("avec l'accord, ou sans effet pour le client", () => {
  const draft = { projects: { portal_published: false, company_id: X } };

  test("créer un espace client : invisible, sans accord à demander", async () => {
    expect(await call("create_project", { company_id: P, name: "[TEST] Site", request_id: rid })).toContain("non publié");
    expect(writes).toEqual(["rpc:project_create"]);
  });

  test("note interne sur un projet publié : sans accord", async () => {
    expect(await call("update_project", { project_id: P, internal_note: "Note" }, { projects: { portal_published: true } })).toContain("modifié");
    expect(writes).toEqual(["update:projects"]);
  });

  test("tâche interne : sans accord", async () => {
    expect(await call("create_project_task", { project_id: P, title: "T", request_id: rid }, draft)).toContain("tâche créée");
    expect(writes).toEqual(["insert:project_tasks"]);
  });

  test("publier avec l'accord", async () => {
    expect(await call("update_project", { project_id: P, portal_published: true, confirmed_by_user: true }, draft)).toContain("modifié");
    expect(writes).toEqual(["update:projects"]);
  });

  test("révoquer avec l'accord", async () => {
    expect(await call("revoke_portal_access", { person_id: X, confirmed_by_user: true })).toContain("accès révoqué");
    expect(writes).toEqual(["rpc:portal_access_revoke"]);
  });

  test("un élément introuvable est une erreur, pas un succès", async () => {
    await expect(call("delete_project_task", { task_id: X, confirmed_by_user: true })).rejects.toThrow(/introuvable/);
    expect(writes).toEqual([]);
  });
});

describe("validation des modifications partielles", () => {
  test("un champ non fourni n'est pas effacé", () => {
    expect(projectPatchSchema.parse({ internal_note: "Note", name: undefined, description: undefined })).not.toHaveProperty("description", null);
    expect(taskPatchSchema.parse({ status: "en_cours", description: undefined })).not.toHaveProperty("description", null);
  });
});
