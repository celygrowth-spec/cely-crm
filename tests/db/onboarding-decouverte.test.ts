// Onboarding de l'offre découverte : réglage, cloisonnement par projet, réponses concurrentes, envoi unique,
// cibles, dépôts, actions dans Aujourd'hui. Deux clients fictifs ; identifiants manipulés.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let globex: Awaited<ReturnType<typeof company>>;
let pid: string;
let gid: string;
let alice: string;
let bob: string;
let gina: string;

const err = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; message: string }) => e.code ?? e.message);
type View = {
  answers: Record<string, { value: string; rev: number; by: string; mine: boolean }>;
  steps: Record<string, { status: string }>;
  targets: { position: number; name: string; sector: string; rev: number; validated_at: string | null; modified_since_validation: boolean; client_filled: string[]; comments: { body: string }[] }[];
  files: { id: string; step: string; name: string; mine: boolean; account: string | null }[];
  sent_at: string | null;
  position: string | null;
};

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "[TEST] Acme", [{ first_name: "Alice", email: "alice@acme.test" }, { first_name: "Bob", email: "bob@acme.test" }]);
  globex = await company(db, "[TEST] Globex", [{ first_name: "Gina", email: "gina@globex.test" }]);
  pid = await project(db, acme.id, "Test découverte", [acme.people["alice@acme.test"], acme.people["bob@acme.test"]]);
  gid = await project(db, globex.id, "Autre client", [globex.people["gina@globex.test"]]);
  alice = (await login(db, acme.people["alice@acme.test"])).session;
  bob = (await login(db, acme.people["bob@acme.test"])).session;
  gina = (await login(db, globex.people["gina@globex.test"])).session;
});

async function enable(project = pid, on = true) {
  await db.as("owner");
  await db.rpc("discovery_set_enabled", { p_project: project, p_enabled: on });
}

describe("réglage « Offre découverte »", () => {
  test("décochée par défaut : aucun onglet, aucune lecture ; cochée : onglet et 3 cibles vides", async () => {
    expect(await portal(db, "portal_discovery_enabled", alice, { p_project: pid })).toBe(false);
    expect(await err(portal(db, "portal_discovery", alice, { p_project: pid }))).toBe("P0002");
    await db.as("owner");
    expect(await db.rpc("discovery_admin", { p_project: pid })).toMatchObject({ exists: false, enabled: false, suggested: false });
    await enable();
    expect(await portal(db, "portal_discovery_enabled", alice, { p_project: pid })).toBe(true);
    const v = await portal<View>(db, "portal_discovery", alice, { p_project: pid });
    expect(v.targets.map((t) => t.position)).toEqual([1, 2, 3]);
    expect(v.targets.every((t) => t.name === "")).toBe(true);
  });

  test("décochée après le démarrage : onglet masqué, données conservées et retrouvées si je recoche", async () => {
    await enable();
    await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "offer_pitch", p_value: "On fait X", p_base_rev: 0 });
    await enable(pid, false);
    expect(await portal(db, "portal_discovery_enabled", alice, { p_project: pid })).toBe(false);
    expect(await err(portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "offer_pitch", p_value: "Y", p_base_rev: 1 }))).toBe("P0002");
    await db.as("owner");
    expect(await db.one(`select value from discovery_answers where project_id = $1`, [pid])).toEqual({ value: "On fait X" });
    await enable();
    expect((await portal<View>(db, "portal_discovery", alice, { p_project: pid })).answers.offer_pitch.value).toBe("On fait X");
  });

  test("seule l'application coche la case ; un inconnu, anon ou Claude ne peuvent pas", async () => {
    await db.as("stranger");
    expect(await err(db.rpc("discovery_set_enabled", { p_project: pid, p_enabled: true }))).toBe("42501");
    await db.as("claude");
    expect(await err(db.rpc("discovery_set_enabled", { p_project: pid, p_enabled: true }))).toBe("42501");
    await db.as("anon");
    expect(await err(db.rpc("discovery_set_enabled", { p_project: pid, p_enabled: true }))).not.toBeNull();
    await db.as("anon");
    expect(await err(db.query(`select * from discovery_onboardings`))).not.toBeNull();
  });

  test("une vente dont la mission s'appelle « offre découverte » coche la case ; mon choix n'est jamais écrasé", async () => {
    await db.as("owner");
    const mission = (await db.one<{ id: string }>(`insert into finance_missions (company_id, label, kind, amount, start_date) values ($1, 'Offre découverte', 'ponctuel', 500, '2026-11-20') returning id`, [acme.id])).id;
    await db.query(`insert into sales (company_id, closed_on, project_id, mission_id) values ($1, '2026-11-20', $2, $3)`, [acme.id, pid, mission]);
    expect(await db.rpc("discovery_admin", { p_project: pid })).toMatchObject({ exists: true, enabled: true, enabled_source: "sale" });
    // clients existants (projet déjà en place, rien de lié) : décochée
    expect(await db.rpc("discovery_admin", { p_project: gid })).toMatchObject({ exists: false, enabled: false });
  });
});

