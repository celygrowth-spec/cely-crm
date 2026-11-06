// Projets — ajustements : dossiers partagés ou internes, dépôt client par dossier, déplacements contrôlés
// (aucun document interne exposé sans confirmation), suppression d'un dossier non vide, et
// « Mes prochains points » (report, annulation, sans doublon, plusieurs projets).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let alice: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
  pid = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
  alice = (await login(db, acme.people["alice@acme.fr"])).session;
});

type Files = { files: { id: string; name: string }[]; folders: { id: string; name: string; upload: boolean }[]; total: number };
const list = () => portal<Files>(db, "portal_files", alice, { p_project: pid, p_limit: 100, p_offset: 0 });

async function folder(name: string, visible: boolean, upload = false, parent: string | null = null) {
  await db.as("owner");
  return (await db.rpc<{ id: string }>("project_folder_save", { p_project: pid, p_folder: null, p_name: name, p_parent: parent, p_visible: visible, p_upload: upload, p_confirm: false })).id;
}
/** Document de la fiche partagé avec le projet, dans un dossier. */
async function doc(name: string, folderId: string | null) {
  await db.query("reset role");
  const id = randomUUID();
  await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, $4, 'application/pdf', 10, 'ready')`,
    [id, acme.id, `${acme.id}/${id}.pdf`, name]);
  await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/${id}.pdf`]);
  await db.as("owner");
  return (await db.one<{ id: string }>(`insert into project_files (project_id, file_id, folder_id) values ($1, $2, $3) returning id`, [pid, id, folderId])).id;
}
const move = async (ids: string[], target: string | null, confirm = false) => {
  await db.as("owner");
  return db.rpc<{ moved?: number; confirm?: number }>("project_files_move", { p_project: pid, p_ids: `{${ids.join(",")}}`, p_folder: target, p_confirm: confirm });
};

