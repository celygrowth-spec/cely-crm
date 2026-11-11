// Audit, lot 6 : C06 (partage maîtrisé), Q08/K11 (dépôt client, retrait sans effacement, limite par code).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let alice: string;
const n = async (sql: string, p?: unknown[]) => (await db.one<{ n: number }>(sql, p)).n;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
  pid = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
  alice = (await login(db, acme.people["alice@acme.fr"])).session;
});

async function ownerFile(name: string) {
  await db.query("reset role");
  const id = randomUUID();
  await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, $4, 'application/pdf', 1000, 'ready')`,
    [id, acme.id, `${acme.id}/${id}.pdf`, name]);
  await db.as("owner");
  return id;
}
type Files = { files: { name: string }[] };

describe("C06 — partage avec le projet", () => {
  test("à la racine d'un projet publié : confirmation exigée, rien n'est partagé avant ; dossier interne : sans confirmation", async () => {
    const f = await ownerFile("Contrat.pdf");
    expect(await db.rpc("project_files_share", { p_project: pid, p_files: [f], p_folder: null })).toEqual({ confirm: 1 });
    expect(await n(`select count(*)::int n from project_files where file_id = $1`, [f])).toBe(0);
    expect(await db.rpc("project_files_share", { p_project: pid, p_files: [f], p_folder: null, p_confirm: true })).toEqual({ shared: 1, visible: true });
    expect((await portal<Files>(db, "portal_files", alice, { p_project: pid, p_limit: 100, p_offset: 0 })).files.map((x) => x.name)).toEqual(["Contrat.pdf"]);
    await db.as("owner");
    const internal = await db.rpc<{ id: string }>("project_folder_save", { p_project: pid, p_folder: null, p_name: "Interne", p_parent: null, p_visible: false, p_upload: false });
    const g = await ownerFile("Note.pdf");
    expect(await db.rpc("project_files_share", { p_project: pid, p_files: [g], p_folder: internal.id })).toEqual({ shared: 1, visible: false });
  });

  test("commentaire écrit sur une tâche interne : reste privé quand la tâche devient visible", async () => {
    await db.as("owner");
    const t = (await db.one<{ id: string }>(`insert into project_tasks (project_id, title) values ($1, 'Préparer le devis') returning id`, [pid])).id;
    await db.query(`insert into project_task_comments (task_id, author_kind, body) values ($1, 'owner', 'marge 40 %, ne pas montrer')`, [t]);
    await db.query(`update project_tasks set visible_to_client = true where id = $1`, [t]);
    await db.query(`insert into project_task_comments (task_id, author_kind, body) values ($1, 'owner', 'Bonjour, voici le devis')`, [t]);
    const d = await portal<{ comments: { body: string }[]; comment_count: number }>(db, "portal_task", alice, { p_task: t });
    expect(d.comments.map((c) => c.body)).toEqual(["Bonjour, voici le devis"]);
    expect(d.comment_count).toBe(1);
  });
});

describe("K11 — portail", () => {
  test("le client retire son dépôt : il quitte le projet, la pièce reste dans la fiche", async () => {
    await db.query("reset role");
    const id = randomUUID();
    await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status, uploaded_by_kind, uploaded_by_person) values ($1, $2, $3, 'Logo.png', 'image/png', 10, 'ready', 'client', $4)`,
      [id, acme.id, `${acme.id}/${id}.png`, acme.people["alice@acme.fr"]]);
    const pf = (await db.one<{ id: string }>(`insert into project_files (project_id, file_id, shared_by_kind) values ($1, $2, 'client') returning id`, [pid, id])).id;
    const r = await portal<{ path: string | null }>(db, "portal_file_delete", alice, { p_project_file: pf });
    expect(r.path).toBeNull();
    await db.query("reset role");
    expect(await db.one(`select status from company_files where id = $1`, [id])).toEqual({ status: "ready" });
    expect(await n(`select count(*)::int n from project_files where id = $1`, [pf])).toBe(0);
  });

  test("limite de connexion par code et par connexion : un attaquant ne bloque pas les autres clients", async () => {
    await db.as("anon");
    for (let i = 0; i < 205; i++) {
      await db.rpc("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(`faux-${i}`), p_ip_hash: sha(`ip-${i}`), p_session_hash: sha(`s-${i}`), p_user_agent: null });
    }
    // un vrai client se connecte toujours
    const ok = await login(db, acme.people["alice@acme.fr"]);
    expect(ok.status).toBe("ok");
  });
});
