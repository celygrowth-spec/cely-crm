// Connecteur Claude et espaces client : Claude peut tout ce que les outils MCP utilisent, chaque écriture
// est journalisée, et le verrou reste fermé pour les codes d'accès, les suppressions définitives,
// les rendez-vous et le reste du CRM.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let alice: string;
let pid: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "[TEST] Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
  alice = acme.people["alice@acme.fr"];
  pid = await project(db, acme.id, "[TEST] Site", [alice], false);
});

async function fileOnCompany(name = "Doc.pdf") {
  await db.query("reset role");
  const id = randomUUID();
  await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, $4, 'application/pdf', 10, 'ready')`, [id, acme.id, `${acme.id}/${id}.pdf`, name]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/${id}.pdf`]);
  return id;
}
const logged = async (table: string) => {
  await db.query("reset role");
  return (await db.query<{ operation: string; company_id: string | null; data: Record<string, unknown> }>(`select operation, company_id, data from activity_log where actor = 'claude' and table_name = $1 order by id`, [table])).rows;
};

async function booking() {
  await db.as("owner");
  const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  const typeId = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Point', $1, 30, $2) returning id`, [`point-${randomUUID().slice(0, 8)}`, sched])).id;
  const id = randomUUID();
  await db.rpc("appt_owner_book", {
    p_booking_id: id, p_type: typeId, p_starts_at: new Date(Date.now() + 8 * 86400_000).toISOString(), p_duration_min: 30, p_person: alice,
    p_calendar_target: false, p_token_hash: sha(id), p_idempotency_key: `cle-${id}`,
  });
  return id;
}

