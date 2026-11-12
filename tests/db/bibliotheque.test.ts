// Bibliothèque générale : reprise des documents de diagnostic, dossiers, éléments et droits d'accès.
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigrations, createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

const BEFORE = "20261115000900"; // dernière migration avant la bibliothèque
const DIAG = `select id from library_folders where system_key = 'diagnostic'`;

let db: Db;
let diag: string;

async function file(d: Db, folder: string | null, name: string, size = 10) {
  const r = await d.rpc<{ id: string; name: string; path: string }>("library_file_start", { p_folder: folder, p_name: name, p_mime: "application/pdf", p_size: size, p_ext: "pdf" });
  await d.query(`update diagnostic_library_files set status = 'ready' where id = $1`, [r.id]);
  return r;
}

describe("reprise des documents de diagnostic", () => {
  test("mise à niveau avec des documents en place : mêmes identifiants, mêmes chemins, rangés dans « Bibliothèque diagnostic »", async () => {
    const d = await createDb({ upTo: BEFORE });
    // état réel de forme : catégories variées, doublon de nom, envoi en cours, dossier de diagnostic en cours
    const rows = [
      ["11111111-1111-4111-8111-111111111111", "example", "Diagnostic Durand.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 1200, "11111111-1111-4111-8111-111111111111.pptx", "ready"],
      ["22222222-2222-4222-8222-222222222222", "brand", "Charte.pdf", "application/pdf", 300, "22222222-2222-4222-8222-222222222222.pdf", "ready"],
      ["33333333-3333-4333-8333-333333333333", "guide", "Charte.pdf", "application/pdf", 301, "33333333-3333-4333-8333-333333333333.pdf", "ready"],
      ["44444444-4444-4444-8444-444444444444", "other", "Envoi en cours.pdf", "application/pdf", 5, "44444444-4444-4444-8444-444444444444.pdf", "pending"],
    ];
    for (const r of rows) {
      await d.query(`insert into diagnostic_library_files (id, category, display_name, mime_type, size_bytes, storage_path, status, created_at) values ($1, $2, $3, $4, $5, $6, $7, '2026-11-09T10:00:00Z')`, r);
    }
    const co = await company(d, "[TEST] Prospect diagnostic", []);
    const dossier = await d.rpc<string>("diagnostic_start", { p_company: co.id, p_key: "diag-en-cours-1" });
    const before = (await d.query(`select * from diagnostic_library_files order by id`)).rows;

    await applyMigrations(d, { after: BEFORE });
    await d.as("owner");

    const folder = await d.one<{ id: string; name: string; parent_id: string | null }>(`select id, name, parent_id from library_folders where system_key = 'diagnostic'`);
    expect(folder).toMatchObject({ name: "Bibliothèque diagnostic", parent_id: null });
    const after = (await d.query<Record<string, unknown>>(`select * from diagnostic_library_files order by id`)).rows;
    expect(after).toHaveLength(4);
    after.forEach((row, i) => {
      const old = before[i] as Record<string, unknown>;
      for (const k of ["id", "category", "display_name", "mime_type", "size_bytes", "storage_path", "status", "created_at"]) expect(row[k], k).toEqual(old[k]);
      expect(row.folder_id).toBe(folder.id);
      expect(row.kind).toBe("file");
    });
    // le doublon de nom d'origine est conservé ; l'envoi en cours se termine normalement
    await d.query(`update diagnostic_library_files set status = 'ready' where id = '44444444-4444-4444-8444-444444444444'`);
    expect(await d.one(`select count(*)::int n from diagnostic_library_files where display_name = 'Charte.pdf'`)).toEqual({ n: 2 });
    // le dossier de diagnostic en cours n'est pas touché, Claude lit toujours ses documents
    expect(await d.one(`select status from diagnostics where id = $1`, [dossier])).toEqual({ status: "waiting_claude" });
    await d.as("claude");
    expect(await d.one(`select count(*)::int n from diagnostic_library_files where status = 'ready' and folder_id in (select library_subtree($1))`, [folder.id])).toEqual({ n: 4 });
  });

  test("une ligne écrite sans dossier (ancien écran) est rangée dans le dossier diagnostic", async () => {
    const d = await createDb();
    await d.query(`insert into diagnostic_library_files (display_name, mime_type, size_bytes, storage_path) values ('Ancien.pdf', 'application/pdf', 1, 'ancien.pdf')`);
    expect(await d.one(`select folder_id = (${DIAG}) ok from diagnostic_library_files`)).toEqual({ ok: true });
  });
});

describe("dossiers", () => {
  beforeEach(async () => {
    db = await createDb();
    diag = (await db.one<{ id: string }>(DIAG)).id;
  });

  test("création, sous-dossier, renommage, nom en double refusé au même endroit", async () => {
    const a = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "  Prompts LinkedIn " });
    expect(await db.one(`select name from library_folders where id = $1`, [a])).toEqual({ name: "Prompts LinkedIn" });
    await expect(db.rpc("library_folder_create", { p_parent: null, p_name: "prompts linkedin" })).rejects.toThrow(/déjà/);
    const sub = await db.rpc<string>("library_folder_create", { p_parent: a, p_name: "Accroches" });
    // même nom ailleurs : accepté
    await db.rpc("library_folder_create", { p_parent: diag, p_name: "Accroches" });
    await db.rpc("library_folder_rename", { p_folder: sub, p_name: "Relances" });
    await expect(db.rpc("library_folder_create", { p_parent: null, p_name: "   " })).rejects.toThrow(/obligatoire/);
    await expect(db.rpc("library_folder_rename", { p_folder: a, p_name: "Bibliothèque diagnostic" })).rejects.toThrow(/déjà/);
  });

  test("« Bibliothèque diagnostic » : permanent, ni renommé, ni déplacé, ni supprimé ; on peut y ranger des sous-dossiers", async () => {
    const other = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "Autre" });
    await expect(db.rpc("library_folder_rename", { p_folder: diag, p_name: "Diag" })).rejects.toThrow(/permanent/);
    await expect(db.rpc("library_folder_move", { p_folder: diag, p_parent: other })).rejects.toThrow(/permanent/);
    await expect(db.rpc("library_folder_delete", { p_folder: diag, p_confirmed_items: 0 })).rejects.toThrow(/permanent/);
    await expect(db.query(`delete from library_folders where id = $1`, [diag])).rejects.toThrow(/permanent/);
    await expect(db.query(`update library_folders set system_key = null where id = $1`, [diag])).rejects.toThrow();
    const sub = await db.rpc<string>("library_folder_create", { p_parent: diag, p_name: "Exemples 2026" });
    expect(await db.one(`select parent_id from library_folders where id = $1`, [sub])).toEqual({ parent_id: diag });
  });

  test("déplacement : refusé dans lui-même ou un de ses sous-dossiers, accepté ailleurs", async () => {
    const a = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "A" });
    const b = await db.rpc<string>("library_folder_create", { p_parent: a, p_name: "B" });
    const c = await db.rpc<string>("library_folder_create", { p_parent: b, p_name: "C" });
    const x = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "X" });
    await expect(db.rpc("library_folder_move", { p_folder: a, p_parent: a })).rejects.toThrow(/lui-même/);
    await expect(db.rpc("library_folder_move", { p_folder: a, p_parent: c })).rejects.toThrow(/sous-dossiers/);
    // même garde-fou si la table est modifiée directement
    await expect(db.query(`update library_folders set parent_id = $1 where id = $2`, [b, a])).rejects.toThrow(/sous-dossiers/);
    await db.rpc("library_folder_move", { p_folder: b, p_parent: x });
    expect(await db.one(`select parent_id from library_folders where id = $1`, [b])).toEqual({ parent_id: x });
    await db.rpc("library_folder_move", { p_folder: b, p_parent: null });
    expect(await db.one(`select parent_id from library_folders where id = $1`, [b])).toEqual({ parent_id: null });
    // conflit de nom à la destination
    await db.rpc("library_folder_create", { p_parent: x, p_name: "C" });
    await expect(db.rpc("library_folder_move", { p_folder: c, p_parent: x })).rejects.toThrow(/déjà/);
  });

  test("suppression : annonce le contenu, n'agit qu'avec le bon compte, supprime tout le sous-arbre et renvoie les fichiers à retirer", async () => {
    const a = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "A" });
    const b = await db.rpc<string>("library_folder_create", { p_parent: a, p_name: "B" });
    const f1 = await file(db, a, "Un.pdf");
    const f2 = await file(db, b, "Deux.pdf");
    await db.rpc("library_prompt_create", { p_folder: b, p_title: "Prompt", p_content: "Bonjour" });
    const keep = await file(db, diag, "Garde.pdf");

    const ask = await db.rpc<{ confirm: { items: number; folders: number } }>("library_folder_delete", { p_folder: a, p_confirmed_items: null });
    expect(ask).toEqual({ confirm: { items: 3, folders: 1 } });
    // compte périmé (un fichier ajouté entre-temps) : rien n'est supprimé
    expect(await db.rpc("library_folder_delete", { p_folder: a, p_confirmed_items: 2 })).toEqual({ confirm: { items: 3, folders: 1 } });
    expect(await db.one(`select count(*)::int n from library_folders where id in ($1, $2)`, [a, b])).toEqual({ n: 2 });

    const done = await db.rpc<{ deleted: boolean; paths: string[] }>("library_folder_delete", { p_folder: a, p_confirmed_items: 3 });
    expect(done.deleted).toBe(true);
    expect(done.paths.sort()).toEqual([f1.path, f2.path].sort());
    expect(await db.one(`select count(*)::int n from library_folders where id in ($1, $2)`, [a, b])).toEqual({ n: 0 });
    expect(await db.one(`select count(*)::int n from diagnostic_library_files`)).toEqual({ n: 1 });
    expect(await db.one(`select id from diagnostic_library_files`)).toEqual({ id: keep.id });
  });
});

