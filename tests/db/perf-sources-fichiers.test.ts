// Pagination serveur, sources personnalisables, fichiers et droits d'accès.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const make = async (name: string, extra: Record<string, unknown> = {}, people: Record<string, unknown>[] = []) =>
  (await db.rpc<{ id: string }>("create_company", { p_company: { name, ...extra }, p_people: people, p_force: true })).id;
const n = async (sql: string, p?: unknown[]) => (await db.one<{ n: number }>(sql, p)).n;
type Page = { total: number; rows: { id: string; name: string; primary_person_name: string | null; list_ids: string[]; next_action_title: string | null }[] };

describe("companies_page", () => {
  test("pagine, compte le total et n'enrichit que la page", async () => {
    for (let i = 0; i < 7; i++) await make(`Société ${i}`, { website: `s${i}.fr` });
    const p = await db.rpc<Page>("companies_page", { p_sort: "name", p_asc: true, p_limit: 3, p_offset: 3 });
    expect(p.total).toBe(7);
    expect(p.rows.map((r) => r.name)).toEqual(["Société 3", "Société 4", "Société 5"]);
  });

  test("recherche par entreprise, personne, email, domaine ; filtres combinés ; archivées masquées", async () => {
    const a = await make("Acme", { website: "acme.io" }, [{ first_name: "Léa", last_name: "Durand", email: "lea@acme.io" }]);
    const b = await make("Beta", { tags: ["saas"] }, [{ first_name: "Paul", last_name: "Martin" }]);
    await db.rpc("set_archived", { p_ids: [b], p_archived: true });
    const names = async (f: Record<string, unknown>) => (await db.rpc<Page>("companies_page", { p_filters: f })).rows.map((r) => r.name);
    expect(await names({ q: "acme" })).toEqual(["Acme"]);
    expect(await names({ q: "lea durand" })).toEqual(["Acme"]);
    expect(await names({ q: "lea@acme" })).toEqual(["Acme"]);
    expect(await names({ q: "acme.io" })).toEqual(["Acme"]);
    expect(await names({ q: "paul" })).toEqual([]);
    expect(await names({ q: "paul", archived: true })).toEqual(["Beta"]);
    expect(await names({ archived: true, tag: "saas", status: "nouveau" })).toEqual(["Beta"]);
    expect(a).toBeTruthy();
  });

  test("la ligne porte contact principal, listes et prochaine action sans requête supplémentaire", async () => {
    const a = await make("Acme", {}, [{ first_name: "Léa", last_name: "Durand" }]);
    const l = await db.one<{ id: string }>(`insert into lists (name) values ('L') returning id`);
    await db.query(`insert into list_members (list_id, company_id) values ($1, $2)`, [l.id, a]);
    await db.query(`insert into tasks (company_id, title, due_date) values ($1, 'Relancer', current_date)`, [a]);
    const r = (await db.rpc<Page>("companies_page", { p_filters: { list: l.id } })).rows[0];
    expect(r).toMatchObject({ primary_person_name: "Léa Durand", list_ids: [l.id], next_action_title: "Relancer" });
    const ids = await db.rpc<string[]>("companies_page", { p_filters: { list: l.id }, p_ids_only: true });
    expect(ids).toEqual([a]);
  });

  test("le tri ne peut pas injecter de SQL : valeur inconnue = tri par défaut", async () => {
    await make("Acme");
    const p = await db.rpc<Page>("companies_page", { p_sort: "name; drop table companies" });
    expect(p.total).toBe(1);
    expect(await n(`select count(*)::int n from companies`)).toBe(1);
  });
});