describe("Claude peut gérer un espace client", () => {
  test("créer un projet, et l'historique de la fiche indique Claude", async () => {
    await db.as("claude");
    const id = await db.rpc<string>("project_create", { p_data: JSON.stringify({ company_id: acme.id, name: "[TEST] Nouveau" }), p_person_ids: `{${alice}}` });
    expect((await db.one(`select portal_published, status from projects where id = $1`, [id]))).toMatchObject({ portal_published: false, status: "a_preparer" });
    expect(await db.one(`select source from interactions where meta ->> 'project_id' = $1`, [id])).toMatchObject({ source: "claude" });
    const journal = await logged("projects");
    expect(journal.at(-1)).toMatchObject({ operation: "INSERT", company_id: acme.id });
    expect((await logged("project_members")).at(-1)).toMatchObject({ operation: "INSERT", company_id: acme.id });
  });

  test("modifier et publier ; le client voit alors le projet", async () => {
    await db.as("claude");
    const r = await db.query(`update projects set client_update = 'Où en sommes-nous', status = 'en_cours', portal_published = true where id = $1 returning id`, [pid]);
    expect(r.rows).toHaveLength(1);
    const session = (await login(db, alice)).session;
    const view = await portal<{ client_update: string }>(db, "portal_project", session, { p_project: pid });
    expect(view.client_update).toBe("Où en sommes-nous");
    expect((await logged("projects")).some((l) => l.operation === "UPDATE")).toBe(true);
  });

  test("planning : créer, modifier, supprimer phases et jalons", async () => {
    await db.as("claude");
    const ph = (await db.one<{ id: string }>(`insert into project_phases (project_id, name, color, status) values ($1, 'Cadrage', 'violet', 'a_venir') returning id`, [pid])).id;
    const ms = (await db.one<{ id: string }>(`insert into project_milestones (project_id, title, due_date) values ($1, 'Kickoff', '2026-12-01') returning id`, [pid])).id;
    expect((await db.query(`update project_phases set status = 'en_cours' where id = $1 returning id`, [ph])).rows).toHaveLength(1);
    expect((await db.query(`delete from project_milestones where id = $1 returning id`, [ms])).rows).toHaveLength(1);
    expect((await db.query(`delete from project_phases where id = $1 returning id`, [ph])).rows).toHaveLength(1);
    expect((await logged("project_phases")).map((l) => l.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
    expect((await logged("project_milestones")).map((l) => l.company_id)).toEqual([acme.id, acme.id]);
  });

  test("tâches et commentaires", async () => {
    await db.as("claude");
    const t = (await db.one<{ id: string }>(`insert into project_tasks (project_id, title) values ($1, 'Maquette') returning id`, [pid])).id;
    expect((await db.query(`update project_tasks set status = 'en_cours', updated_by_kind = 'owner' where id = $1 returning id`, [t])).rows).toHaveLength(1);
    await db.query(`insert into project_task_comments (task_id, author_kind, body) values ($1, 'owner', 'Fait')`, [t]);
    expect((await logged("project_task_comments"))[0]).toMatchObject({ operation: "INSERT", company_id: acme.id });
    await db.as("claude");
    expect((await db.query(`delete from project_tasks where id = $1 returning id`, [t])).rows).toHaveLength(1);
    expect((await logged("project_tasks")).at(-1)?.operation).toBe("DELETE");
  });

  test("idées : proposer, décider, commenter, transformer en tâche", async () => {
    await db.as("claude");
    const i = (await db.one<{ id: string }>(`insert into project_ideas (project_id, title, author_kind) values ($1, 'Blog', 'owner') returning id`, [pid])).id;
    await db.query(`insert into project_idea_comments (idea_id, author_kind, body) values ($1, 'owner', 'Oui')`, [i]);
    expect((await db.query(`update project_ideas set status = 'plus_tard' where id = $1 returning id`, [i])).rows).toHaveLength(1);
    const task = await db.rpc<string>("project_idea_to_task", { p_idea: i });
    expect(task).toBeTruthy();
    expect(await logged("project_idea_comments")).toHaveLength(1);
    expect((await logged("project_tasks"))[0].company_id).toBe(acme.id);
  });

  test("contacts : ajouter, retirer, régler l'expiration et révoquer ; le journal ne garde jamais l'empreinte du code", async () => {
    await login(db, alice);
    await db.as("claude");
    await db.rpc("project_add_member", { p_project: pid, p_person: acme.people["bob@acme.fr"] });
    await db.rpc("project_remove_member", { p_project: pid, p_person: acme.people["bob@acme.fr"] });
    await db.rpc("portal_access_set_expiry", { p_person: alice, p_expires_at: "2027-01-01T00:00:00Z" });
    await db.rpc("portal_access_revoke", { p_person: alice });
    await db.query("reset role");
    expect(await db.one(`select revoked_at is not null as revoked from portal_accesses where person_id = $1`, [alice])).toMatchObject({ revoked: true });
    const journal = await logged("portal_accesses");
    expect(journal).toHaveLength(2);
    expect(journal[0].company_id).toBe(acme.id);
    expect(JSON.stringify(journal)).not.toMatch(/code_hash|code_hint/);
  });

  test("points : rattacher, modifier, récapitulatif, publier, détacher ; le rendez-vous reste", async () => {
    const b = await booking();
    await db.as("claude");
    const m = await db.rpc<string>("project_link_meeting", { p_project: pid, p_booking: b, p_visible: false });
    expect((await db.query(`update project_meetings set title = 'Point 1', visible_to_client = true where id = $1 returning id`, [m])).rows).toHaveLength(1);
    await db.query(`insert into meeting_recaps (meeting_id, summary, actions, links) values ($1, 'Résumé', '[]', '[]')`, [m]);
    await db.rpc("project_publish_recap", { p_meeting: m, p_publish: true });
    await db.query("reset role");
    expect(await db.one(`select status from meeting_recaps where meeting_id = $1`, [m])).toMatchObject({ status: "published" });
    expect((await logged("meeting_recaps")).map((l) => l.operation)).toEqual(["INSERT", "UPDATE"]);
    await db.as("claude");
    expect((await db.query(`delete from project_meetings where id = $1 returning id`, [m])).rows).toHaveLength(1);
    await db.query("reset role");
    expect((await db.query(`select 1 from appt_bookings where id = $1`, [b])).rows).toHaveLength(1);
  });

  test("dossiers et fichiers : partager, déplacer avec confirmation, retirer", async () => {
    const file = await fileOnCompany();
    await db.as("claude");
    const interne = (await db.rpc<{ id: string }>("project_folder_save", { p_project: pid, p_folder: null, p_name: "Interne", p_parent: null, p_visible: false, p_upload: false, p_confirm: false })).id;
    const pf = (await db.one<{ id: string }>(`insert into project_files (project_id, file_id, folder_id) values ($1, $2, $3) returning id`, [pid, file, interne])).id;
    // la protection contre l'exposition implicite s'applique aussi à Claude
    expect(await db.rpc("project_files_move", { p_project: pid, p_ids: `{${pf}}`, p_folder: null, p_confirm: false })).toEqual({ confirm: 1 });
    expect((await db.query(`update project_files set folder_id = null where id = $1 returning id`, [pf])).rows).toHaveLength(0);
    expect(await db.rpc("project_files_move", { p_project: pid, p_ids: `{${pf}}`, p_folder: null, p_confirm: true })).toEqual({ moved: 1 });
    expect(await db.rpc("project_folder_delete", { p_folder: interne, p_target: null, p_confirm: false })).toMatchObject({ deleted: true });
    expect((await db.query(`delete from project_files where id = $1 returning id`, [pf])).rows).toHaveLength(1);
    await db.query("reset role");
    expect((await db.query(`select 1 from company_files where id = $1`, [file])).rows).toHaveLength(1);
    expect((await logged("project_folders")).map((l) => l.operation)).toEqual(["INSERT", "DELETE"]);
    expect((await logged("project_files")).map((l) => l.operation)).toEqual(["INSERT", "UPDATE", "DELETE"]);
  });

  test("le journal d'un fichier de la fiche ne garde pas son chemin de stockage", async () => {
    const file = await fileOnCompany();
    await db.as("claude");
    await db.query(`update company_files set display_name = 'Nouveau.pdf' where id = $1`, [file]);
    const journal = await logged("company_files");
    expect(journal).toHaveLength(1);
    expect(journal[0].company_id).toBe(acme.id);
    expect(JSON.stringify(journal)).not.toContain("storage_path");
  });

  test("aperçu du portail et anti-doublons des créations", async () => {
    await db.as("claude");
    expect(await db.rpc("portal_preview_project", { p_project: pid, p_person: alice })).toHaveProperty("name", "[TEST] Site");
    await db.rpc("idem_get", { p_key: "mcp:essai-123" });
    await db.rpc("idem_put", { p_key: "mcp:essai-123", p_scope: "project_create", p_result: JSON.stringify({ id: pid }) });
    expect(await db.rpc("idem_get", { p_key: "mcp:essai-123" })).toEqual({ id: pid });
  });
});

describe("le verrou reste fermé", () => {
  test("Claude ne peut pas générer de code d'accès", async () => {
    await db.as("claude");
    await expect(db.rpc("portal_access_issue", { p_person: alice, p_code_hash: sha("code"), p_code_hint: "CODE", p_expires_at: null })).rejects.toThrow(/réservée à l'application/);
    await expect(db.query(`select code_hash from portal_accesses`)).rejects.toThrow(/permission denied/);
    expect((await db.query(`update portal_accesses set revoked_at = null returning id`)).rows).toHaveLength(0);
  });

  test("Claude ne peut ni supprimer un projet, ni effacer définitivement un fichier", async () => {
    const file = await fileOnCompany();
    await db.as("claude");
    expect((await db.query(`delete from projects where id = $1 returning id`, [pid])).rows).toHaveLength(0);
    expect((await db.query(`delete from company_files where id = $1 returning id`, [file])).rows).toHaveLength(0);
    expect((await db.query(`delete from storage.objects where bucket_id = 'company-files' returning id`)).rows).toHaveLength(0);
  });

  test("Claude ne peut ni créer un rendez-vous, ni écrire directement les membres et dossiers", async () => {
    await db.as("claude");
    const id = randomUUID();
    await expect(db.rpc("appt_owner_book", { p_booking_id: id, p_type: id, p_starts_at: "2027-01-01T10:00:00Z", p_duration_min: 30, p_person: alice, p_calendar_target: false, p_token_hash: sha(id), p_idempotency_key: `cle-${id}` })).rejects.toThrow();
    await expect(db.query(`insert into project_members (project_id, person_id) values ($1, $2)`, [pid, acme.people["bob@acme.fr"]])).rejects.toThrow(/row-level security/);
    await expect(db.query(`insert into project_folders (project_id, name) values ($1, 'X')`, [pid])).rejects.toThrow(/row-level security/);
  });

  test("le reste du CRM ne change pas : fusion et suppressions refusées à Claude", async () => {
    const other = await company(db, "[TEST] Autre", [{ first_name: "Zoé", email: "zoe@autre.fr" }]);
    await db.as("claude");
    await expect(db.rpc("merge_companies", { p_source: other.id, p_target: acme.id })).rejects.toThrow();
    expect((await db.query(`delete from people where id = $1 returning id`, [alice])).rows).toHaveLength(0);
    expect((await db.query(`delete from companies where id = $1 returning id`, [other.id])).rows).toHaveLength(0);
    expect((await db.query(`delete from tasks returning id`)).rows).toHaveLength(0);
  });

  test("un autre compte et un visiteur anonyme restent refusés", async () => {
    await db.as("stranger");
    await expect(db.rpc("project_create", { p_data: JSON.stringify({ company_id: acme.id, name: "X" }), p_person_ids: "{}" })).rejects.toThrow(/Accès refusé/);
    expect((await db.query(`update projects set name = 'X' returning id`)).rows).toHaveLength(0);
    expect((await db.query(`select id from project_tasks`)).rows).toHaveLength(0);
    await db.as("anon");
    await expect(db.rpc("project_create", { p_data: JSON.stringify({ company_id: acme.id, name: "X" }), p_person_ids: "{}" })).rejects.toThrow(/permission denied/);
    await expect(db.query(`select id from projects`)).rejects.toThrow(/permission denied/);
  });

  test("les écritures de l'application ne sont pas attribuées à Claude", async () => {
    await db.as("owner");
    await db.query(`update projects set name = 'Renommé' where id = $1`, [pid]);
    expect(await logged("projects")).toHaveLength(0);
  });

  test("le portail du client et la réservation publique restent ouverts", async () => {
    await db.as("owner");
    await db.query(`update projects set portal_published = true where id = $1`, [pid]);
    const r = await login(db, alice);
    expect(r.status).toBe("ok");
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261110000200_mcp_espaces_client.sql"), "utf8");
    expect(sql).not.toMatch(/revoke\s+execute\s+on\s+all\s+functions\s+in\s+schema\s+public/i);
    await db.query("reset role");
    const fn = await db.one<{ ok: boolean }>(`select has_function_privilege('anon', 'public.portal_login(text, text, text, text, text)', 'execute') as ok`);
    expect(fn.ok).toBe(true);
    const book = await db.one<{ n: number }>(`select count(*)::int as n from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'appt\\_%' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(book.n).toBeGreaterThan(0);
  });
});