describe("cloisonnement entre clients", () => {
  beforeEach(async () => {
    await enable(pid);
    await enable(gid);
  });

  test("un contact d'un autre client ne lit ni n'écrit rien en manipulant l'identifiant du projet", async () => {
    for (const fn of ["portal_discovery", "portal_discovery_send"]) {
      expect(await err(portal(db, fn, gina, { p_project: pid }))).toBe("P0002");
    }
    expect(await portal(db, "portal_discovery_enabled", gina, { p_project: pid })).toBe(false);
    expect(await err(portal(db, "portal_discovery_answer", gina, { p_project: pid, p_key: "x", p_value: "pirate", p_base_rev: 0 }))).toBe("P0002");
    expect(await err(portal(db, "portal_discovery_target_comment", gina, { p_project: pid, p_position: 1, p_body: "pirate" }))).toBe("P0002");
    expect(await err(portal(db, "portal_discovery_file_start", gina, { p_project: pid, p_step: "blacklist", p_name: "a.csv", p_type: "text/csv", p_size: 10, p_ext: "csv", p_account: null }))).toBe("P0002");
    await db.as("owner");
    expect(await db.one(`select count(*)::int n from discovery_answers`)).toEqual({ n: 0 });
  });

  test("dépôt d'un autre client : ni confirmation, ni téléchargement, ni retrait", async () => {
    const s = await portal<{ file_id: string }>(db, "portal_discovery_file_start", alice, { p_project: pid, p_step: "blacklist", p_name: "liste.csv", p_type: "text/csv", p_size: 10, p_ext: "csv", p_account: null });
    expect(await err(portal(db, "portal_discovery_file_confirm", gina, { p_file: s.file_id }))).toBe("P0002");
    expect(await err(portal(db, "portal_discovery_file_resume", gina, { p_file: s.file_id }))).toBe("P0002");
    await db.query("reset role");
    await db.query(`insert into storage.objects (bucket_id, name) select 'company-files', storage_path from company_files where id = $1`, [s.file_id]);
    await portal(db, "portal_discovery_file_confirm", alice, { p_file: s.file_id });
    const id = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).files[0].id;
    expect(await err(portal(db, "portal_discovery_file_grant", gina, { p_id: id }))).toBe("P0002");
    expect(await err(portal(db, "portal_discovery_file_remove", gina, { p_id: id }))).toBe("P0002");
    // Bob (même client) peut télécharger mais pas retirer le dépôt d'Alice
    expect(await portal(db, "portal_discovery_file_grant", bob, { p_id: id })).toMatchObject({ name: "liste.csv" });
    expect(await err(portal(db, "portal_discovery_file_remove", bob, { p_id: id }))).toBe("42501");
  });

  test("session révoquée : plus aucun accès ; projet archivé en lecture seule : lecture sans écriture", async () => {
    await db.as("owner");
    await db.query(`update projects set status = 'archive', archived_portal = 'read_only' where id = $1`, [pid]);
    expect(await portal(db, "portal_discovery", alice, { p_project: pid })).toBeTruthy();
    expect(await err(portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "a", p_value: "b", p_base_rev: 0 }))).toBe("42501");
    await db.as("owner");
    await db.rpc("portal_access_revoke", { p_person: acme.people["alice@acme.test"] });
    expect(await err(portal(db, "portal_discovery", alice, { p_project: pid }))).toBe("28000");
  });
});

