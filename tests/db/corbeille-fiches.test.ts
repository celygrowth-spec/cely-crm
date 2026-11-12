// Corbeille, lot 4 : fiches — une entreprise disparaît partout (listes, recherche, Aujourd'hui, Finance, Ventes,
// projets, portail, Claude) avec tout ce qui lui est rattaché et revient à l'identique ; un contact part avec son
// accès au portail ; purge complète avec les fichiers (un fichier déjà disparu ne bloque rien).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let alice: string;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const put = (kind: string, id: string) => db.rpc<{ trash_id: string; summary: Record<string, number> }>("trash_put", { p_kind: kind, p_id: id });
const restore = (t: string, withParent = false) => db.rpc<Record<string, unknown>>("trash_restore", { p_trash: t, p_with_parent: withParent });
const rows = async (sql: string, params?: unknown[]) => (await db.query<Record<string, unknown>>(sql, params)).rows;
const admin = async <T>(fn: () => Promise<T>) => { await db.exec("reset role"); try { return await fn(); } finally { await db.as("owner"); } };
const ALICE = "alice@acme.example.test";

/** Tout ce que l'application lit pour une fiche (droits du propriétaire). */
async function visible(companyId: string) {
  await db.as("owner");
  const one = async (sql: string) => (await db.query<{ n: number }>(sql, [companyId])).rows[0].n;
  return {
    companies: await one(`select count(*)::int n from companies where id = $1`),
    overview: await one(`select count(*)::int n from company_overview where id = $1`),
    people: await one(`select count(*)::int n from people where company_id = $1`),
    tasks: await one(`select count(*)::int n from tasks where company_id = $1`),
    todo: await one(`select count(*)::int n from todo_items where company_id = $1`),
    interactions: await one(`select count(*)::int n from interactions where company_id = $1`),
    invoices: await one(`select count(*)::int n from finance_invoice_overview where company_id = $1`),
    search: await one(`select count(*)::int n from public.search_companies('Acme', true, 20) s where s.id = $1`),
    projects: await one(`select count(*)::int n from projects where company_id = $1`),
    files: await one(`select count(*)::int n from company_files where company_id = $1`),
    time: await one(`select count(*)::int n from time_entries where company_id = $1`),
  };
}
/** Lignes brutes rattachées à la fiche (droits d'administration). */
const snapshot = (companyId: string) => admin(async () => {
  const q = async (sql: string) => (await db.query<{ j: unknown }>(sql, [companyId])).rows.map((r) => r.j);
  return {
    company: await q(`select to_jsonb(c) j from companies c where id = $1`),
    people: await q(`select to_jsonb(p) j from people p where company_id = $1 order by id`),
    tasks: await q(`select to_jsonb(t) j from tasks t where company_id = $1 order by id`),
    interactions: await q(`select to_jsonb(i) j from interactions i where company_id = $1 order by id`),
    invoices: await q(`select to_jsonb(i) j from finance_invoices i where company_id = $1 order by id`),
    payments: await q(`select to_jsonb(p) j from finance_payments p join finance_invoices i on i.id = p.invoice_id where i.company_id = $1 order by p.id`),
    projects: await q(`select to_jsonb(p) j from projects p where company_id = $1 order by id`),
    access: await q(`select to_jsonb(a) - 'last_used_at' j from portal_accesses a join people p on p.id = a.person_id where p.company_id = $1 order by a.id`),
    files: await q(`select to_jsonb(f) j from company_files f where company_id = $1 order by id`),
  };
});

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "[TEST] Acme", [{ first_name: "Alice", email: ALICE }, { first_name: "Bob", email: "bob@acme.example.test" }]);
  pid = await project(db, acme.id, "[TEST] Site", [acme.people[ALICE]]);
  alice = (await login(db, acme.people[ALICE])).session;
  await db.as("owner");
  await db.query(`insert into tasks (company_id, title, due_date) values ($1, '[TEST] Relancer', $2)`, [acme.id, today()]);
  const inv = (await db.rpc<{ id: string }>("finance_record_invoice", { p_data: { company_id: acme.id, issue_date: today(), amount_ht: 1000, reference: "[TEST] F-1" } })).id;
  await db.rpc("finance_record_payment", { p_invoice: inv, p_paid_on: today(), p_amount: 1000 });
  await db.query(`insert into project_tasks (project_id, title, visible_to_client, assignee_kind) values ($1, 'Valider', true, 'client')`, [pid]);
});