describe("dossiers partagés et internes", () => {
  test("le client ne voit que les dossiers partagés et leur contenu ; un dossier interne reste inaccessible", async () => {
    const factures = await folder("Factures", true);
    const interne = await folder("Notes internes", false);
    const sousInterne = await folder("Brouillons", true, true, interne); // partagé, mais dans un dossier interne
    const f1 = await doc("Facture 001.pdf", factures);
    const secret = await doc("Marge.pdf", interne);
    const secret2 = await doc("Brouillon.pdf", sousInterne);
    const l = await list();
    expect(l.folders.map((f) => f.name)).toEqual(["Factures"]);
    expect(l.files.map((f) => f.name)).toEqual(["Facture 001.pdf"]);
    expect(l.total).toBe(1);
    // accès direct par identifiant : introuvable
    for (const id of [secret, secret2]) {
      await expect(portal(db, "portal_file_grant", alice, { p_project_file: id })).rejects.toThrow(/introuvable/);
      await expect(portal(db, "portal_file_delete", alice, { p_project_file: id })).rejects.toThrow(/introuvable/);
    }
    await expect(portal(db, "portal_file_start", alice, { p_project: pid, p_folder: interne, p_task: null, p_name: "x.pdf", p_type: "application/pdf", p_size: 10, p_ext: "pdf" })).rejects.toThrow(/Dossier introuvable/);
    expect(await portal(db, "portal_file_grant", alice, { p_project_file: f1 })).toMatchObject({ name: "Facture 001.pdf" });
    // le dossier « Factures » ne donne accès à rien d'autre : aucune donnée Finance dans la réponse
    expect(JSON.stringify(l)).not.toMatch(/invoice|montant|amount/i);
  });

  test("déplacer un document interne vers un dossier partagé exige une confirmation explicite, vérifiée en base", async () => {
    const partage = await folder("Livrables", true);
    const interne = await folder("Interne", false);
    const d = await doc("Contrat signé.pdf", interne);
    // sans confirmation : rien ne bouge, le client ne voit toujours rien
    expect(await move([d], partage)).toEqual({ confirm: 1 });
    expect(await move([d], null)).toEqual({ confirm: 1 }); // la racine est visible aussi
    expect((await list()).files).toEqual([]);
    // une mise à jour directe (hors fonction) est aussi bloquée par la base
    await db.as("owner");
    await expect(db.query(`update project_files set folder_id = $2 where id = $1`, [d, partage])).rejects.toThrow(/confirmation requise/);
    // déplacement d'un dossier interne à un autre : aucune exposition, pas de confirmation
    const interne2 = await folder("Archives", false);
    expect(await move([d], interne2)).toEqual({ moved: 1 });
    expect((await list()).files).toEqual([]);
    // confirmation explicite : visible
    expect(await move([d], partage, true)).toEqual({ moved: 1 });
    expect((await list()).files.map((f) => f.name)).toEqual(["Contrat signé.pdf"]);
    // retour vers un dossier interne : à nouveau inaccessible, même par identifiant
    expect(await move([d], interne)).toEqual({ moved: 1 });
    expect((await list()).files).toEqual([]);
    await expect(portal(db, "portal_file_grant", alice, { p_project_file: d })).rejects.toThrow(/introuvable/);
  });

  test("partager un dossier qui contient des documents internes exige une confirmation", async () => {
    const f = await folder("Contrats", false);
    await doc("Contrat.pdf", f);
    await db.as("owner");
    const save = (confirm: boolean) => db.rpc<{ id?: string; confirm?: number }>("project_folder_save", { p_project: pid, p_folder: f, p_name: "Contrats", p_parent: null, p_visible: true, p_upload: false, p_confirm: confirm });
    expect(await save(false)).toEqual({ confirm: 1 });
    expect((await list()).folders).toEqual([]);
    await db.as("owner");
    await expect(db.query(`update project_folders set visible_to_client = true where id = $1`, [f])).rejects.toThrow(/confirmation requise/);
    expect(await save(true)).toEqual({ id: f });
    expect((await list()).files.map((x) => x.name)).toEqual(["Contrat.pdf"]);
    // renommer, doublon de nom refusé
    await db.as("owner");
    await db.rpc("project_folder_save", { p_project: pid, p_folder: f, p_name: "Contrats signés", p_parent: null, p_visible: true, p_upload: false, p_confirm: false });
    await expect(folder("contrats signés", true)).rejects.toThrow(/déjà ce nom/);
    expect((await list()).folders.map((x) => x.name)).toEqual(["Contrats signés"]);
  });

  test("dépôt client seulement dans les dossiers ouverts ; déplacement client limité à ces dossiers", async () => {
    const ouvert = await folder("Briefs", true, true);
    const lecture = await folder("Factures", true, false);
    const interne = await folder("Interne", false, true); // dépôt ignoré : dossier interne
    const start = (f: string | null) => portal<{ file_id: string; path: string }>(db, "portal_file_start", alice, { p_project: pid, p_folder: f, p_task: null, p_name: "brief.pdf", p_type: "application/pdf", p_size: 10, p_ext: "pdf" });
    await expect(start(lecture)).rejects.toThrow(/pas ouvert/);
    await expect(start(interne)).rejects.toThrow(/introuvable/);
    expect((await list()).folders.map((f) => [f.name, f.upload])).toEqual([["Briefs", true], ["Factures", false]]);
    const s = await start(ouvert);
    await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [s.path]);
    const f = await portal<{ id: string; folder_id: string }>(db, "portal_file_confirm", alice, { p_file: s.file_id });
    expect(f.folder_id).toBe(ouvert);
    await expect(portal(db, "portal_file_update", alice, { p_project_file: f.id, p_name: null, p_folder: lecture, p_move: true })).rejects.toThrow(/pas ouvert/);
    await expect(portal(db, "portal_file_update", alice, { p_project_file: f.id, p_name: null, p_folder: interne, p_move: true })).rejects.toThrow(/introuvable/);
    expect(await portal(db, "portal_file_update", alice, { p_project_file: f.id, p_name: null, p_folder: null, p_move: true })).toMatchObject({ folder_id: null });
  });

  test("supprimer un dossier non vide : déplacement choisi d'abord ; jamais d'exposition implicite", async () => {
    const interne = await folder("Interne", false);
    const sous = await folder("Sous", false, false, interne);
    const partage = await folder("Livrables", true);
    const autreInterne = await folder("Archives", false);
    const a = await doc("A.pdf", interne);
    const b = await doc("B.pdf", sous);
    await db.as("owner");
    // suppression directe d'un dossier non vide : refusée (les fichiers remonteraient à la racine, visible)
    await expect(db.query(`delete from project_folders where id = $1`, [interne])).rejects.toThrow(/non vide/);
    await expect(db.rpc("project_folder_delete", { p_folder: interne, p_target: sous, p_confirm: false })).rejects.toThrow(/Destination invalide/);
    expect(await db.rpc("project_folder_delete", { p_folder: interne, p_target: null, p_confirm: false })).toEqual({ confirm: 2 });
    expect(await db.rpc("project_folder_delete", { p_folder: interne, p_target: partage, p_confirm: false })).toEqual({ confirm: 2 });
    expect((await list()).files).toEqual([]);
    await db.as("owner");
    expect(await db.rpc("project_folder_delete", { p_folder: interne, p_target: autreInterne, p_confirm: false })).toEqual({ deleted: true, moved: 2 });
    expect((await db.query<{ folder_id: string }>(`select folder_id from project_files where id = any($1)`, [`{${a},${b}}`])).rows.map((r) => r.folder_id)).toEqual([autreInterne, autreInterne]);
    expect((await db.one<{ n: number }>(`select count(*)::int n from project_folders where id in ($1, $2)`, [interne, sous])).n).toBe(0);
    expect((await list()).files).toEqual([]);
    await db.as("owner");
    // dossier vide : suppression simple ; suppression du projet entier toujours possible
    const vide = await folder("Vide", true);
    await db.as("owner");
    expect(await db.rpc("project_folder_delete", { p_folder: vide, p_target: null, p_confirm: false })).toEqual({ deleted: true, moved: 0 });
    await db.query("reset role");
    await db.query(`delete from projects where id = $1`, [pid]);
    expect((await db.one<{ n: number }>(`select count(*)::int n from project_folders`)).n).toBe(0);
  });

  test("anon n'a aucun accès direct aux dossiers ni aux fonctions d'administration", async () => {
    await db.as("anon");
    await expect(db.query(`select * from project_folders`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("project_files_move", { p_project: pid, p_ids: "{}", p_folder: null, p_confirm: true })).rejects.toThrow(/permission denied/);
    await expect(db.rpc("project_folder_save", { p_project: pid, p_folder: null, p_name: "x", p_parent: null, p_visible: true, p_upload: true, p_confirm: true })).rejects.toThrow(/permission denied/);
  });
});