describe("éléments", () => {
  beforeEach(async () => {
    db = await createDb();
    diag = (await db.one<{ id: string }>(DIAG)).id;
  });

  test("dépôt : nom libre choisi automatiquement en cas de doublon, type et taille validés", async () => {
    const a = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "Docs" });
    expect((await file(db, a, "Devis.pdf")).name).toBe("Devis.pdf");
    expect((await file(db, a, "devis.pdf")).name).toBe("devis (2).pdf");
    expect((await file(db, a, "Devis.pdf")).name).toBe("Devis (3).pdf");
    expect((await file(db, diag, "Devis.pdf")).name).toBe("Devis.pdf");
    const start = (args: Record<string, unknown>) => db.rpc("library_file_start", { p_folder: a, p_name: "x.pdf", p_mime: "application/pdf", p_size: 10, p_ext: "pdf", ...args });
    await expect(start({ p_mime: "application/x-msdownload", p_ext: "exe" })).rejects.toThrow(/Format/);
    await expect(start({ p_size: 0 })).rejects.toThrow(/vide/);
    await expect(start({ p_size: 26214401 })).rejects.toThrow(/25 Mo/);
    await expect(start({ p_ext: "../x" })).rejects.toThrow(/Extension/);
    await expect(start({ p_folder: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/introuvable/);
    // sans dossier : la bibliothèque de diagnostic (écran Paramètres › Diagnostic)
    const legacy = await db.rpc<{ id: string }>("library_file_start", { p_folder: null, p_name: "Ex.pdf", p_mime: "application/pdf", p_size: 1, p_ext: "pdf" });
    expect(await db.one(`select folder_id from diagnostic_library_files where id = $1`, [legacy.id])).toEqual({ folder_id: diag });
  });

  test("prompt : création, modification, renommage, déplacement ; deux éléments du même nom dans un dossier refusés", async () => {
    const a = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "Prompts" });
    const b = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "Archives" });
    const p = await db.rpc<string>("library_prompt_create", { p_folder: a, p_title: "Relance J+3", p_content: "Bonjour {prénom}" });
    expect(await db.one(`select kind, content, status, storage_path from diagnostic_library_files where id = $1`, [p])).toEqual({ kind: "prompt", content: "Bonjour {prénom}", status: "ready", storage_path: null });
    // double clic : le second envoi est refusé, un seul prompt existe
    await expect(db.rpc("library_prompt_create", { p_folder: a, p_title: "relance j+3", p_content: "Autre" })).rejects.toThrow(/déjà/);
    expect(await db.one(`select count(*)::int n from diagnostic_library_files where folder_id = $1`, [a])).toEqual({ n: 1 });
    await db.rpc("library_prompt_update", { p_id: p, p_title: "Relance J+5", p_content: "Nouveau texte" });
    expect(await db.one(`select display_name, content, size_bytes::int from diagnostic_library_files where id = $1`, [p])).toEqual({ display_name: "Relance J+5", content: "Nouveau texte", size_bytes: 13 });
    const f = await file(db, b, "Relance J+5");
    await expect(db.rpc("library_item_move", { p_id: f.id, p_folder: a })).rejects.toThrow(/déjà/);
    await db.rpc("library_item_rename", { p_id: f.id, p_name: "Relance.pdf" });
    await db.rpc("library_item_move", { p_id: f.id, p_folder: a });
    expect(await db.one(`select folder_id from diagnostic_library_files where id = $1`, [f.id])).toEqual({ folder_id: a });
    await expect(db.rpc("library_item_rename", { p_id: p, p_name: "relance.PDF" })).rejects.toThrow(/déjà/);
    await expect(db.rpc("library_item_move", { p_id: p, p_folder: null })).rejects.toThrow(/introuvable/);
  });
});