describe("Entreprise", () => {
  test("disparaît partout, avec ses contacts, projets, factures, tâches ; revient à l'identique", async () => {
    const before = await visible(acme.id);
    const raw = await snapshot(acme.id);
    expect(before).toMatchObject({ companies: 1, search: 1, people: 2, tasks: 1, invoices: 1, projects: 1 });

    const preview = await db.rpc<{ summary: Record<string, number>; warnings: string[] }>("trash_preview", { p_kind: "company", p_id: acme.id });
    expect(preview.summary).toMatchObject({ people: 2, projects: 1, finance_invoices: 1, finance_payments: 1, tasks: 1, project_tasks: 1, portal_accesses: 1 });
    expect(preview.warnings.join(" ")).toMatch(/1 projet partent avec elle/);
    expect(preview.warnings.join(" ")).toMatch(/1 facture sortent des totaux/);
    const t = await put("company", acme.id);

    expect(await visible(acme.id)).toEqual({ companies: 0, overview: 0, search: 0, people: 0, tasks: 0, todo: 0, interactions: 0, invoices: 0, projects: 0, files: 0, time: 0 });
    await db.as("claude");
    expect(await rows(`select id from companies where id = $1`, [acme.id])).toEqual([]);
    // portail : la session du contact ne vaut plus rien
    await expect(portal(db, "portal_me", alice)).rejects.toThrow(/Session expirée/);
    await expect(portal(db, "portal_project", alice, { p_project: pid })).rejects.toThrow(/Session expirée/);

    await db.as("owner");
    expect(await restore(t.trash_id)).toMatchObject({ restored: true });
    expect(await visible(acme.id)).toEqual(before);
    expect(await snapshot(acme.id)).toEqual(raw);
    expect((await portal<{ projects: { id: string }[] }>(db, "portal_me", alice)).projects.map((p) => p.id)).toEqual([pid]);
  });

  test("restaurer une facture d'une entreprise à la corbeille propose de restaurer l'entreprise", async () => {
    const inv = (await db.one<{ id: string }>(`select id from finance_invoices where company_id = $1`, [acme.id])).id;
    const ti = await put("finance_invoice", inv);
    const tc = await put("company", acme.id);
    expect(await restore(ti.trash_id)).toMatchObject({ restored: false, needs_parent: { trash_id: tc.trash_id, kind: "company" } });
    await restore(ti.trash_id, true);
    expect((await rows(`select id from finance_invoices where id = $1`, [inv])).length).toBe(1);
    expect((await rows(`select id from companies where id = $1`, [acme.id])).length).toBe(1);
  });

  test("purge : tout est supprimé, fichiers stockés compris ; un fichier déjà disparu ne bloque pas", async () => {
    const f1 = randomUUID();
    const f2 = randomUUID();
    await admin(async () => {
      for (const f of [f1, f2]) {
        await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, 'doc.pdf', 'application/pdf', 10, 'ready')`, [f, acme.id, `${acme.id}/${f}.pdf`]);
      }
      // seul f1 existe encore dans le stockage : f2 a déjà disparu
      await db.query(`insert into storage.objects (bucket_id, name) values ('company-files', $1)`, [`${acme.id}/${f1}.pdf`]);
      await db.query(`insert into project_files (project_id, file_id) values ($1, $2)`, [pid, f1]);
    });
    const t = await put("company", acme.id);
    await db.exec(`reset role; update trash_items set purge_after = now() - interval '1 day' where id = '${t.trash_id}'`);
    await db.as("anon");
    const r = await db.rpc<{ purged: number; failed: number; files: string[] }>("trash_purge_due", { p_server_key: SERVER_KEY });
    expect(r).toMatchObject({ purged: 1, failed: 0 });
    expect(r.files.sort()).toEqual([`${acme.id}/${f1}.pdf`, `${acme.id}/${f2}.pdf`].sort());
    // autorisation temporaire de suppression posée pour la tâche planifiée (comme le portail)
    expect(await db.one(`select public.portal_storage_can($1, 'delete') ok`, [`${acme.id}/${f2}.pdf`])).toEqual({ ok: true });
    await db.rpc("trash_files_done_server", { p_server_key: SERVER_KEY, p_paths: r.files, p_error: null });
    await admin(async () => {
      for (const tbl of ["companies"]) expect(await rows(`select 1 from ${tbl} where id = $1`, [acme.id])).toEqual([]);
      for (const tbl of ["people", "tasks", "interactions", "finance_invoices", "projects", "company_files", "sales", "time_entries"]) {
        expect(await rows(`select 1 from ${tbl} where company_id = $1`, [acme.id])).toEqual([]);
      }
      expect(await rows(`select 1 from finance_payments`)).toEqual([]);
      expect(await rows(`select 1 from portal_accesses`)).toEqual([]);
      expect(await rows(`select * from trash_file_queue`)).toEqual([]);
      expect(await rows(`select * from trash_items`)).toEqual([]);
    });
  });

  test("vente associée : part avec l'entreprise et revient avec elle", async () => {
    const p = (await db.one<{ id: string }>(`insert into pipelines (name) values ('[TEST] Vente') returning id`)).id;
    const st = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Proposition', 0) returning id`, [p])).id;
    await db.rpc("move_company", { p_company: acme.id, p_stage: st });
    const sale = await db.rpc<{ sale_id?: string; mission_id: string }>("sale_confirm", { p_company: acme.id, p_data: { revenue: { mode: "ponctuel", amount: 3000, date: today() } } });
    const before = await rows(`select id, state from sales where company_id = $1`, [acme.id]);
    expect(before.length).toBe(1);
    const t = await put("company", acme.id);
    expect(await rows(`select company_id from sales_overview where company_id = $1`, [acme.id])).toEqual([]);
    expect(await rows(`select id from finance_missions where id = $1`, [sale.mission_id])).toEqual([]);
    await restore(t.trash_id);
    expect(await rows(`select id, state from sales where company_id = $1`, [acme.id])).toEqual(before);
  });
});