describe("réponses, reprise et concurrence", () => {
  beforeEach(() => enable());

  test("deux contacts sur la même réponse : la seconde écriture sur une révision dépassée est refusée et montre l'autre version", async () => {
    expect(await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "offer_pitch", p_value: "Version Alice", p_base_rev: 0 })).toEqual({ ok: true, rev: 1 });
    const c = await portal<{ conflict: boolean; value: string; by: string }>(db, "portal_discovery_answer", bob, { p_project: pid, p_key: "offer_pitch", p_value: "Version Bob", p_base_rev: 0 });
    expect(c).toMatchObject({ ok: false, conflict: true, value: "Version Alice", by: "Alice" });
    // Bob choisit en connaissance de cause : il écrit sur la révision qu'il vient de voir
    expect(await portal(db, "portal_discovery_answer", bob, { p_project: pid, p_key: "offer_pitch", p_value: "Version Bob", p_base_rev: 1 })).toEqual({ ok: true, rev: 2 });
    const v = await portal<View>(db, "portal_discovery", alice, { p_project: pid });
    expect(v.answers.offer_pitch).toMatchObject({ value: "Version Bob", by: "Bob", mine: false });
  });

  test("reprise exacte par contact ; clés et écrans malformés refusés", async () => {
    await portal(db, "portal_discovery_position", alice, { p_project: pid, p_screen: "offer:3" });
    await portal(db, "portal_discovery_position", bob, { p_project: pid, p_screen: "lemlist" });
    expect((await portal<View>(db, "portal_discovery", alice, { p_project: pid })).position).toBe("offer:3");
    expect((await portal<View>(db, "portal_discovery", bob, { p_project: pid })).position).toBe("lemlist");
    expect(await err(portal(db, "portal_discovery_position", alice, { p_project: pid, p_screen: "<script>" }))).toBe("22023");
    expect(await err(portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "../x", p_value: "a", p_base_rev: 0 }))).toBe("22023");
    expect(await err(portal(db, "portal_discovery_step", alice, { p_project: pid, p_step: "admin", p_status: "done" }))).toBe("22023");
  });
});

describe("envoi", () => {
  beforeEach(() => enable());

  test("double clic : un seul envoi, une seule action « Onboarding reçu, à traiter » dans Aujourd'hui", async () => {
    const [a, b] = await Promise.all([
      portal<{ already: boolean }>(db, "portal_discovery_send", alice, { p_project: pid }),
      portal<{ already: boolean }>(db, "portal_discovery_send", alice, { p_project: pid }),
    ]);
    expect([a.already, b.already].sort()).toEqual([false, true]);
    expect((await portal<{ already: boolean }>(db, "portal_discovery_send", bob, { p_project: pid })).already).toBe(true);
    await db.as("owner");
    const todo = await db.query<{ title: string; project_id: string }>(`select title, project_id from todo_items where item_type = 'project_task'`);
    expect(todo.rows).toEqual([{ title: "Onboarding reçu, à traiter", project_id: pid }]);
  });

  test("modification après l'envoi : tracée (avant / après), une seule action « modifié » ouverte", async () => {
    await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "never_say", p_value: "Pas de tutoiement", p_base_rev: 0 });
    await portal(db, "portal_discovery_send", alice, { p_project: pid });
    await portal(db, "portal_discovery_answer", bob, { p_project: pid, p_key: "never_say", p_value: "Pas de tutoiement ni d'emoji", p_base_rev: 1 });
    await portal(db, "portal_discovery_step", bob, { p_project: pid, p_step: "lemlist", p_status: "done" });
    await db.as("owner");
    const a = await db.rpc<{ changes: { label: string; before: string | null; after: string | null; by: string }[]; changed_after_send_at: string | null }>("discovery_admin", { p_project: pid });
    expect(a.changed_after_send_at).not.toBeNull();
    expect(a.changes.map((c) => [c.label, c.before, c.after, c.by])).toEqual([
      ["lemlist", null, "done", "Bob"],
      ["never_say", "Pas de tutoiement", "Pas de tutoiement ni d'emoji", "Bob"],
    ]);
    expect((await db.query(`select title from project_tasks where project_id = $1 and title like 'Onboarding modifié%'`, [pid])).rows).toHaveLength(1);
  });
});

