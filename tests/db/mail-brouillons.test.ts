// Brouillons d'email : version incrémentée à chaque enregistrement, conflit détecté sans rien écraser
// (même brouillon ouvert dans deux onglets), contenu mis en forme conservé.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let company: string;
const ID = "11111111-1111-4111-8111-111111111111";
beforeEach(async () => {
  db = await createDb();
  company = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [], p_force: true })).id;
});
type Row = { conflict: boolean; draft_version: number; subject: string; body_html: string | null; current?: { subject: string; draft_version: number } };
const save = (p: Record<string, unknown>, expected: number | null) =>
  db.rpc<Row>("mail_save_draft", { p_id: ID, p: { company_id: company, to: ["paul@acme.io"], subject: "Bonjour", body: "Texte", ...p }, p_expected_version: expected });

describe("brouillons", () => {
  test("chaque enregistrement incrémente la version ; le HTML est conservé", async () => {
    const a = await save({ html: "<p><strong>Bonjour</strong></p>" }, null);
    expect([a.conflict, a.draft_version, a.body_html]).toEqual([false, 1, "<p><strong>Bonjour</strong></p>"]);
    expect((await save({ subject: "Bonjour 2" }, 1)).draft_version).toBe(2);
  });

  test("deux onglets : l'enregistrement fondé sur une version périmée est refusé, rien n'est écrasé", async () => {
    await save({ subject: "Version A" }, null); // v1
    await save({ subject: "Onglet 1" }, 1); // v2
    const stale = await save({ subject: "Onglet 2" }, 1); // l'onglet 2 avait lu la v1
    expect(stale.conflict).toBe(true);
    expect(stale.current).toMatchObject({ subject: "Onglet 1", draft_version: 2 });
    expect((await db.one<{ subject: string }>(`select subject from mail_messages where id = $1`, [ID])).subject).toBe("Onglet 1");
    // « garder ma version » : écrasement volontaire
    expect(await save({ subject: "Onglet 2" }, null)).toMatchObject({ conflict: false, subject: "Onglet 2", draft_version: 3 });
  });

  test("un message envoyé n'est plus modifiable par un brouillon resté ouvert", async () => {
    await save({}, null);
    await db.query("reset role");
    await db.query(`update mail_messages set status = 'pending' where id = $1`, [ID]);
    await db.as("owner");
    await expect(save({ subject: "Trop tard" }, 1)).rejects.toThrow(/plus un brouillon/);
  });
});
