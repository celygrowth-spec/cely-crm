// Espace Connecteurs : la table des vérifications est réservée au propriétaire. Ni le portail
// (anon), ni un autre compte, ni Claude (jeton OAuth) ne la lisent ou ne l'écrivent.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

describe("connector_checks", () => {
  test("propriétaire : écrit et relit ; un seul enregistrement par connecteur", async () => {
    await db.as("owner");
    await db.query(`insert into connector_checks (key, ok, message) values ('fireflies', false, 'Fireflies est injoignable.')`);
    await db.query(`insert into connector_checks (key, ok, message) values ('fireflies', true, 'Clé acceptée.') on conflict (key) do update set ok = excluded.ok, message = excluded.message, checked_at = now()`);
    expect((await db.query<{ ok: boolean }>(`select ok from connector_checks`)).rows).toEqual([{ ok: true }]);
    await expect(db.query(`insert into connector_checks (key, ok) values ('inconnu', true)`)).rejects.toThrow(/check constraint/);
  });

  test("portail (anon), autre compte et Claude : aucun accès", async () => {
    await db.as("owner");
    await db.query(`insert into connector_checks (key, ok, message) values ('gmail', true, 'ok')`);
    await db.as("anon");
    await expect(db.query(`select * from connector_checks`)).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select * from connector_checks`)).rows).toEqual([]);
    await expect(db.query(`insert into connector_checks (key, ok) values ('claude_mcp', true)`)).rejects.toThrow(/row-level security/);
    await db.as("claude");
    await expect(db.query(`update connector_checks set ok = false where key = 'gmail'`)).resolves.toMatchObject({ affectedRows: 0 });
    await expect(db.query(`insert into connector_checks (key, ok) values ('claude_mcp', true)`)).rejects.toThrow(/row-level security/);
  });
});