describe("cibles", () => {
  beforeEach(() => enable());

  test("préparation par moi : tout peut rester vide, enregistrer sans changement ne touche à rien ; Claude et anon ne préparent pas", async () => {
    await db.as("owner");
    expect(await db.rpc("discovery_target_save", { p_project: pid, p_position: 3, p_data: JSON.stringify({ name: "", notes: "" }) })).toMatchObject({ changed: false, rev: 1 });
    expect(await db.rpc("discovery_target_save", { p_project: pid, p_position: 3, p_data: JSON.stringify({ name: "  Agences  ", roles: "Fondateurs" }) })).toMatchObject({ changed: true, rev: 2, validation_dropped: false });
    expect(await db.one(`select name, roles, sector from discovery_targets where project_id = $1 and position = 3`, [pid])).toEqual({ name: "Agences", roles: "Fondateurs", sector: "" });
    expect(await err(db.rpc("discovery_target_save", { p_project: pid, p_position: 4, p_data: "{}" }))).toBe("22023");
    expect(await err(db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ name: "x".repeat(121) }) }))).not.toBeNull();
    await db.as("claude");
    expect(await err(db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ name: "Claude" }) }))).toBe("42501");
    await db.as("anon");
    expect(await err(db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ name: "Anon" }) }))).not.toBeNull();
  });

  test("je réécris un champ rempli par le client : il redevient le mien", async () => {
    let t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[0];
    await portal(db, "portal_discovery_target_fill", alice, { p_project: pid, p_position: 1, p_field: "sector", p_value: "Santé", p_base_rev: t.rev });
    await db.as("owner");
    await db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ sector: "Santé privée" }) });
    t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[0];
    expect(t.client_filled).toEqual([]);
    expect(await err(portal(db, "portal_discovery_target_fill", alice, { p_project: pid, p_position: 1, p_field: "sector", p_value: "Autre", p_base_rev: t.rev }))).toBe("42501");
  });

  test("préremplie, validée, puis modifiée par moi : validation retirée et « Modifiée depuis ta validation »", async () => {
    await db.as("owner");
    await db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ name: "DAF ETI", sector: "Industrie" }) });
    let t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[0];
    expect(await portal(db, "portal_discovery_target_validate", alice, { p_project: pid, p_position: 1, p_base_rev: t.rev })).toMatchObject({ ok: true });
    await db.as("owner");
    expect(await db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ sector: "Industrie et BTP" }) })).toMatchObject({ validation_dropped: true });
    t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[0];
    expect(t).toMatchObject({ validated_at: null, modified_since_validation: true, sector: "Industrie et BTP" });
    // valider une version périmée : refusé, la version actuelle est renvoyée
    expect(await portal(db, "portal_discovery_target_validate", alice, { p_project: pid, p_position: 1, p_base_rev: t.rev - 1 })).toMatchObject({ conflict: true });
    await portal(db, "portal_discovery_target_validate", alice, { p_project: pid, p_position: 1, p_base_rev: t.rev });
    t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[0];
    expect(t.modified_since_validation).toBe(false);
  });

  test("le client remplit un champ vide, pas un champ préparé ; un commentaire crée une action (une seule au double clic)", async () => {
    await db.as("owner");
    await db.rpc("discovery_target_save", { p_project: pid, p_position: 2, p_data: JSON.stringify({ name: "Cabinets RH" }) });
    let t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[1];
    expect(await err(portal(db, "portal_discovery_target_fill", alice, { p_project: pid, p_position: 2, p_field: "name", p_value: "Autre", p_base_rev: t.rev }))).toBe("42501");
    expect(await portal(db, "portal_discovery_target_fill", alice, { p_project: pid, p_position: 2, p_field: "geography", p_value: "Île-de-France", p_base_rev: t.rev })).toMatchObject({ ok: true });
    expect(await err(portal(db, "portal_discovery_target_fill", alice, { p_project: pid, p_position: 2, p_field: "is_admin", p_value: "x", p_base_rev: t.rev + 1 }))).toBe("22023");
    t = (await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[1];
    expect(t.client_filled).toEqual(["geography"]);
    await Promise.all([1, 2].map(() => portal(db, "portal_discovery_target_comment", bob, { p_project: pid, p_position: 2, p_body: "Plutôt les cabinets de plus de 20 personnes" })));
    await db.as("owner");
    const tasks = (await db.query<{ title: string }>(`select title from todo_items where item_type = 'project_task'`)).rows;
    expect(tasks).toEqual([{ title: "Onboarding : commentaire sur la cible 2 (Cabinets RH) à traiter" }]);
    expect((await portal<View>(db, "portal_discovery", alice, { p_project: pid })).targets[1].comments).toHaveLength(1);
  });
});

