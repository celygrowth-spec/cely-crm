// Corbeille, lot 3 : Projets — un projet (et ses tâches, idées, planning, points) disparaît du CRM et du portail,
// revient à l'identique, ferme puis rouvre l'accès de ses contacts ; un document partagé reste ailleurs.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let other: string;
let alice: string;
let typeId: string;

const put = (kind: string, id: string) => db.rpc<{ trash_id: string; summary: Record<string, number> }>("trash_put", { p_kind: kind, p_id: id });
const restore = (t: string, withParent = false) => db.rpc<Record<string, unknown>>("trash_restore", { p_trash: t, p_with_parent: withParent });
const rows = async (sql: string, params?: unknown[]) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const admin = async <T>(fn: () => Promise<T>) => { await db.exec("reset role"); const r = await fn(); await db.as("owner"); return r; };
/** Contenu brut d'un projet (droits d'administration) : sert à vérifier une restauration à l'identique. */
const snapshot = (projectId: string) => admin(async () => {
  const q = async (sql: string) => (await db.query<{ j: unknown }>(sql, [projectId])).rows.map((r) => r.j);
  return {
    project: await q(`select to_jsonb(p) j from projects p where id = $1`),
    members: await q(`select to_jsonb(m) j from project_members m where project_id = $1 order by person_id`),
    tasks: await q(`select to_jsonb(t) j from project_tasks t where project_id = $1 order by id`),
    comments: await q(`select to_jsonb(c) j from project_task_comments c join project_tasks t on t.id = c.task_id where t.project_id = $1 order by c.id`),
    ideas: await q(`select to_jsonb(i) j from project_ideas i where project_id = $1 order by id`),
    phases: await q(`select to_jsonb(x) j from project_phases x where project_id = $1 order by id`),
    milestones: await q(`select to_jsonb(x) j from project_milestones x where project_id = $1 order by id`),
    files: await q(`select to_jsonb(x) j from project_files x where project_id = $1 order by id`),
  };
});

async function ownerFile(name: string) {
  await db.query("reset role");
  const id = randomUUID();
  await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, $4, 'application/pdf', 1000, 'ready')`,
    [id, acme.id, `${acme.id}/${id}.pdf`, name]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/${id}.pdf`]);
  await db.as("owner");
  return id;
}
async function booking() {
  await db.as("owner");
  const id = randomUUID();
  const t = new Date(Date.now() + 3 * 86400_000); t.setUTCHours(10, 0, 0, 0);
  await db.rpc("appt_owner_book", { p_booking_id: id, p_type: typeId, p_starts_at: t.toISOString(), p_duration_min: null, p_person: acme.people["alice@acme.example.test"],
    p_calendar_target: false, p_token_hash: sha(id), p_idempotency_key: `k-${id}` });
  return id;
}

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  typeId = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Point', 'point', 45, $1) returning id`, [sched])).id;
  acme = await company(db, "[TEST] Acme", [{ first_name: "Alice", email: "alice@acme.example.test" }, { first_name: "Bob", email: "bob@acme.example.test" }]);
  pid = await project(db, acme.id, "[TEST] Site", [acme.people["alice@acme.example.test"], acme.people["bob@acme.example.test"]]);
  other = await project(db, acme.id, "[TEST] Autre", [acme.people["alice@acme.example.test"]]);
  alice = (await login(db, acme.people["alice@acme.example.test"])).session;
  await db.as("owner");
});

async function fillProject() {
  await db.query(`insert into project_tasks (project_id, title, visible_to_client, assignee_kind) values ($1, 'Valider la maquette', true, 'client'), ($1, 'Préparer la recette', false, 'owner')`, [pid]);
  const task = (await db.one<{ id: string }>(`select id from project_tasks where project_id = $1 and visible_to_client order by created_at limit 1`, [pid])).id;
  await db.query(`insert into project_task_comments (task_id, author_kind, body) values ($1, 'owner', 'Première version en ligne')`, [task]);
  await db.query(`insert into project_ideas (project_id, title, author_kind) values ($1, 'Ajouter un blog', 'owner')`, [pid]);
  await db.query(`insert into project_phases (project_id, position, name, start_date, end_date, status) values ($1, 0, 'Cadrage', '2026-11-01', '2026-11-30', 'en_cours')`, [pid]);
  const phase = (await db.one<{ id: string }>(`select id from project_phases where project_id = $1`, [pid])).id;
  await db.query(`insert into project_milestones (project_id, phase_id, title, due_date, visible_to_client) values ($1, $2, 'Maquette', '2026-11-20', true)`, [pid, phase]);
  return { task, phase };
}

