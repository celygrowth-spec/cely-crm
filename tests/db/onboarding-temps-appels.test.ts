// Audit, lot 7 : K09 (projet sur le temps et les appels), Q09 (chrono oublié), K10 (contenu des documents).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let co: string;
let other: string;
let pr: string;

beforeEach(async () => {
  db = await createDb();
  co = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Studio" }, p_people: [] })).id;
  other = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Autre" }, p_people: [] })).id;
  pr = (await db.one<{ id: string }>(`insert into projects (company_id, name, status) values ($1, 'Refonte', 'en_cours') returning id`, [co])).id;
});

describe("K09 — projet facultatif sur le temps et les appels", () => {
  test("chrono sur un projet de la fiche ; projet d'une autre fiche refusé ; totaux par client inchangés", async () => {
    const r = await db.rpc<{ status: string; running: { project_id: string; project_name: string } }>("time_start", { p_company: co, p_project: pr });
    expect(r.running).toMatchObject({ project_id: pr, project_name: "Refonte" });
    await db.rpc("time_stop", {});
    await expect(db.rpc("time_start", { p_company: other, p_project: pr })).rejects.toThrow(/autre fiche/);
    await db.query(`insert into time_entries (company_id, label, started_at, ended_at, source) values ($1, 'sans projet', now() - interval '2 hours', now() - interval '1 hour', 'manual')`, [co]);
    expect(await db.one(`select count(*)::int n, count(project_id)::int p from time_entries where company_id = $1`, [co])).toEqual({ n: 2, p: 1 });
  });

  test("appel rattaché à un projet de sa fiche ; détaché de la fiche, il perd son projet", async () => {
    await db.exec(`reset role; insert into fireflies_calls (account_id, fireflies_id, title) values ('c', 'ff-1', 'Point'); update fireflies_calls set company_id = '${co}', link_state = 'linked', link_source = 'manual';`);
    const call = (await db.one<{ id: string }>(`select id from fireflies_calls`)).id;
    await db.as("owner");
    await db.rpc("fireflies_set_project", { p_call: call, p_project: pr });
    await db.exec("reset role;"); // la vue est lue par les fonctions serveur (comme dans les autres tests Fireflies)
    expect(await db.one(`select project_id, project_name from fireflies_call_list where id = $1`, [call])).toEqual({ project_id: pr, project_name: "Refonte" });
    await db.exec(`reset role; update fireflies_calls set company_id = '${other}' where id = '${call}';`);
    expect(await db.one(`select project_id from fireflies_calls where id = $1`, [call])).toEqual({ project_id: null });
  });
});

describe("Q09 — un chrono oublié s'arrête toujours", () => {
  test("au-delà de 12 h : fin proposée (début + 8 h), confirmée et tracée ; même après 9 jours", async () => {
    await db.exec(`reset role; insert into time_entries (company_id, started_at, source) values ('${co}', now() - interval '9 days', 'timer');`);
    await db.as("owner");
    const r = await db.rpc<{ status: string; suggested: string; running: { started_at: string } }>("time_stop", {});
    expect(r.status).toBe("confirm_end");
    expect(Date.parse(r.suggested) - Date.parse(r.running.started_at)).toBe(8 * 3600_000);
    await expect(db.rpc("time_stop", { p_ended_at: new Date().toISOString() })).rejects.toThrow(/7 jours au plus/);
    const s = await db.rpc<{ status: string; stopped: { corrected_at: string | null } }>("time_stop", { p_ended_at: r.suggested });
    expect(s.status).toBe("stopped");
    expect(s.stopped.corrected_at).toBeTruthy();
    expect(await db.one(`select correction_note like 'Chrono oublié%' c from time_entries`)).toEqual({ c: true });
  });
});

describe("K10 — contenu des documents dans les sources de la préparation", () => {
  test("documents à lire, puis contenu lu avec statut (et ce qui n'a pas pu être lu)", async () => {
    await db.exec(`reset role;`);
    const f1 = (await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status, category) values ($1, 'x/p.pdf', 'Proposition.pdf', 'application/pdf', 10, 'ready', 'Proposition') returning id`, [co])).id;
    const f2 = (await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status, category) values ($1, 'x/s.pdf', 'Scan.pdf', 'application/pdf', 10, 'ready', 'Contrat') returning id`, [co])).id;
    await db.query(`insert into project_onboarding (project_id) values ($1) on conflict do nothing`, [pr]).catch(() => undefined);
    await db.as("owner");
    await db.rpc("onboarding_ensure", { p_project: pr }).catch(() => undefined);
    const todo = await db.rpc<{ id: string }[]>("onboarding_files_to_read", { p_project: pr });
    expect(todo.map((t) => t.id).sort()).toEqual([f1, f2].sort());
    await db.query(`insert into company_file_texts (file_id, status, text, chars) values ($1, 'ok', 'Livraison en 6 semaines', 23), ($2, 'empty', null, 0)`, [f1, f2]);
    expect(await db.rpc("onboarding_files_to_read", { p_project: pr })).toEqual([]);
    const docs = await db.rpc<{ nom: string; lecture: string; texte: string | null }[]>("onboarding_documents", { p_project: pr });
    expect(docs.map((d) => [d.nom, d.lecture, d.texte])).toEqual(expect.arrayContaining([["Proposition.pdf", "ok", "Livraison en 6 semaines"], ["Scan.pdf", "empty", null]]));
  });
});