describe("droits d'accès", () => {
  let folder: string;
  let item: string;
  beforeEach(async () => {
    db = await createDb();
    diag = (await db.one<{ id: string }>(DIAG)).id;
    folder = await db.rpc<string>("library_folder_create", { p_parent: null, p_name: "Privé" });
    item = await db.rpc<string>("library_prompt_create", { p_folder: folder, p_title: "Secret", p_content: "CONTENU-PRIVE" });
    await db.query(`insert into storage.objects (bucket_id, name) values ('diagnostic-library', 'objet.pdf')`);
  });

  test("Claude lit toute la bibliothèque mais n'écrit rien", async () => {
    await db.as("claude");
    expect(await db.one(`select count(*)::int n from library_folders`)).toEqual({ n: 2 });
    expect(await db.one(`select content from diagnostic_library_files where id = $1`, [item])).toEqual({ content: "CONTENU-PRIVE" });
    await expect(db.rpc("library_folder_create", { p_parent: null, p_name: "Par Claude" })).rejects.toThrow(/Claude/);
    await expect(db.rpc("library_prompt_create", { p_folder: folder, p_title: "x", p_content: "y" })).rejects.toThrow(/Claude/);
    await expect(db.rpc("library_prompt_update", { p_id: item, p_title: "x", p_content: "y" })).rejects.toThrow(/Claude/);
    await expect(db.rpc("library_item_move", { p_id: item, p_folder: diag })).rejects.toThrow(/Claude/);
    await expect(db.rpc("library_folder_delete", { p_folder: folder, p_confirmed_items: 1 })).rejects.toThrow(/Claude/);
    await expect(db.rpc("library_file_start", { p_folder: folder, p_name: "x.pdf", p_mime: "application/pdf", p_size: 1, p_ext: "pdf" })).rejects.toThrow(/Claude/);
    // écriture directe en table : refusée par les politiques
    await expect(db.query(`insert into library_folders (name) values ('Direct')`)).rejects.toThrow();
    expect((await db.query(`update library_folders set name = 'Piraté' where id = $1 returning id`, [folder])).rows).toEqual([]);
    expect((await db.query(`delete from diagnostic_library_files where id = $1 returning id`, [item])).rows).toEqual([]);
    expect((await db.query(`update diagnostic_library_files set content = 'x' where id = $1 returning id`, [item])).rows).toEqual([]);
  });

  test("un autre compte connecté ne voit rien et ne peut rien faire, même avec des identifiants valides", async () => {
    await db.as("stranger");
    expect(await db.one(`select count(*)::int n from library_folders`)).toEqual({ n: 0 });
    expect(await db.one(`select count(*)::int n from diagnostic_library_files`)).toEqual({ n: 0 });
    expect(await db.one(`select count(*)::int n from storage.objects where bucket_id = 'diagnostic-library'`)).toEqual({ n: 0 });
    await expect(db.query(`insert into storage.objects (bucket_id, name) values ('diagnostic-library', 'intrus.pdf')`)).rejects.toThrow();
    await expect(db.rpc("library_folder_rename", { p_folder: folder, p_name: "Volé" })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("library_folder_delete", { p_folder: folder, p_confirmed_items: 1 })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("library_item_move", { p_id: item, p_folder: folder })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("library_folder_counts", { p_folder: folder })).resolves.toEqual({ folders: 0, items: 0 });
    await db.as("owner");
    expect(await db.one(`select name from library_folders where id = $1`, [folder])).toEqual({ name: "Privé" });
  });

  test("anonyme et portail client : aucun accès, aucune fonction de bibliothèque exécutable", async () => {
    await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
    const co = await company(db, "[TEST] Client portail", [{ first_name: "Ana", email: "ana@client.example.test" }]);
    const pid = await project(db, co.id, "[TEST] Projet portail", [co.people["ana@client.example.test"]]);
    const s = await login(db, co.people["ana@client.example.test"]);
    expect(s.status).toBe("ok");
    await db.as("anon");
    await expect(db.query(`select * from library_folders`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from diagnostic_library_files`)).rejects.toThrow(/permission denied/);
    expect(await db.one(`select count(*)::int n from storage.objects where bucket_id = 'diagnostic-library'`)).toEqual({ n: 0 });
    for (const [fn, args] of [
      ["library_folder_create", { p_parent: null, p_name: "x" }],
      ["library_folder_counts", { p_folder: folder }],
      ["library_subtree", { p_folder: folder }],
      ["library_prompt_update", { p_id: item, p_title: "x", p_content: "y" }],
    ] as const) {
      await expect(db.rpc(fn, args), fn).rejects.toThrow(/permission denied/);
    }
    // le portail ne connaît que ses projets : un identifiant de la bibliothèque n'y mène à rien
    expect(await portal(db, "portal_project", s.session, { p_project: pid })).toBeTruthy();
    await expect(portal(db, "portal_project", s.session, { p_project: folder })).rejects.toThrow();
    await expect(portal(db, "portal_file_grant", s.session, { p_project_file: item })).rejects.toThrow();
    const { rows } = await db.query<{ proname: string }>(
      `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname like 'portal%' and prosrc ilike any (array['%library%', '%diagnostic_library%'])`);
    expect(rows).toEqual([]);
  });
});