describe("Projet avec tâches et contacts au portail", () => {
  test("disparaît du CRM et du portail ; l'accès des contacts est fermé puis rouvert ; restauration à l'identique", async () => {
    const { task } = await fillProject();
    const before = await snapshot(pid);
    expect((await portal<{ projects: { id: string }[] }>(db, "portal_me", alice)).projects.map((p) => p.id)).toContain(pid);

    await db.as("owner");
    const preview = await db.rpc<{ summary: Record<string, number>; warnings: string[] }>("trash_preview", { p_kind: "project", p_id: pid });
    expect(preview.summary).toMatchObject({ project_tasks: 2, project_task_comments: 1, project_ideas: 1, project_phases: 1, project_milestones: 1 });
    expect(preview.warnings.join(" ")).toMatch(/2 contacts du portail ne verront plus ce projet/);
    const t = await put("project", pid);

    // CRM : listes, vue d'ensemble, accès direct par identifiant
    await db.as("owner");
    expect(await rows(`select id from projects where id = $1`, [pid])).toEqual([]);
    expect(await rows(`select id from project_overview where id = $1`, [pid])).toEqual([]);
    expect(await rows(`select id from project_tasks where project_id = $1`, [pid])).toEqual([]);
    expect(await rows(`select 1 from project_members where project_id = $1`, [pid])).toEqual([]);
    // Claude (même compte) : rien non plus
    await db.as("claude");
    expect(await rows(`select id from projects where id = $1`, [pid])).toEqual([]);
    // Portail : projet absent, et identifiants manipulés refusés
    expect((await portal<{ projects: { id: string }[] }>(db, "portal_me", alice)).projects.map((p) => p.id)).toEqual([other]);
    await expect(portal(db, "portal_project", alice, { p_project: pid })).rejects.toThrow(/introuvable/);
    await expect(portal(db, "portal_task", alice, { p_task: task })).rejects.toThrow(/introuvable/);
    await expect(portal(db, "portal_task_comment", alice, { p_task: task, p_body: "test" })).rejects.toThrow(/introuvable/);
    expect(await portal(db, "portal_tasks", alice, { p_project: null, p_limit: 100 })).toEqual([]);
    // l'autre projet reste accessible
    await portal(db, "portal_project", alice, { p_project: other });

    await db.as("owner");
    expect(await restore(t.trash_id)).toMatchObject({ restored: true });
    expect(await snapshot(pid)).toEqual(before);
    expect((await portal<{ projects: { id: string }[] }>(db, "portal_me", alice)).projects.map((p) => p.id).sort()).toEqual([pid, other].sort());
    expect((await portal<unknown[]>(db, "portal_tasks", alice, { p_project: pid, p_limit: 100 })).length).toBe(1);
  });

  test("un document partagé reste sur la fiche et dans l'autre projet ; seul le lien part", async () => {
    const f = await ownerFile("[TEST] Charte.pdf");
    await db.query(`insert into project_files (project_id, file_id) values ($1, $2), ($3, $2)`, [pid, f, other]);
    const t = await put("project", pid);
    expect(t.summary).toMatchObject({ project_files: 1 });
    expect((await rows(`select id from company_files where id = $1`, [f])).length).toBe(1);
    expect((await rows(`select id from project_files where project_id = $1 and file_id = $2`, [other, f])).length).toBe(1);
    const files = await portal<{ files: { name: string }[] }>(db, "portal_files", alice, { p_project: other, p_limit: 100, p_offset: 0 });
    expect(files.files.map((x) => x.name)).toEqual(["[TEST] Charte.pdf"]);
    // purge du projet : le fichier n'est pas supprimé (il appartient à la fiche)
    await db.as("owner");
    expect(await db.rpc("trash_purge", { p_trash: t.trash_id })).toEqual({ purged: true, files: [] });
    expect((await rows(`select id from company_files where id = $1`, [f])).length).toBe(1);
    expect(await admin(() => rows(`select id from projects where id = $1`, [pid]))).toEqual([]);
  });

  test("un point de suivi à la corbeille : le rendez-vous reste dans l'agenda", async () => {
    const b = await booking();
    const m = await db.rpc<string>("project_link_meeting", { p_project: pid, p_booking: b, p_visible: true, p_title: "Point d'étape", p_agenda: null });
    await db.query(`insert into meeting_recaps (meeting_id, summary, status, published_at) values ($1, 'Maquette validée', 'published', now())`, [m]);
    const t = await put("project_meeting", m);
    expect(await rows(`select meeting_id from meeting_recaps where meeting_id = $1`, [m])).toEqual([]);
    expect((await rows(`select id from appt_bookings where id = $1`, [b])).length).toBe(1);
    expect((await portal<{ meetings: unknown[] }>(db, "portal_project", alice, { p_project: pid })).meetings).toEqual([]);
    await expect(portal(db, "portal_meeting", alice, { p_project: pid, p_meeting: m })).rejects.toThrow(/introuvable/);
    expect(await portal(db, "portal_upcoming_meetings", alice, { p_limit: 5 })).toEqual([]);
    await db.as("owner");
    await restore(t.trash_id);
    expect((await portal<{ meetings: unknown[] }>(db, "portal_project", alice, { p_project: pid })).meetings.length).toBe(1);
    await db.as("owner");
    expect((await rows(`select summary from meeting_recaps where meeting_id = $1`, [m]))).toEqual([{ summary: "Maquette validée" }]);
  });
});