describe("sources", () => {
  const src = async (name: string) => (await db.one<{ id: string }>(`insert into lead_sources (name, color) values ($1, 'violet') returning id`, [name])).id;

  test("renommer conserve l'association, archiver aussi", async () => {
    const s = await src("Salon");
    const a = await make("Acme", { source_id: s });
    await db.query(`update lead_sources set name = 'Salon Tech', archived_at = now() where id = $1`, [s]);
    const r = await db.one<{ source_id: string; name: string }>(`select c.source_id, s.name from companies c join lead_sources s on s.id = c.source_id where c.id = $1`, [a]);
    expect(r).toEqual({ source_id: s, name: "Salon Tech" });
  });

  test("suppression : fiches réaffectées ou source vidée, jamais supprimées", async () => {
    const s1 = await src("A1");
    const s2 = await src("A2");
    const s3 = await src("A3");
    const a = await make("Acme", { source_id: s1 });
    const moved = await db.rpc<{ moved: number }>("delete_source", { p_id: s1, p_replacement: s2 });
    expect(moved.moved).toBe(1);
    expect((await db.one<{ source_id: string }>(`select source_id from companies where id = $1`, [a])).source_id).toBe(s2);
    await db.query(`update companies set source_id = $1 where id = $2`, [s3, a]);
    await db.rpc("delete_source", { p_id: s3 });
    expect((await db.one<{ source_id: string | null }>(`select source_id from companies where id = $1`, [a])).source_id).toBeNull();
    expect(await n(`select count(*)::int n from companies`)).toBe(1);
  });

  test("modification groupée et réordonnancement ; Claude ne peut ni supprimer ni modifier en masse", async () => {
    const s = await src("Groupé");
    const a = await make("A1");
    const b = await make("B1");
    expect(await db.rpc<number>("set_companies_source", { p_ids: [a, b], p_source: s })).toBe(2);
    const p = await db.rpc<Page>("companies_page", { p_filters: { source: s } });
    expect(p.total).toBe(2);
    expect((await db.rpc<Page>("companies_page", { p_filters: { source: "none" } })).total).toBe(0);
    await db.as("claude");
    await expect(db.rpc("delete_source", { p_id: s })).rejects.toThrow(/impossible via Claude/);
    await expect(db.rpc("set_companies_source", { p_ids: [a, b], p_source: null })).rejects.toThrow(/impossible via Claude/);
  });
});

describe("fichiers", () => {
  const file = (company: string, path = "x/y.pdf") =>
    db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes) values ($1, $2, 'Offre.pdf', 'application/pdf', 1000) returning id`, [company, path]);

  test("le bucket est privé, avec limite de taille et formats", async () => {
    await db.exec(`reset role;`);
    const b = await db.one<{ public: boolean; file_size_limit: string }>(`select public, file_size_limit from storage.buckets where id = 'company-files'`);
    expect(b.public).toBe(false);
    expect(Number(b.file_size_limit)).toBe(26214400);
  });

  test("un anonyme ou un autre compte ne lit ni métadonnées ni objets", async () => {
    const a = await make("Acme");
    await file(a);
    await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', 'x/y.pdf')`);
    expect(await n(`select count(*)::int n from storage.objects`)).toBe(1);
    await db.as("stranger");
    expect((await db.query(`select * from company_files`)).rows).toHaveLength(0);
    expect((await db.query(`select * from storage.objects`)).rows).toHaveLength(0);
    await expect(db.query(`insert into storage.objects (bucket_id, name) values ('company-files', 'pirate')`)).rejects.toThrow(/row-level security/);
    await db.as("anon");
    await expect(db.query(`select * from company_files`)).rejects.toThrow(/permission denied/);
    expect((await db.query(`select * from storage.objects`)).rows).toHaveLength(0);
  });

  test("la fusion et le passage en pipeline conservent les fichiers", async () => {
    const a = await make("Acme");
    const b = await make("Acme bis");
    const f = await file(b);
    await db.rpc("merge_companies", { p_keep: a, p_merge: b });
    expect((await db.one<{ company_id: string }>(`select company_id from company_files where id = $1`, [f.id])).company_id).toBe(a);
  });

  test("taille et catégorie contrôlées en base ; Claude ne supprime pas", async () => {
    const a = await make("Acme");
    await expect(db.query(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes) values ($1, 'a', 'g', 'application/pdf', 99999999)`, [a])).rejects.toThrow();
    await expect(db.query(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, category) values ($1, 'b', 'g', 'application/pdf', 10, 'Inconnue')`, [a])).rejects.toThrow();
    await file(a);
    await db.as("claude");
    expect((await db.query(`delete from company_files`)).affectedRows).toBe(0);
  });
});
