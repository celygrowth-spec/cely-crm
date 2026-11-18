// « Valider le diagnostic » : ajout pur. Réservé au propriétaire dans l'application, sur une version reçue, sans
// effet sur le reste du parcours (la révision reste possible).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let dossier: string;
const questions = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ question: `Question ${i + 1}` })));

async function ready() {
  await db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions });
  await db.query(`update diagnostic_questions set dont_know = true where diagnostic_id = $1`, [dossier]).catch(async () => {
    for (const q of (await db.query<{ id: string }>(`select id from diagnostic_questions where diagnostic_id = $1`, [dossier])).rows)
      await db.rpc("diagnostic_save_answer", { p_question: q.id, p_answer: "", p_dont_know: true });
  });
  await db.rpc("diagnostic_submit_answers", { p_id: dossier });
  const v = await db.rpc<{ id: string; version: number; company_id: string }>("diagnostic_version_open", { p_id: dossier });
  await db.exec(`reset role;`);
  const f = await db.one<{ id: string }>(`insert into company_files (company_id, display_name, mime_type, size_bytes, storage_path, status) values ($1, 'Diagnostic.pdf', 'application/pdf', 10, $2, 'ready') returning id`, [v.company_id, `${v.company_id}/${crypto.randomUUID()}.pdf`]);
  await db.as("owner");
  await db.rpc("diagnostic_version_attach", { p_version: v.id, p_file: f.id });
  await db.rpc("diagnostic_version_ready", { p_id: dossier, p_version: v.version });
  return v.version;
}

beforeEach(async () => {
  db = await createDb();
  const acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
  dossier = await db.rpc<string>("diagnostic_start", { p_company: acme, p_key: "cle-acme-1" });
});

describe("validation du diagnostic", () => {
  test("une version reçue se valide une fois ; le dossier et la révision ne changent pas", async () => {
    await expect(db.rpc("diagnostic_validate", { p_id: dossier, p_version: 1 })).rejects.toThrow(/Version introuvable/);
    const version = await ready();
    const at = await db.rpc<string>("diagnostic_validate", { p_id: dossier, p_version: version });
    expect(await db.rpc("diagnostic_validate", { p_id: dossier, p_version: version })).toEqual(at);
    expect((await db.one<{ status: string }>(`select status from diagnostics where id = $1`, [dossier])).status).toBe("version_ready");
    expect(await db.rpc("diagnostic_request_revision", { p_id: dossier, p_version: version, p_feedback: "Plus court" })).toBe("revision_requested");
  });

  test("une version en cours de dépôt ne se valide pas ; ni Claude, ni un autre compte, ni un anonyme ne valident", async () => {
    const version = await ready();
    for (const who of ["claude", "stranger", "anon"] as const) {
      await db.as(who);
      await expect(db.rpc("diagnostic_validate", { p_id: dossier, p_version: version })).rejects.toThrow(who === "anon" ? /permission denied/ : who === "claude" ? /impossible via Claude/ : /Accès refusé/);
    }
    await db.as("owner");
    await db.rpc("diagnostic_request_revision", { p_id: dossier, p_version: version, p_feedback: "Plus court" });
    await db.rpc("diagnostic_version_open", { p_id: dossier });
    await expect(db.rpc("diagnostic_validate", { p_id: dossier, p_version: version + 1 })).rejects.toThrow(/pas encore reçue/);
  });
});