describe("Éléments d'un projet", () => {
  test("tâche : disparaît du portail (identifiant direct compris) ; restaurer avec le projet à la corbeille propose le projet", async () => {
    const { task } = await fillProject();
    const tt = await put("project_task", task);
    expect(tt.summary).toEqual({ project_task_comments: 1 });
    expect(await portal(db, "portal_tasks", alice, { p_project: pid, p_limit: 100 })).toEqual([]);
    await expect(portal(db, "portal_task_update", alice, { p_task: task, p_status: "termine", p_blocked_reason: null })).rejects.toThrow(/introuvable/);
    await db.as("owner");
    const tp = await put("project", pid);
    expect(await restore(tt.trash_id)).toMatchObject({ restored: false, needs_parent: { trash_id: tp.trash_id, kind: "project" } });
    expect(await restore(tt.trash_id, true)).toMatchObject({ restored: true });
    expect((await rows(`select id from project_tasks where id = $1`, [task])).length).toBe(1);
    expect(await rows(`select * from trash_items`)).toEqual([]);
  });

  test("idée : disparaît du portail ; ni commentaire ni modification possibles par identifiant", async () => {
    await fillProject();
    const idea = (await db.one<{ id: string }>(`select id from project_ideas where project_id = $1`, [pid])).id;
    const t = await put("project_idea", idea);
    expect(await portal(db, "portal_ideas", alice, { p_project: pid })).toEqual([]);
    await expect(portal(db, "portal_idea_comment", alice, { p_project: pid, p_idea: idea, p_body: "x" })).rejects.toThrow(/introuvable/);
    await expect(portal(db, "portal_idea_save", alice, { p_project: pid, p_idea: idea, p_title: "x", p_description: null })).rejects.toThrow(/introuvable/);
    await db.as("owner");
    await restore(t.trash_id);
    expect((await portal<unknown[]>(db, "portal_ideas", alice, { p_project: pid })).length).toBe(1);
  });

  test("phase du planning : part avec ses jalons, hors du planning du portail ; revient à l'identique", async () => {
    const { phase } = await fillProject();
    const before = await snapshot(pid);
    const t = await put("project_phase", phase);
    expect(t.summary).toEqual({ project_milestones: 1 });
    const view = await portal<{ phases: unknown[]; milestones: unknown[] }>(db, "portal_project", alice, { p_project: pid });
    expect(view.phases).toEqual([]);
    expect(view.milestones).toEqual([]);
    await db.as("owner");
    await restore(t.trash_id);
    expect(await snapshot(pid)).toEqual(before);
  });
});

describe("Purge d'un projet", () => {
  test("après 30 jours : le projet et son contenu sont supprimés ; fiche, contacts, accès et rendez-vous restent", async () => {
    await fillProject();
    const b = await booking();
    await db.rpc<string>("project_link_meeting", { p_project: pid, p_booking: b, p_visible: true, p_title: null, p_agenda: null });
    const t = await put("project", pid);
    await db.exec(`reset role; update trash_items set purge_after = now() - interval '1 day' where id = '${t.trash_id}'`);
    await db.as("anon");
    expect(await db.rpc("trash_purge_due", { p_server_key: SERVER_KEY })).toMatchObject({ purged: 1, failed: 0 });
    await db.exec("reset role");
    for (const tbl of ["projects"]) expect(await rows(`select id from ${tbl} where id = $1`, [pid])).toEqual([]);
    for (const tbl of ["project_tasks", "project_ideas", "project_phases", "project_milestones", "project_meetings", "project_members"]) {
      expect(await rows(`select 1 from ${tbl} where project_id = $1`, [pid])).toEqual([]);
    }
    expect((await rows(`select id from companies where id = $1`, [acme.id])).length).toBe(1);
    expect((await rows(`select id from appt_bookings where id = $1`, [b])).length).toBe(1);
    expect((await rows(`select id from portal_accesses`)).length).toBeGreaterThan(0);
    // l'autre projet est intact et toujours visible au portail
    expect((await portal<{ projects: { id: string }[] }>(db, "portal_me", alice)).projects.map((p) => p.id)).toEqual([other]);
  });
});
