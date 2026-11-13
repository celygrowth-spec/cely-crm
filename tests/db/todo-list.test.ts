// Productivité › To do list en base : création sans doublon, urgence imposée, coche, modification, fiche liée
// (une au plus, fusion, archivage, corbeille, purge), suppression par la Corbeille, accès réservé au propriétaire.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, migrationFiles, migrationVersion, type Db } from "./harness";

let db: Db;
let a: string;
let b: string;
type Todo = { id: string; title: string; urgency: string; company_id: string | null; done_at: string | null };
const create = (title: string, urgency: string | null = "moyen", company: string | null = null, id = randomUUID()) =>
  db.rpc<Todo>("todo_list_create", { p_id: id, p_title: title, p_urgency: urgency, p_company: company });
const all = async () => (await db.query<Todo>(`select * from todo_list_items order by created_at`)).rows;
const admin = async <T>(fn: () => Promise<T>) => { await db.exec("reset role"); try { return await fn(); } finally { await db.as("owner"); } };

beforeEach(async () => {
  db = await createDb();
  a = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Client A" }, p_people: [], p_force: true })).id;
  b = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Prospect B" }, p_people: [], p_force: true })).id;
});

describe("création", () => {
  test("titre, urgence « Moyen » par défaut, fiche facultative", async () => {
    const t = await create("  Relancer le devis  ", null, a);
    expect(t).toMatchObject({ title: "Relancer le devis", urgency: "moyen", company_id: a, done_at: null });
    expect((await create("Sans fiche")).company_id).toBeNull();
  });

  test("double clic ou double validation : une seule tâche, rien de réécrit", async () => {
    const id = randomUUID();
    const [x, y] = await Promise.all([create("Préparer l'atelier", "urgent", null, id), create("Préparer l'atelier", "urgent", null, id)]);
    expect(x.id).toBe(id);
    expect(y.id).toBe(id);
    await create("Autre titre", "pas_urgent", null, id); // « Réessayer » avec le même identifiant
    expect(await all()).toHaveLength(1);
    expect((await all())[0]).toMatchObject({ title: "Préparer l'atelier", urgency: "urgent" });
  });

  test("urgence et titre imposés par la base, même par écriture directe", async () => {
    await expect(create("x", "critique")).rejects.toThrow(/check constraint/);
    await expect(create("   ")).rejects.toThrow(/check constraint/);
    await expect(db.query(`insert into todo_list_items (title, urgency) values ('x', 'URGENT')`)).rejects.toThrow(/check constraint/);
    await expect(db.query(`insert into todo_list_items (title) values ($1)`, ["x".repeat(301)])).rejects.toThrow(/check constraint/);
  });
});

describe("liste", () => {
  test("ordre d'affichage : Urgent, Moyen, Pas urgent ; à urgence égale la plus récente d'abord", async () => {
    for (const [title, u] of [["m1", "moyen"], ["p1", "pas_urgent"], ["u1", "urgent"], ["m2", "moyen"], ["u2", "urgent"]] as const) {
      await create(title, u);
      await db.query(`select pg_sleep(0.002)`);
    }
    const order = await db.query<{ title: string }>(
      `select title from todo_list_items where done_at is null
        order by case urgency when 'urgent' then 0 when 'moyen' then 1 else 2 end, created_at desc`);
    expect(order.rows.map((r) => r.title)).toEqual(["u2", "u1", "m2", "m1", "p1"]);
  });

  test("cocher puis décocher, modifier titre, urgence et fiche liée", async () => {
    const t = await create("Envoyer la facture", "moyen", a);
    await db.query(`update todo_list_items set done_at = now() where id = $1`, [t.id]);
    expect((await all())[0].done_at).not.toBeNull();
    await db.query(`update todo_list_items set done_at = null where id = $1`, [t.id]);
    expect((await all())[0].done_at).toBeNull();
    await db.query(`update todo_list_items set title = 'Envoyer la facture n° 2', urgency = 'urgent', company_id = $2 where id = $1`, [t.id, b]);
    expect((await all())[0]).toMatchObject({ title: "Envoyer la facture n° 2", urgency: "urgent", company_id: b });
    await db.query(`update todo_list_items set company_id = null where id = $1`, [t.id]);
    expect((await all())[0].company_id).toBeNull();
    await expect(db.query(`update todo_list_items set urgency = 'bientot' where id = $1`, [t.id])).rejects.toThrow(/check constraint/);
  });
});