describe("dépôts", () => {
  beforeEach(() => enable());

  test("types et tailles par étape, contrôlés en base ; nom du compte exigé pour LinkedIn", async () => {
    const start = (step: string, type: string, size: number, account: string | null = null) =>
      err(portal(db, "portal_discovery_file_start", alice, { p_project: pid, p_step: step, p_name: "f", p_type: type, p_size: size, p_ext: "x", p_account: account }));
    expect(await start("blacklist", "text/html", 10)).toBe("22023");
    expect(await start("blacklist", "text/csv", 60 * 1024 * 1024)).toBe("22023");
    expect(await start("linkedin", "application/zip", 10)).toBe("22023");
    expect(await start("linkedin", "application/zip", 2 * 1024 ** 3, "Alice")).toBe("22023");
    expect(await start("linkedin", "application/zip", 600 * 1024 * 1024, "Alice")).toBeNull();
    expect(await start("documents", "image/svg+xml", 10)).toBe("22023");
  });

  test("le dépôt rejoint la fiche et le dossier interne du projet ; invisible du portail « Fichiers »", async () => {
    const s = await portal<{ file_id: string; path: string }>(db, "portal_discovery_file_start", alice, { p_project: pid, p_step: "linkedin", p_name: "Basic_LinkedInDataExport.zip", p_type: "application/zip", p_size: 400 * 1024 * 1024, p_ext: "zip", p_account: "Alice Martin" });
    expect(s.path.startsWith(`${acme.id}/`)).toBe(true);
    // Storage : envoi autorisé pour cet objet seulement (anon), pas pour un autre chemin
    await db.as("anon");
    expect(await err(db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/${randomUUID()}.zip`]))).not.toBeNull();
    await db.as("anon");
    await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [s.path]);
    expect(await err(portal(db, "portal_discovery_file_confirm", bob, { p_file: s.file_id }))).toBe("P0002");
    await portal(db, "portal_discovery_file_confirm", alice, { p_file: s.file_id });
    expect(await portal(db, "portal_discovery_file_confirm", alice, { p_file: s.file_id })).toMatchObject({ ok: true });
    await db.as("owner");
    expect(await db.one(`select f.status, f.size_bytes::int as size, fo.name as folder, fo.visible_to_client from company_files f join project_files pf on pf.file_id = f.id join project_folders fo on fo.id = pf.folder_id where f.id = $1`, [s.file_id]))
      .toEqual({ status: "ready", size: 400 * 1024 * 1024, folder: "Onboarding offre découverte", visible_to_client: false });
    const files = await portal<{ files: unknown[] }>(db, "portal_files", alice, { p_project: pid, p_limit: 100, p_offset: 0 });
    expect(files.files).toHaveLength(0);
    const v = await portal<View>(db, "portal_discovery", bob, { p_project: pid });
    expect(v.files).toMatchObject([{ step: "linkedin", account: "Alice Martin", mine: false }]);
  });

  test("le circuit habituel du portail reste limité à 25 Mo", async () => {
    expect(await err(portal(db, "portal_file_start", alice, { p_project: pid, p_folder: null, p_task: null, p_name: "gros.zip", p_type: "application/zip", p_size: 30 * 1024 * 1024, p_ext: "zip" }))).toBe("22023");
  });
});
