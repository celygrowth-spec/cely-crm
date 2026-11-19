// Vue du parcours client : une ligne par fiche concernée, états lus dans les documents, droits de l'appelant.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let acme: string;
const journey = (id = acme) => db.one<Record<string, unknown> | undefined>(`select * from company_journey where company_id = $1`, [id]);

beforeEach(async () => {
  db = await createDb();
  acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
});

describe("company_journey", () => {
  test("une fiche sans appel ni document n'y figure pas ; un appel rattaché l'y fait entrer", async () => {
    expect(await journey()).toBeUndefined();
    await db.exec(`reset role;`);
    const c = await db.one<{ id: string }>(`insert into fireflies_calls (account_id, fireflies_id, title, occurred_at) values ('c', 'm1', 'Appel', '2026-11-12T09:00:00Z') returning id`);
    await db.query(`update fireflies_calls set link_state = 'linked', company_id = $1 where id = $2`, [acme, c.id]);
    await db.as("owner");
    expect(await journey()).toMatchObject({ deal_status: "open", diagnostic_id: null, proposal_id: null });
    expect(new Date(String((await journey())!.last_call_at)).toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });

  test("diagnostic validé, proposition (dernière version), signature", async () => {
    const d = await db.rpc<string>("diagnostic_start", { p_company: acme, p_key: "cle-acme-1" });
    await db.exec(`reset role; insert into diagnostic_versions (diagnostic_id, version, status, ready_at, validated_at) values ('${d}', 1, 'ready', now(), now());`);
    await db.as("owner");
    expect(await journey()).toMatchObject({ diagnostic_id: d, proposal_id: null });
    expect((await journey())!.diagnostic_validated_at).not.toBeNull();
    const g = (await db.rpc<{ id: string }>("generator_start", { p_kind: "proposal", p_company: acme, p_project: null, p_key: "cle-prop-1" })).id;
    expect(await journey()).toMatchObject({ proposal_id: g, proposal_version: null, proposal_signed_at: null });
    const v = await db.rpc<{ id: string }>("proposal_generate", { p_id: g, p_key: "gen-0000001", p_feedback: null, p_quote: JSON.stringify({ quote: { lines: [{ label: "x" }] } }), p_total_cents: 100 });
    expect(await journey()).toMatchObject({ proposal_version: 1, proposal_slides: "pending", proposal_sent_at: null });
    await db.exec(`reset role; update generator_versions set slides_status = 'ready', ready_at = now(), validated_at = now() where id = '${v.id}';`);
    await db.as("owner");
    await db.rpc("proposal_mark_signed", { p_version: v.id });
    expect((await journey())!.proposal_signed_at).not.toBeNull();
  });

  test("fiche archivée ou fusionnée : absente ; anonyme refusé, autre compte et Claude ne voient ni devis ni appels", async () => {
    await db.rpc("diagnostic_start", { p_company: acme, p_key: "cle-acme-1" });
    expect(await journey()).toBeDefined();
    await db.as("anon");
    await expect(db.query(`select 1 from company_journey`)).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select 1 from company_journey`)).rows).toEqual([]);
    await db.exec(`reset role; update companies set archived_at = now() where id = '${acme}';`);
    await db.as("owner");
    expect(await journey()).toBeUndefined();
  });
});