describe("Mes prochains points", () => {
  type Up = { id: string; title: string; starts_at: string; project_name: string; status: string; meeting_url: string | null };
  async function meeting(projectId: string, inDays: number, title: string) {
    await db.query("reset role");
    let type = (await db.query<{ id: string }>(`select id from appt_event_types where slug = 'point'`)).rows[0]?.id;
    if (!type) {
      const sched = (await db.one<{ id: string }>(`select id from appt_schedules where is_default`)).id;
      type = (await db.one<{ id: string }>(`insert into appt_event_types (name, slug, duration_min, schedule_id) values ('Point', 'point', 30, $1) returning id`, [sched])).id;
    }
    await db.as("owner");
    const bid = randomUUID();
    await db.rpc("appt_owner_book", { p_booking_id: bid, p_type: type, p_starts_at: new Date(Date.now() + inDays * 864e5).toISOString(), p_duration_min: null, p_person: acme.people["alice@acme.fr"], p_calendar_target: false, p_token_hash: sha(bid), p_idempotency_key: `k-${bid}` });
    const mid = await db.rpc<string>("project_link_meeting", { p_project: projectId, p_booking: bid, p_visible: true });
    await db.query(`update project_meetings set title = $2 where id = $1`, [mid, title]);
    return { bid, mid };
  }
  const upcoming = () => portal<Up[]>(db, "portal_upcoming_meetings", alice, { p_limit: 3 });

  test("ordre par date, report et annulation lus en direct, sans doublon, plusieurs projets", async () => {
    const autre = await project(db, acme.id, "Refonte", [acme.people["alice@acme.fr"]]);
    const a = await meeting(pid, 3, "Point A");
    const b = await meeting(autre, 5, "Point B");
    const c = await meeting(pid, 7, "Point C");
    const d = await meeting(pid, 9, "Point D");
    expect((await upcoming()).map((m) => [m.title, m.project_name])).toEqual([["Point A", "Site"], ["Point B", "Refonte"], ["Point C", "Site"]]);
    // report : A passe après C
    await db.query("reset role");
    await db.query(`update appt_bookings set starts_at = now() + interval '8 days', ends_at = now() + interval '8 days 30 minutes' where id = $1`, [a.bid]);
    expect((await upcoming()).map((m) => m.title)).toEqual(["Point B", "Point C", "Point A"]);
    // annulation : B disparaît de la liste, reste dans l'historique du projet
    await db.query("reset role");
    await db.query(`update appt_bookings set status = 'cancelled' where id = $1`, [b.bid]);
    const up = await upcoming();
    expect(up.map((m) => m.title)).toEqual(["Point C", "Point A", "Point D"]);
    expect(new Set(up.map((m) => m.id)).size).toBe(up.length);
    const hist = await portal<{ meetings: { title: string; status: string }[] }>(db, "portal_project", alice, { p_project: autre });
    expect(hist.meetings).toEqual([expect.objectContaining({ title: "Point B", status: "cancelled" })]);
    // point masqué, projet non publié : absents
    await db.as("owner");
    await db.query(`update project_meetings set visible_to_client = false where id = $1`, [c.mid]);
    await db.query(`update projects set portal_published = false where id = $1`, [pid]);
    expect(await upcoming()).toEqual([]);
    void d;
  });

  test("lien de visio seulement pour un point confirmé ; aucun champ interne", async () => {
    const a = await meeting(pid, 2, "Point visio");
    await db.query("reset role");
    await db.query(`update appt_bookings set meeting_url = 'https://meet.google.com/abc-defg-hij', internal_note = 'SECRET' where id = $1`, [a.bid]);
    const [m] = await upcoming();
    expect(m.meeting_url).toBe("https://meet.google.com/abc-defg-hij");
    expect(JSON.stringify(m)).not.toMatch(/SECRET|internal_note/);
  });
});
