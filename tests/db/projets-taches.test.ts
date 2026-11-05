// Projets — phase 3 : tâches. Visibilité explicite, droits client limités, une seule ligne par action.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let p1: string;
let p2: string;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
  p1 = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"], acme.people["bob@acme.fr"]]);
  p2 = await project(db, acme.id, "Logo", [acme.people["alice@acme.fr"]]);
  alice = (await login(db, acme.people["alice@acme.fr"])).session;
  bob = (await login(db, acme.people["bob@acme.fr"])).session;
});

async function task(projectId: string, data: Record<string, unknown>) {
  await db.as("owner");
  const keys = Object.keys(data);
  return (await db.one<{ id: string }>(
    `insert into project_tasks (project_id, ${keys.join(",")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(",")}) returning id`,
    [projectId, ...keys.map((k) => data[k])])).id;
}
type T = { id: string; title: string; status: string; can_edit: boolean; assignee: { kind: string } };

describe("tâches", () => {
  test("interne par défaut ; tâche client toujours visible ; responsable = contact du projet", async () => {
    await task(p1, { title: "Interne" });
    const mine = await task(p1, { title: "Envoyer les textes", assignee_kind: "client", assignee_person_id: acme.people["alice@acme.fr"], visible_to_client: true });
    await db.as("owner");
    await expect(db.query(`insert into project_tasks (project_id, title, assignee_kind) values ($1, 'x', 'client')`, [p1])).rejects.toThrow(/check/);
    await expect(db.query(`insert into project_tasks (project_id, title, assignee_kind, assignee_person_id, visible_to_client) values ($1, 'x', 'client', $2, true)`, [p2, acme.people["bob@acme.fr"]])).rejects.toThrow(/contact du projet/);
    const list = await portal<T[]>(db, "portal_tasks", alice, { p_project: p1, p_limit: 100 });
    expect(list.map((t) => t.title)).toEqual(["Envoyer les textes"]);
    expect(list[0]).toMatchObject({ id: mine, can_edit: true, assignee: { kind: "me" } });
  });

  test("Mes tâches : tous les projets autorisés, jamais ceux des autres ; filtre par projet refusé hors accès", async () => {
    await task(p1, { title: "T1", assignee_kind: "client", visible_to_client: true });
    await task(p2, { title: "T2", assignee_kind: "client", visible_to_client: true });
    expect((await portal<T[]>(db, "portal_tasks", alice, { p_project: null, p_limit: 100 })).map((t) => t.title).sort()).toEqual(["T1", "T2"]);
    expect((await portal<T[]>(db, "portal_tasks", bob, { p_project: null, p_limit: 100 })).map((t) => t.title)).toEqual(["T1"]);
    await expect(portal(db, "portal_tasks", bob, { p_project: p2, p_limit: 100 })).rejects.toThrow(/Projet introuvable/);
  });

  test("modification : autorisée sur ses tâches et celles de l'équipe client ; refusée sinon ; blocage expliqué", async () => {
    const forAlice = await task(p1, { title: "A", assignee_kind: "client", assignee_person_id: acme.people["alice@acme.fr"], visible_to_client: true });
    const team = await task(p1, { title: "Équipe", assignee_kind: "client", visible_to_client: true });
    const ownerShared = await task(p1, { title: "Moi, partagée", assignee_kind: "owner", visible_to_client: true });
    const internal = await task(p1, { title: "Interne" });
    await expect(portal(db, "portal_task_update", bob, { p_task: forAlice, p_status: "termine", p_blocked_reason: null })).rejects.toThrow(/pas attribuée à vous/);
    await expect(portal(db, "portal_task_update", alice, { p_task: ownerShared, p_status: "termine", p_blocked_reason: null })).rejects.toThrow(/pas attribuée/);
    await expect(portal(db, "portal_task_update", alice, { p_task: internal, p_status: "termine", p_blocked_reason: null })).rejects.toThrow(/introuvable/);
    await expect(portal(db, "portal_task_update", alice, { p_task: forAlice, p_status: "bloque", p_blocked_reason: " " })).rejects.toThrow(/ce qui bloque/);
    expect(await portal(db, "portal_task_update", alice, { p_task: forAlice, p_status: "bloque", p_blocked_reason: "J'attends le logo" })).toMatchObject({ status: "bloque", blocked_reason: "J'attends le logo" });
    expect(await portal(db, "portal_task_update", bob, { p_task: team, p_status: "termine", p_blocked_reason: null })).toMatchObject({ status: "termine" });
    await db.query("reset role");
    expect(await db.one(`select updated_by_kind, updated_by_person, completed_at is not null as done from project_tasks where id = $1`, [team])).toMatchObject({
      updated_by_kind: "client", updated_by_person: acme.people["bob@acme.fr"], done: true });
    // le client ne peut changer que le statut : titre et échéance inchangés
    expect(await db.one(`select title, due_date from project_tasks where id = $1`, [forAlice])).toMatchObject({ title: "A", due_date: null });
    // une date passée ne termine rien
    await db.query(`update project_tasks set due_date = '2020-01-01' where id = $1`, [ownerShared]);
    expect((await db.one<{ status: string }>(`select status from project_tasks where id = $1`, [ownerShared])).status).toBe("a_faire");
  });

  test("commentaires : visibles avec auteur ; impossible sur une tâche interne ou un projet archivé", async () => {
    const t = await task(p1, { title: "A", assignee_kind: "client", visible_to_client: true });
    const internal = await task(p1, { title: "Interne" });
    await portal(db, "portal_task_comment", alice, { p_task: t, p_body: "Voici le lien vers les textes" });
    await expect(portal(db, "portal_task_comment", alice, { p_task: internal, p_body: "x" })).rejects.toThrow(/introuvable/);
    const d = await portal<{ comments: { author: string; mine: boolean }[] }>(db, "portal_task", bob, { p_task: t });
    expect(d.comments).toEqual([expect.objectContaining({ author: "Alice", mine: false })]);
    await expect(portal(db, "portal_task", bob, { p_task: internal })).rejects.toThrow(/introuvable/);
    await db.as("owner");
    await db.query(`update projects set status = 'archive' where id = $1`, [p1]);
    await expect(portal(db, "portal_task_comment", alice, { p_task: t, p_body: "x" })).rejects.toThrow(/archivé/);
    await expect(portal(db, "portal_task_update", alice, { p_task: t, p_status: "termine", p_blocked_reason: null })).rejects.toThrow(/pas attribuée|archivé/);
  });

  test("filtre par point : la tâche du point est la même ligne ; point d'un autre projet refusé", async () => {
    await db.query("reset role");
    const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
    const type = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Point', 'point', 30, $1) returning id`, [sched])).id;
    await db.as("owner");
    const bid = (await db.one<{ id: string }>(`select gen_random_uuid() as id`)).id;
    await db.rpc("appt_owner_book", { p_booking_id: bid, p_type: type, p_starts_at: new Date(Date.now() + 3 * 864e5).toISOString(), p_duration_min: null, p_person: acme.people["alice@acme.fr"], p_calendar_target: false, p_token_hash: sha(bid), p_idempotency_key: `k-${bid}` });
    const m = await db.rpc<string>("project_link_meeting", { p_project: p1, p_booking: bid });
    const t = await task(p1, { title: "Préparer le point", assignee_kind: "client", visible_to_client: true, meeting_id: m });
    await db.as("owner");
    await expect(db.query(`insert into project_tasks (project_id, title, meeting_id) values ($1, 'x', $2)`, [p2, m])).rejects.toThrow(/n'appartient pas au projet/);
    const list = await portal<(T & { meeting: { id: string } | null })[]>(db, "portal_tasks", alice, { p_project: p1, p_limit: 100 });
    expect(list.filter((x) => x.meeting?.id === m).map((x) => x.id)).toEqual([t]);
    await db.query("reset role");
    expect((await db.one<{ open_client_tasks: number }>(`select open_client_tasks from project_overview where id = $1`, [p1])).open_client_tasks).toBe(1);
    const home = await portal<{ my_tasks: { id: string }[] }>(db, "portal_project", alice, { p_project: p1 });
    expect(home.my_tasks.map((x) => x.id)).toEqual([t]);
  });
});
