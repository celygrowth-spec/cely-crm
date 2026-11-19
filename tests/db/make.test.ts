// Connecteur Make : scénarios et journal réservés au propriétaire dans l'application ; retour de Make protégé par la
// clé serveur, idempotent et limité en débit.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
const REQ = "11111111-1111-4111-8111-111111111111";
let db: Db;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
});

const ret = (args: Record<string, unknown>) => db.rpc<string>("make_return", { p_server_key: KEY, ...args });
const calls = async () => {
  await db.as("owner");
  return (await db.query<{ direction: string; event: string; status: string; error: string | null }>(`select direction, event, status, error from make_calls order by id`)).rows;
};

describe("scénarios", () => {
  test("propriétaire : enregistre, relit, retire ; identifiant unique, adresse obligatoirement chiffrée", async () => {
    await db.query(`insert into make_scenarios (key, name, webhook_enc) values ('creer_le_devis', 'Créer le devis', 'v1.a.b.c')`);
    await expect(db.query(`insert into make_scenarios (key, name, webhook_enc) values ('creer_le_devis', 'Autre', 'v1.a.b.c')`)).rejects.toThrow(/unique/);
    await expect(db.query(`insert into make_scenarios (key, name, webhook_enc) values ('en_clair', 'En clair', 'https://hook.eu2.make.com/abcdefgh')`)).rejects.toThrow(/check constraint/);
    expect((await db.query(`select key from make_scenarios`)).rows).toEqual([{ key: "creer_le_devis" }]);
    await db.query(`delete from make_scenarios`);
    expect((await db.query(`select 1 from make_scenarios`)).rows).toEqual([]);
  });

  test("anonyme, autre compte et Claude : ni lecture ni écriture", async () => {
    await db.query(`insert into make_scenarios (key, name, webhook_enc) values ('creer_le_devis', 'Créer le devis', 'v1.a.b.c')`);
    await db.rpc("make_log_call", { p_scenario: "Créer le devis", p_event: "test", p_ok: true });
    await db.as("anon");
    await expect(db.query(`select * from make_scenarios`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from make_calls`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from make_returns`)).rejects.toThrow(/permission denied/);
    for (const who of ["stranger", "claude"] as const) {
      await db.as(who);
      expect((await db.query(`select * from make_scenarios`)).rows).toEqual([]);
      expect((await db.query(`select * from make_calls`)).rows).toEqual([]);
      await expect(db.query(`insert into make_scenarios (key, name, webhook_enc) values ('pirate', 'Pirate', 'v1.a.b.c')`)).rejects.toThrow(/row-level security/);
      await expect(db.query(`update make_scenarios set name = 'x'`)).resolves.toMatchObject({ affectedRows: 0 });
      await expect(db.query(`delete from make_scenarios`)).resolves.toMatchObject({ affectedRows: 0 });
      await expect(db.rpc("make_log_call", { p_scenario: "x", p_event: "test", p_ok: true })).rejects.toThrow(/Accès refusé|dans l'application/);
    }
  });

  test("le journal ne s'écrit que par les fonctions, et reste borné à 200 lignes", async () => {
    await expect(db.query(`insert into make_calls (direction, event, status) values ('out', 'test', 'ok')`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`delete from make_calls`)).rejects.toThrow(/permission denied/);
    for (let i = 0; i < 205; i++) await db.rpc("make_log_call", { p_scenario: "Créer le devis", p_event: "test", p_ok: i % 2 === 0, p_error: "Make est injoignable." });
    const rows = await calls();
    expect(rows).toHaveLength(200);
    expect(rows.at(-1)).toEqual({ direction: "out", event: "test", status: "ok", error: null });
    expect(rows.at(-2)).toEqual({ direction: "out", event: "test", status: "error", error: "Make est injoignable." });
  });
});

describe("retour de Make", () => {
  test("sans la clé serveur : refusé, quel que soit le rôle", async () => {
    for (const who of ["anon", "stranger", "owner"] as const) {
      await db.as(who);
      await expect(db.rpc("make_return", { p_server_key: "mauvaise-cle-mais-assez-longue-0123456789abcdef", p_outcome: "valid", p_event: "quote.created", p_request_id: REQ })).rejects.toThrow(/Accès refusé/);
    }
    expect(await calls()).toEqual([]);
  });

  // ces retours ne correspondent à aucun devis : enregistrés une fois, puis ignorés (les effets sur un devis
  // sont testés dans propositions.test.ts)
  test("un même retour reçu deux fois ne s'enregistre qu'une fois", async () => {
    await db.as("anon");
    const args = { p_outcome: "valid", p_event: "quote.created", p_request_id: REQ, p_quote_number: "D-2026-041", p_quote_url: "https://exemple.test/devis/41" };
    expect(await ret(args)).toBe("ignored");
    expect(await ret(args)).toBe("duplicate");
    expect(await ret({ ...args, p_event: "quote.signed", p_signed_on: "2026-11-25" })).toBe("ignored");
    await db.as("owner");
    expect((await db.query(`select event, quote_number, signed_on::text from make_returns order by received_at, event`)).rows).toEqual([
      { event: "quote.created", quote_number: "D-2026-041", signed_on: null },
      { event: "quote.signed", quote_number: "D-2026-041", signed_on: "2026-11-25" },
    ]);
    expect((await calls()).map((c) => c.status)).toEqual(["ignored", "duplicate", "ignored"]);
  });

  test("secret refusé ou contenu invalide : journalisé sans détail, rien d'enregistré", async () => {
    await db.as("anon");
    expect(await ret({ p_outcome: "refused" })).toBe("refused");
    expect(await ret({ p_outcome: "invalid" })).toBe("invalid");
    expect(await ret({ p_outcome: "valid", p_event: "quote.deleted", p_request_id: REQ })).toBe("invalid");
    expect(await ret({ p_outcome: "valid", p_event: "quote.created", p_request_id: null })).toBe("invalid");
    expect(await ret({ p_outcome: "valid", p_event: "quote.created", p_request_id: REQ, p_quote_url: "http://exemple.test/x" })).toBe("invalid");
    expect(await ret({ p_outcome: "valid", p_event: "quote.error", p_request_id: REQ, p_error: "Tiime a refusé le client" })).toBe("ignored");
    const rows = await calls();
    expect(rows.map((c) => c.status)).toEqual(["refused", "invalid", "invalid", "invalid", "invalid", "ignored"]);
    // le message de Make reste sur le retour ; le journal ne porte que nos propres libellés
    expect(rows.map((c) => c.error).join(" ")).not.toMatch(/Tiime/);
    expect((await db.query(`select count(*)::int as n from make_returns`)).rows).toEqual([{ n: 1 }]);
  });

  test("au-delà de 60 retours par minute : plus rien n'est écrit", async () => {
    await db.as("anon");
    for (let i = 0; i < 60; i++) expect(await ret({ p_outcome: "refused" })).toBe("refused");
    expect(await ret({ p_outcome: "refused" })).toBe("rate_limited");
    expect(await ret({ p_outcome: "valid", p_event: "quote.created", p_request_id: REQ })).toBe("rate_limited");
    expect(await calls()).toHaveLength(60);
    expect((await db.query(`select 1 from make_returns`)).rows).toEqual([]);
  });
});