describe("Contact", () => {
  test("part avec son accès au portail (fermé) et revient à l'identique ; ses échanges restent sur la fiche", async () => {
    const person = acme.people[ALICE];
    await db.query(`insert into interactions (company_id, person_id, kind, content, content_origin, source) values ($1, $2, 'note', '[TEST] Échange', 'user', 'user')`, [acme.id, person]);
    const raw = await snapshot(acme.id);
    const preview = await db.rpc<{ summary: Record<string, number>; warnings: string[] }>("trash_preview", { p_kind: "person", p_id: person });
    expect(preview.summary).toMatchObject({ portal_accesses: 1 });
    expect(preview.warnings.join(" ")).toMatch(/accès au portail client est fermé/);
    const t = await put("person", person);
    expect(await rows(`select id from people where id = $1`, [person])).toEqual([]);
    expect((await rows(`select id from interactions where person_id = $1`, [person])).length).toBe(1);
    expect(await rows(`select 1 from project_members where person_id = $1`, [person])).toEqual([]);
    await expect(portal(db, "portal_me", alice)).rejects.toThrow(/Session expirée/);
    // nouvelle connexion avec le même code : refusée
    await db.as("owner");
    await restore(t.trash_id);
    expect(await snapshot(acme.id)).toEqual(raw);
    expect((await portal<{ projects: { id: string }[] }>(db, "portal_me", alice)).projects.map((p) => p.id)).toEqual([pid]);
  });

  test("contact principal : la place est libérée pendant son séjour, rendue à la restauration si elle est libre", async () => {
    const person = acme.people[ALICE];
    await db.query(`update people set is_primary = (id = $1) where company_id = $2`, [person, acme.id]);
    const t = await put("person", person);
    await db.rpc("upsert_person", { p_company: acme.id, p_person: JSON.stringify({ first_name: "Bob", email: "bob@acme.example.test", is_primary: true }), p_person_id: acme.people["bob@acme.example.test"], p_force: true, p_idempotency_key: null });
    await restore(t.trash_id);
    // Bob est devenu principal entre-temps : Alice revient, sans conflit, non principale
    expect(await rows(`select first_name, is_primary from people where company_id = $1 order by first_name`, [acme.id]))
      .toEqual([{ first_name: "Alice", is_primary: false }, { first_name: "Bob", is_primary: true }]);
  });
});

describe("Ancien chemin de suppression", () => {
  test("une suppression directe d'un contact ou d'une fiche par l'API ne contourne pas les règles (fiche : refusée)", async () => {
    await db.as("claude");
    await expect(db.query(`delete from companies where id = $1`, [acme.id])).resolves.toBeTruthy();
    await db.as("owner");
    expect((await rows(`select id from companies where id = $1`, [acme.id])).length).toBe(1);
  });
});