describe("fiche liée", () => {
  test("une seule fiche au plus ; identifiant inconnu ou manipulé refusé", async () => {
    const cols = await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'todo_list_items' and column_name like '%company%'`);
    expect(cols.rows.map((r) => r.column_name)).toEqual(["company_id"]);
    await expect(create("x", "moyen", randomUUID())).rejects.toThrow(/Fiche introuvable|foreign key/);
    const t = await create("x");
    await expect(db.query(`update todo_list_items set company_id = $2 where id = $1`, [t.id, randomUUID()])).rejects.toThrow(/Fiche introuvable|foreign key/);
  });

  test("tâches ouvertes d'une fiche (vue de la fiche)", async () => {
    await create("Ouverte A", "urgent", a);
    const done = await create("Terminée A", "moyen", a);
    await create("Pour B", "moyen", b);
    await db.query(`update todo_list_items set done_at = now() where id = $1`, [done.id]);
    const r = await db.query<{ title: string }>(`select title from todo_list_items where company_id = $1 and done_at is null`, [a]);
    expect(r.rows.map((x) => x.title)).toEqual(["Ouverte A"]);
  });

  test("fusion (Doublons) : le lien suit la fiche conservée ; une fiche absorbée ne se choisit plus", async () => {
    const t = await create("Suivi", "moyen", b);
    await db.rpc("merge_companies", { p_keep: a, p_merge: b, p_fields: {}, p_pipeline_from: "keep" });
    expect((await admin(() => db.one<{ m: string }>(`select merged_into_id m from companies where id = $1`, [b]))).m).toBe(a);
    expect((await all()).find((x) => x.id === t.id)?.company_id).toBe(a);
    await expect(create("Nouvelle", "moyen", b)).rejects.toThrow(/Fiche introuvable/);
  });

  test("fiche archivée : la tâche reste liée", async () => {
    const t = await create("Archive", "moyen", a);
    await db.query(`update companies set archived_at = now() where id = $1`, [a]);
    expect((await all())[0]).toMatchObject({ id: t.id, company_id: a });
  });

  test("fiche à la corbeille : la tâche reste ; restaurée, le lien revient ; purgée, le lien se vide", async () => {
    const t = await create("Rappeler", "urgent", a);
    const put = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "company", p_id: a });
    expect(await all()).toHaveLength(1);
    expect((await all())[0].company_id).toBe(a);
    expect((await db.query(`select id from companies where id = $1`, [a])).rows).toEqual([]); // nom non lisible : « fiche à la corbeille »
    await expect(create("Nouvelle", "moyen", a)).rejects.toThrow(/Fiche introuvable/);
    await db.rpc("trash_restore", { p_trash: put.trash_id, p_with_parent: false });
    expect((await db.query(`select id from companies where id = $1`, [a])).rows).toHaveLength(1);
    const again = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "company", p_id: a });
    await db.rpc("trash_purge", { p_trash: again.trash_id });
    expect(await all()).toEqual([expect.objectContaining({ id: t.id, title: "Rappeler", company_id: null })]);
  });
});

describe("suppression par la Corbeille", () => {
  test("mise à la corbeille, invisible, restaurée à l'identique, puis purgée ; double clic sans effet", async () => {
    const t = await create("À jeter", "pas_urgent", a);
    const preview = await db.rpc<{ label: string; context: string }>("trash_preview", { p_kind: "todo_list_item", p_id: t.id });
    expect(preview).toMatchObject({ label: "À jeter", context: "To do list · [TEST] Client A" });
    const first = await db.rpc<{ trash_id: string; already: boolean }>("trash_put", { p_kind: "todo_list_item", p_id: t.id });
    const second = await db.rpc<{ trash_id: string; already: boolean }>("trash_put", { p_kind: "todo_list_item", p_id: t.id });
    expect(second).toMatchObject({ trash_id: first.trash_id, already: true });
    expect(await all()).toEqual([]);
    await expect(db.query(`update todo_list_items set title = 'x' where id = $1`, [t.id])).resolves.toMatchObject({ affectedRows: 0 });
    await db.rpc("trash_restore", { p_trash: first.trash_id, p_with_parent: false });
    expect(await all()).toEqual([expect.objectContaining({ id: t.id, title: "À jeter", urgency: "pas_urgent", company_id: a })]);
    const third = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "todo_list_item", p_id: t.id });
    await db.rpc("trash_purge", { p_trash: third.trash_id });
    expect((await admin(() => db.query(`select id from todo_list_items`))).rows).toEqual([]);
    // la fiche liée n'est pas touchée
    expect((await db.query(`select id from companies where id = $1`, [a])).rows).toHaveLength(1);
  });

  test("les types de corbeille existants sont conservés dans le registre", async () => {
    const kinds = (await db.query<{ kind: string; row_table: string }>(`select kind, row_table from trash_private.kinds order by kind`)).rows;
    expect(kinds).toEqual(expect.arrayContaining([
      { kind: "company", row_table: "companies" }, { kind: "person", row_table: "people" }, { kind: "project", row_table: "projects" },
      { kind: "project_task", row_table: "project_tasks" }, { kind: "project_idea", row_table: "project_ideas" },
      { kind: "project_phase", row_table: "project_phases" }, { kind: "project_meeting", row_table: "project_meetings" },
      { kind: "finance_mission", row_table: "finance_missions" }, { kind: "finance_invoice", row_table: "finance_invoices" },
      { kind: "finance_payment", row_table: "finance_payments" }, { kind: "todo_list_item", row_table: "todo_list_items" },
    ]));
    expect(kinds).toHaveLength(11);
    await expect(db.rpc("trash_put", { p_kind: "inconnu", p_id: randomUUID() })).rejects.toThrow(/Type d'élément inconnu/);
  });
});

describe("accès", () => {
  test("portail (anon), autre compte, identifiants manipulés et Claude : aucun accès", async () => {
    const t = await create("Secret", "urgent", a);
    await db.as("anon");
    await expect(db.query(`select * from todo_list_items`)).rejects.toThrow(/permission denied/);
    await expect(create("x")).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select * from todo_list_items`)).rows).toEqual([]);
    await expect(create("x")).rejects.toThrow(/Accès refusé/);
    expect((await db.query(`update todo_list_items set title = 'pirate', done_at = now() where id = $1`, [t.id])).affectedRows).toBe(0);
    expect((await db.query(`delete from todo_list_items where id = $1`, [t.id])).affectedRows).toBe(0);
    await expect(db.query(`insert into todo_list_items (title) values ('x')`)).rejects.toThrow(/row-level security/);
    await expect(db.rpc("trash_put", { p_kind: "todo_list_item", p_id: t.id })).rejects.toThrow(/Accès refusé|introuvable|row-level/);
    await db.as("claude");
    expect((await db.query(`select * from todo_list_items`)).rows).toEqual([]);
    await expect(create("x")).rejects.toThrow(/réservée à l'application/);
    await db.as("owner");
    expect(await all()).toEqual([expect.objectContaining({ id: t.id, title: "Secret", done_at: null })]);
  });
});

describe("migration", () => {
  test("mise à niveau depuis l'état précédent avec des éléments déjà à la corbeille", async () => {
    const files = migrationFiles();
    const i = files.findIndex((f) => f.endsWith("_todo_list.sql"));
    const before = migrationVersion(files[i - 1]);
    const old = await createDb({ upTo: before });
    const c = (await old.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Ancienne" }, p_people: [], p_force: true })).id;
    const tr = await old.rpc<{ trash_id: string }>("trash_put", { p_kind: "company", p_id: c });
    const { applyMigrations } = await import("./harness");
    await applyMigrations(old, { after: before });
    await old.as("owner");
    expect((await old.query(`select kind from trash_items`)).rows).toEqual([{ kind: "company" }]);
    await old.rpc("trash_restore", { p_trash: tr.trash_id, p_with_parent: false });
    expect((await old.query(`select id from companies where id = $1`, [c])).rows).toHaveLength(1);
  });
});
