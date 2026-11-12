// Corbeille, lot 1 : mécanisme commun (droits, clé serveur, passage planifié).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const SERVER_KEY = "test-server-key-0123456789abcdef0123456789";
let db: Db;

beforeEach(async () => {
  db = await createDb();
  await db.exec(`reset role; update appt_settings set server_key_hash = '${createHash("sha256").update(SERVER_KEY).digest("hex")}'`);
  await db.as("owner");
});

describe("Corbeille — droits", () => {
  test("le portail (anon) et un autre compte n'ont accès ni aux tables ni aux fonctions", async () => {
    await db.as("anon");
    await expect(db.query("select * from trash_items")).rejects.toThrow(/permission/);
    await expect(db.rpc("trash_put", { p_kind: "project", p_id: crypto.randomUUID() })).rejects.toThrow(/permission/);
    await expect(db.rpc("trash_restore", { p_trash: crypto.randomUUID() })).rejects.toThrow(/permission/);
    await expect(db.rpc("trash_purge", { p_trash: crypto.randomUUID() })).rejects.toThrow(/permission/);
    await db.as("stranger");
    expect((await db.query("select * from trash_items")).rows).toEqual([]);
    await expect(db.rpc("trash_put", { p_kind: "project", p_id: crypto.randomUUID() })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("trash_preview", { p_kind: "project", p_id: crypto.randomUUID() })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("trash_purge", { p_trash: crypto.randomUUID() })).rejects.toThrow(/Accès refusé/);
  });

  test("écriture directe dans la corbeille impossible hors des fonctions (aucune modification, pas de file de fichiers)", async () => {
    await expect(db.query(`update trash_items set purge_after = now()`)).rejects.toThrow(/permission/);
    await expect(db.query(`insert into trash_file_queue (path) values ('x/y.pdf')`)).rejects.toThrow(/permission/);
  });

  test("type inconnu refusé ; élément introuvable refusé", async () => {
    await expect(db.rpc("trash_put", { p_kind: "pipeline", p_id: crypto.randomUUID() })).rejects.toThrow(/inconnu/);
    await expect(db.rpc("trash_put", { p_kind: "project", p_id: crypto.randomUUID() })).rejects.toThrow(/introuvable|pas encore/);
  });

  test("restaurer un élément qui n'est plus dans la corbeille : aucune erreur, rien ne se passe (double clic)", async () => {
    expect(await db.rpc("trash_restore", { p_trash: crypto.randomUUID() })).toEqual({ restored: false, already: true });
  });

  test("Claude ne peut pas supprimer définitivement", async () => {
    await db.as("claude");
    await expect(db.rpc("trash_purge", { p_trash: crypto.randomUUID() })).rejects.toThrow(/Corbeille de l'application/);
  });
});

describe("Corbeille — purge planifiée", () => {
  test("clé serveur exigée ; sans élément échu, rien n'est purgé", async () => {
    await db.as("anon");
    await expect(db.rpc("trash_purge_due", { p_server_key: "mauvaise-cle-mauvaise-cle-mauvaise-cle", p_limit: 10 })).rejects.toThrow(/Accès refusé/);
    expect(await db.rpc("trash_purge_due", { p_server_key: SERVER_KEY, p_limit: 10 })).toEqual({ purged: 0, failed: 0, files: [] });
  });

  test("le passage « corbeille » est suivi avec les autres tâches planifiées", async () => {
    await db.as("anon");
    await db.rpc("job_report", { p_server_key: SERVER_KEY, p_job: "corbeille", p_ok: true, p_error: null, p_result: JSON.stringify({ purged: 0 }) });
    await db.as("owner");
    expect((await db.one<{ job: string }>(`select job from scheduled_jobs where job = 'corbeille'`)).job).toBe("corbeille");
    await db.as("anon");
    await expect(db.rpc("job_report", { p_server_key: SERVER_KEY, p_job: "inconnu", p_ok: true, p_error: null, p_result: null })).rejects.toThrow(/check/);
  });
});
