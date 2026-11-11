// Audit C14 : ce qui est accessible sans connexion. Toute fonction ouverte au rôle anonyme exige la clé serveur
// (p_server_key), sauf les deux contrôles utilisés par les politiques Storage du portail ; aucune table ni vue n'est
// lisible sans connexion. Une nouvelle fonction est fermée par défaut (droits par défaut du schéma).
import { describe, expect, test } from "vitest";
import { createDb } from "./harness";

describe("C14 — accès sans connexion", () => {
  test("fonctions anonymes : toutes protégées par la clé serveur ; aucune table lisible", async () => {
    const db = await createDb();
    await db.exec("reset role");
    const fns = (await db.query<{ name: string; args: string }>(`select p.proname name, pg_get_function_identity_arguments(p.oid) args
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute')`)).rows;
    const unprotected = fns.filter((f) => !/\bp_server_key\b/.test(f.args)).map((f) => f.name).sort();
    expect(unprotected).toEqual(["portal_storage_can", "portal_storage_can_upload"]);
    const tables = (await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','v','m') and has_table_privilege('anon', c.oid, 'select')`)).rows;
    expect(tables).toEqual([]);
  });

  test("une fonction créée sans droits explicites n'est pas exécutable par un visiteur", async () => {
    const db = await createDb();
    await db.exec(`reset role; create function public.zz_nouvelle() returns int language sql as 'select 1';`);
    expect(await db.one(`select has_function_privilege('anon', 'public.zz_nouvelle()', 'execute') a`)).toEqual({ a: false });
  });

  test("une fiche qui porte du temps passé ne se supprime pas en silence", async () => {
    const db = await createDb();
    const co = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Acme" }, p_people: [] })).id;
    await db.exec(`reset role; insert into time_entries (company_id, started_at, ended_at, source) values ('${co}', now() - interval '1 hour', now(), 'manual');`);
    await expect(db.exec(`delete from companies where id = '${co}'`)).rejects.toThrow(/foreign key|violates/);
  });
});
