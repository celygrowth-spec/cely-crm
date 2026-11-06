// Projets — phase 4 : fichiers partagés. Référence (pas de copie), dépôt client vérifié dans Storage,
// politiques Storage limitées à un objet et une durée, document interne inaccessible, retrait ≠ suppression.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let other: string;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
  pid = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"], acme.people["bob@acme.fr"]]);
  other = await project(db, acme.id, "Autre", [acme.people["bob@acme.fr"]]);
  alice = (await login(db, acme.people["alice@acme.fr"])).session;
  bob = (await login(db, acme.people["bob@acme.fr"])).session;
});

/** Document interne de la fiche (déposé par le propriétaire). */
async function ownerFile(name: string) {
  await db.query("reset role");
  const id = randomUUID();
  await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, $4, 'application/pdf', 1000, 'ready')`,
    [id, acme.id, `${acme.id}/${id}.pdf`, name]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/${id}.pdf`]);
  return id;
}
async function asAnonStorage<T>(fn: () => Promise<T>) {
  await db.as("anon");
  return fn();
}
type Files = { files: { id: string; name: string; mine: boolean; author: string }[]; folders: unknown[]; total: number };

describe("partage", () => {
  test("document interne invisible tant qu'il n'est pas partagé ; partage = référence ; retrait sans suppression", async () => {
    const f = await ownerFile("Devis interne.pdf");
    const shared = await ownerFile("Charte graphique.pdf");
    await db.as("owner");
    await db.query(`insert into project_files (project_id, file_id) values ($1, $2)`, [pid, shared]);
    const list = await portal<Files>(db, "portal_files", alice, { p_project: pid, p_limit: 100, p_offset: 0 });
    expect(list.files.map((x) => x.name)).toEqual(["Charte graphique.pdf"]);
    // même document dans deux projets : une seule ligne company_files
    await db.as("owner");
    await db.query(`insert into project_files (project_id, file_id) values ($1, $2)`, [other, shared]);
    expect((await db.one<{ n: number }>(`select count(*)::int n from company_files where display_name = 'Charte graphique.pdf'`)).n).toBe(1);
    // retrait du projet : le document reste dans la fiche
    await db.query(`delete from project_files where project_id = $1 and file_id = $2`, [pid, shared]);
    expect((await portal<Files>(db, "portal_files", alice, { p_project: pid, p_limit: 100, p_offset: 0 })).files).toEqual([]);
    await db.query("reset role");
    expect((await db.one<{ status: string }>(`select status from company_files where id = $1`, [shared])).status).toBe("ready");
    // document d'une autre fiche : partage refusé
    const zed = await company(db, "Zed", [{ first_name: "Z", email: "z@zed.fr" }]);
    await db.query("reset role");
    const zid = randomUUID();
    await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, 'z.pdf', 'application/pdf', 10, 'ready')`, [zid, zed.id, `${zed.id}/${zid}.pdf`]);
    await db.as("owner");
    await expect(db.query(`insert into project_files (project_id, file_id) values ($1, $2)`, [pid, zid])).rejects.toThrow(/fiche CRM du projet/);
    void f;
  });

  test("lien temporaire : uniquement pour un fichier partagé du projet autorisé, objet précis, 60 s", async () => {
    const internal = await ownerFile("Interne.pdf");
    const shared = await ownerFile("Partagé.pdf");
    await db.as("owner");
    const pf = (await db.one<{ id: string }>(`insert into project_files (project_id, file_id) values ($1, $2) returning id`, [other, shared])).id;
    // Alice n'est pas membre de « Autre »
    await expect(portal(db, "portal_file_grant", alice, { p_project_file: pf })).rejects.toThrow(/Projet introuvable/);
    // sans autorisation, anon ne lit aucun objet
    const path = `${acme.id}/${shared}.pdf`;
    expect((await asAnonStorage(() => db.query(`select name from storage.objects`))).rows).toEqual([]);
    const g = await portal<{ path: string }>(db, "portal_file_grant", bob, { p_project_file: pf });
    expect(g.path).toBe(path);
    const visible = (await asAnonStorage(() => db.query<{ name: string }>(`select name from storage.objects`))).rows.map((r) => r.name);
    expect(visible).toEqual([path]); // l'objet autorisé, et lui seul (pas le document interne)
    void internal;
    await db.query("reset role");
    await db.query(`update portal_storage_grants set expires_at = now() - interval '1 second'`);
    expect((await asAnonStorage(() => db.query(`select name from storage.objects`))).rows).toEqual([]);
  });
});

describe("dépôt client", () => {
  async function upload(session: string, name = "Textes.docx", folder: string | null = null) {
    const s = await portal<{ file_id: string; path: string }>(db, "portal_file_start", session, {
      p_project: pid, p_folder: folder, p_task: null, p_name: name, p_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", p_size: 2048, p_ext: "docx",
    });
    return s;
  }

  test("envoi autorisé seulement pour son dépôt en attente ; confirmation exige l'objet ; auteur identifié", async () => {
    const s = await upload(alice);
    // le stockage n'accepte que ce chemin précis
    await asAnonStorage(() => db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/autre.pdf`])).catch((e) => expect(String(e)).toMatch(/row-level security/));
    await expect(portal(db, "portal_file_confirm", alice, { p_file: s.file_id })).rejects.toThrow(/pas été reçu/);
    await asAnonStorage(() => db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [s.path]));
    expect(await portal(db, "portal_file_confirm", alice, { p_file: s.file_id })).toMatchObject({ name: "Textes.docx", mine: true, author: "Alice" });
    // une fois prêt, plus d'envoi possible sur ce chemin
    await expect(asAnonStorage(() => db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [s.path]))).rejects.toThrow(/row-level security/);
    const forBob = await portal<Files>(db, "portal_files", bob, { p_project: pid, p_limit: 100, p_offset: 0 });
    expect(forBob.files).toEqual([expect.objectContaining({ name: "Textes.docx", mine: false, author: "Alice" })]);
    // le document apparaît dans la fiche CRM, côté administrateur
    await db.as("owner");
    expect(await db.one(`select uploaded_by_kind, status from company_files where id = $1`, [s.file_id])).toMatchObject({ uploaded_by_kind: "client", status: "ready" });
  });

  test("format, taille, projet archivé et projet non autorisé refusés", async () => {
    await expect(portal(db, "portal_file_start", alice, { p_project: pid, p_folder: null, p_task: null, p_name: "x.exe", p_type: "application/x-msdownload", p_size: 10, p_ext: "exe" })).rejects.toThrow(/Format/);
    await expect(portal(db, "portal_file_start", alice, { p_project: pid, p_folder: null, p_task: null, p_name: "x.pdf", p_type: "application/pdf", p_size: 26214401, p_ext: "pdf" })).rejects.toThrow(/volumineux/);
    await expect(portal(db, "portal_file_start", alice, { p_project: other, p_folder: null, p_task: null, p_name: "x.pdf", p_type: "application/pdf", p_size: 10, p_ext: "pdf" })).rejects.toThrow(/Projet introuvable/);
    await db.as("owner");
    await db.query(`update projects set status = 'archive' where id = $1`, [pid]);
    await expect(portal(db, "portal_file_start", alice, { p_project: pid, p_folder: null, p_task: null, p_name: "x.pdf", p_type: "application/pdf", p_size: 10, p_ext: "pdf" })).rejects.toThrow(/archivé/);
  });

  test("ses dépôts seulement : renommer, déplacer, supprimer ; transfert abandonné sans trace", async () => {
    await db.as("owner");
    const folder = (await db.one<{ id: string }>(`insert into project_folders (project_id, name, visible_to_client, client_can_upload) values ($1, 'Contenus', true, true) returning id`, [pid])).id;
    const sub = (await db.one<{ id: string }>(`insert into project_folders (project_id, parent_id, name, visible_to_client, client_can_upload) values ($1, $2, 'Textes', true, true) returning id`, [pid, folder])).id;
    await expect(db.query(`insert into project_folders (project_id, parent_id, name) values ($1, $2, 'Trop profond')`, [pid, sub])).rejects.toThrow(/Deux niveaux/);
    const s = await upload(alice);
    await asAnonStorage(() => db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [s.path]));
    const f = await portal<{ id: string }>(db, "portal_file_confirm", alice, { p_file: s.file_id });
    const shared = await ownerFile("Charte.pdf");
    await db.as("owner");
    const pfOwner = (await db.one<{ id: string }>(`insert into project_files (project_id, file_id) values ($1, $2) returning id`, [pid, shared])).id;
    await expect(portal(db, "portal_file_update", bob, { p_project_file: f.id, p_name: "Piraté", p_folder: null, p_move: false })).rejects.toThrow(/propres dépôts/);
    await expect(portal(db, "portal_file_delete", alice, { p_project_file: pfOwner })).rejects.toThrow(/propres dépôts/);
    expect(await portal(db, "portal_file_update", alice, { p_project_file: f.id, p_name: "Textes v2.docx", p_folder: sub, p_move: true })).toMatchObject({ name: "Textes v2.docx", folder_id: sub });
    const d = await portal<{ path: string; file_id: string }>(db, "portal_file_delete", alice, { p_project_file: f.id });
    expect((await portal<Files>(db, "portal_files", bob, { p_project: pid, p_limit: 100, p_offset: 0 })).files.map((x) => x.name)).toEqual(["Charte.pdf"]);
    // le serveur retire l'objet grâce à l'autorisation de suppression, puis la ligne
    await asAnonStorage(() => db.query(`delete from storage.objects where name = $1`, [d.path]));
    await portal(db, "portal_file_purge", alice, { p_file: d.file_id });
    await db.query("reset role");
    expect((await db.one<{ n: number }>(`select count(*)::int n from company_files where id = $1`, [d.file_id])).n).toBe(0);
    // le document du propriétaire est intact, et anon ne peut pas le supprimer
    await asAnonStorage(() => db.query(`delete from storage.objects where name = $1`, [`${acme.id}/${shared}.pdf`]));
    await db.query("reset role");
    expect((await db.one<{ n: number }>(`select count(*)::int n from storage.objects where name = $1`, [`${acme.id}/${shared}.pdf`])).n).toBe(1);
    // transfert abandonné
    const s2 = await upload(alice, "Abandon.pdf");
    await portal(db, "portal_file_abort", alice, { p_file: s2.file_id });
    await db.query("reset role");
    expect((await db.one<{ n: number }>(`select count(*)::int n from company_files where id = $1`, [s2.file_id])).n).toBe(0);
  });
});
