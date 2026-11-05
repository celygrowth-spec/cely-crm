// Projets — vérification transverse du cloisonnement : chaque fonction du portail est appelée par un
// visiteur non autorisé (autre client, session révoquée, sans clé serveur), et aucune réponse destinée au
// client ne contient de champ ou de contenu interne.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

const SECRET = "SECRET-INTERNE";
let db: Db;
let ids: { project: string; meeting: string; task: string; internalTask: string; idea: string; file: string; internalFile: string };
let alice: string;
let outsider: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
  const zed = await company(db, "Zed", [{ first_name: "Zoé", email: "zoe@zed.fr" }]);
  const pid = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
  const zpid = await project(db, zed.id, "Zed", [zed.people["zoe@zed.fr"]]);
  void zpid;
  await db.query("reset role");
  // contenu interne partout où il peut exister
  await db.query(`update projects set internal_note = $2, blocked_reason = $2 where id = $1`, [pid, SECRET]);
  const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
  const type = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Point', 'point', 30, $1) returning id`, [sched])).id;
  await db.as("owner");
  const bid = randomUUID();
  await db.rpc("appt_owner_book", { p_booking_id: bid, p_type: type, p_starts_at: new Date(Date.now() + 2 * 864e5).toISOString(), p_duration_min: null, p_person: acme.people["alice@acme.fr"], p_calendar_target: false, p_token_hash: sha(bid), p_idempotency_key: `k-${bid}` });
  await db.query("reset role");
  await db.query(`update appt_bookings set internal_note = $2 where id = $1`, [bid, SECRET]);
  await db.as("owner");
  const meeting = await db.rpc<string>("project_link_meeting", { p_project: pid, p_booking: bid, p_visible: true });
  await db.query(`insert into meeting_recaps (meeting_id, summary, internal_note, status, published_at) values ($1, 'Résumé', $2, 'published', now())`, [meeting, SECRET]);
  const task = (await db.one<{ id: string }>(`insert into project_tasks (project_id, title, assignee_kind, visible_to_client, meeting_id) values ($1, 'Visible', 'client', true, $2) returning id`, [pid, meeting])).id;
  const internalTask = (await db.one<{ id: string }>(`insert into project_tasks (project_id, title, description) values ($1, $2, $2) returning id`, [pid, SECRET])).id;
  await db.query(`insert into project_task_comments (task_id, author_kind, body) values ($1, 'owner', $2)`, [internalTask, SECRET]);
  const idea = (await db.one<{ id: string }>(`insert into project_ideas (project_id, title, author_kind) values ($1, 'Idée', 'owner') returning id`, [pid])).id;
  await db.query("reset role");
  const fid = randomUUID();
  const internalFid = randomUUID();
  await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values
    ($1, $3, $5, 'Partagé.pdf', 'application/pdf', 10, 'ready'), ($2, $3, $6, $4, 'application/pdf', 10, 'ready')`, [fid, internalFid, acme.id, SECRET, `${fid}.pdf`, `${internalFid}.pdf`]);
  const file = (await db.one<{ id: string }>(`insert into project_files (project_id, file_id) values ($1, $2) returning id`, [pid, fid])).id;
  ids = { project: pid, meeting, task, internalTask, idea, file, internalFile: internalFid };
  alice = (await login(db, acme.people["alice@acme.fr"])).session;
  outsider = (await login(db, zed.people["zoe@zed.fr"])).session;
});

const calls = () => [
  ["portal_project", { p_project: ids.project }],
  ["portal_meeting", { p_project: ids.project, p_meeting: ids.meeting }],
  ["portal_tasks", { p_project: ids.project, p_limit: 100 }],
  ["portal_task", { p_task: ids.task }],
  ["portal_task_update", { p_task: ids.task, p_status: "termine", p_blocked_reason: null }],
  ["portal_task_comment", { p_task: ids.task, p_body: "x" }],
  ["portal_files", { p_project: ids.project, p_limit: 100, p_offset: 0 }],
  ["portal_file_grant", { p_project_file: ids.file }],
  ["portal_file_start", { p_project: ids.project, p_folder: null, p_task: null, p_name: "x.pdf", p_type: "application/pdf", p_size: 10, p_ext: "pdf" }],
  ["portal_ideas", { p_project: ids.project }],
  ["portal_idea_save", { p_project: ids.project, p_idea: null, p_title: "x", p_description: null }],
  ["portal_idea_comment", { p_project: ids.project, p_idea: ids.idea, p_body: "x" }],
] as const;

describe("cloisonnement transverse", () => {
  test("un client d'une autre entreprise n'obtient rien, par aucune fonction, même avec les identifiants", async () => {
    for (const [fn, args] of calls()) {
      await expect(portal(db, fn, outsider, args), fn).rejects.toThrow(/introuvable/i);
    }
    // et sa propre liste ne contient rien d'Acme
    expect(JSON.stringify(await portal(db, "portal_tasks", outsider, { p_project: null, p_limit: 500 }))).not.toMatch(/Visible|Site/);
  });

  test("session révoquée ou clé serveur absente : refus systématique", async () => {
    await db.as("owner");
    const person = (await db.one<{ person_id: string }>(`select person_id from project_members where project_id = $1`, [ids.project])).person_id;
    await db.rpc("portal_access_revoke", { p_person: person });
    for (const [fn, args] of calls()) {
      await expect(portal(db, fn, alice, args), fn).rejects.toThrow(/Session expirée/);
      await db.as("anon");
      await expect(db.rpc(fn, { p_server_key: "x".repeat(40), p_session_hash: alice, ...args }), fn).rejects.toThrow(/Accès refusé/);
    }
  });

  test("aucune réponse destinée au client ne contient de contenu interne", async () => {
    const responses: unknown[] = [];
    for (const [fn, args] of calls()) {
      if (/update|comment|save|start|grant/.test(fn)) continue;
      responses.push(await portal(db, fn, alice, args));
    }
    const all = JSON.stringify(responses);
    expect(all).not.toContain(SECRET);
    expect(all).not.toMatch(/internal_note|blocked_reason"\s*:\s*"SECRET|storage_path|code_hash|token_hash/);
    // tâche interne et document interne : introuvables même par identifiant
    await expect(portal(db, "portal_task", alice, { p_task: ids.internalTask })).rejects.toThrow(/introuvable/);
    await expect(portal(db, "portal_file_grant", alice, { p_project_file: ids.internalFile })).rejects.toThrow(/introuvable/);
  });
});
