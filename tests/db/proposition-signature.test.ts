// Signature : Make ou « Marquer comme signée », un seul résultat, une seule fois. L'ancienne version signée fait foi.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
let db: Db;
let acme: string;
let dossier: string;

const payload = (price = 250000) => ({ client: { company_name: "Acme" }, quote: { start_date: "2026-12-01", duration_months: 3, lines: [{ label: "Growth", quantity: 3, unit: "mois", unit_price_cents: price, vat_rate: 20, recurrence: "monthly" }] } });
async function version(key: string, price?: number) {
  const v = await db.rpc<{ id: string; version: number; quote_id: string }>("proposal_generate", { p_id: dossier, p_key: key, p_feedback: null, p_quote: JSON.stringify(payload(price)), p_total_cents: 750000 });
  const o = await db.rpc<{ id: string; version: number }>("generator_version_open", { p_id: dossier });
  await db.exec(`reset role;`);
  const f = await db.one<{ id: string }>(`insert into company_files (company_id, display_name, mime_type, size_bytes, storage_path, status) values ($1, 'P.pdf', 'application/pdf', 10, $2, 'ready') returning id`, [acme, `${acme}/${crypto.randomUUID()}.pdf`]);
  await db.as("owner");
  await db.rpc("generator_version_attach", { p_version: o.id, p_file: f.id });
  await db.rpc("generator_version_ready", { p_id: dossier, p_version: o.version });
  const { request_id } = await db.one<{ request_id: string }>(`select request_id from quotes where id = $1`, [v.quote_id]);
  return { ...v, request_id };
}
async function makeReturn(event: string, request: string, extra: Record<string, unknown> = {}) {
  await db.as("anon");
  const r = await db.rpc<string>("make_return", { p_server_key: KEY, p_outcome: "valid", p_event: event, p_request_id: request, ...extra });
  await db.as("owner");
  return r;
}
const signed = () => db.query<{ version: number; latest_version: number; signed_via: string; signed_on: string }>(`select version, latest_version, signed_via, signed_on::text from proposal_signed`).then((r) => r.rows);
const mark = (id: string) => db.rpc<{ already: boolean; company_id: string }>("proposal_mark_signed", { p_version: id });

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
  acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
  dossier = (await db.rpc<{ id: string }>("generator_start", { p_kind: "proposal", p_company: acme, p_project: null, p_key: "cle-acme-1" })).id;
});

describe("signature", () => {
  test("retour « signé » de Make : proposition signée une seule fois, même rejoué", async () => {
    const v = await version("gen-0000001");
    await db.rpc("generator_validate", { p_version: v.id });
    expect(await makeReturn("quote.signed", v.request_id, { p_signed_on: "2026-11-25", p_quote_number: "D-41" })).toBe("recorded");
    expect(await makeReturn("quote.signed", v.request_id, { p_signed_on: "2026-11-30" })).toBe("duplicate");
    expect(await signed()).toEqual([{ version: 1, latest_version: 1, signed_via: "make", signed_on: "2026-11-25" }]);
    // le second chemin après le premier : rien de plus
    expect(await mark(v.id)).toEqual({ already: true, company_id: acme });
    expect(await signed()).toHaveLength(1);
    expect((await db.one<{ via: string }>(`select signed_via via from proposal_versions where version_id = $1`, [v.id])).via).toBe("make");
  });

  test("« Marquer comme signée » : sur une version validée, une seule fois ; le retour de Make ensuite ne change rien", async () => {
    const v = await version("gen-0000001");
    await expect(mark(v.id)).rejects.toThrow(/Validez la version/);
    await db.rpc("generator_validate", { p_version: v.id });
    expect(await mark(v.id)).toEqual({ already: false, company_id: acme });
    expect(await mark(v.id)).toEqual({ already: true, company_id: acme });
    const first = await signed();
    expect(first).toMatchObject([{ version: 1, signed_via: "manual" }]);
    expect(await makeReturn("quote.signed", v.request_id, { p_signed_on: "2026-12-24" })).toBe("recorded");
    expect(await signed()).toEqual(first);
    expect((await db.one<{ status: string }>(`select status from quotes where id = $1`, [v.quote_id])).status).toBe("signed");
  });

  test("signature d'une ancienne version : elle fait foi, la plus récente est annulée et ses retours sont ignorés", async () => {
    const v1 = await version("gen-0000001");
    await db.rpc("generator_validate", { p_version: v1.id });
    const v2 = await version("gen-0000002", 300000);
    expect(v2.quote_id).not.toBe(v1.quote_id);
    expect(await makeReturn("quote.signed", v1.request_id)).toBe("recorded");
    expect(await signed()).toMatchObject([{ version: 1, latest_version: 2 }]);
    expect((await db.one<{ status: string }>(`select status from quotes where id = $1`, [v2.quote_id])).status).toBe("cancelled");
    expect(await makeReturn("quote.signed", v2.request_id)).toBe("ignored");
    await db.rpc("generator_validate", { p_version: v2.id });
    await expect(mark(v2.id)).rejects.toThrow(/La V1 de cette proposition est déjà signée/);
    expect(await signed()).toHaveLength(1);
  });

  test("devis partagé par deux versions : la plus récente est la version signée", async () => {
    const v1 = await version("gen-0000001");
    const v2 = await version("gen-0000002");
    expect(v2.quote_id).toBe(v1.quote_id);
    expect(await makeReturn("quote.signed", v1.request_id)).toBe("recorded");
    expect(await signed()).toMatchObject([{ version: 2, latest_version: 2 }]);
    // ce que le client a signé est figé, même sans validation préalable
    expect((await db.one<{ v: boolean }>(`select validated_at is not null v from generator_versions where id = $1`, [v2.id])).v).toBe(true);
  });

  test("signature pour un devis inconnu : journalisée et ignorée ; ni Claude ni un autre compte ne signent", async () => {
    expect(await makeReturn("quote.signed", crypto.randomUUID())).toBe("ignored");
    expect(await signed()).toEqual([]);
    const v = await version("gen-0000001");
    await db.rpc("generator_validate", { p_version: v.id });
    for (const who of ["claude", "stranger", "anon"] as const) {
      await db.as(who);
      await expect(mark(v.id)).rejects.toThrow(who === "anon" ? /permission denied/ : who === "claude" ? /impossible via Claude/ : /Accès refusé/);
      if (who !== "anon") expect((await db.query(`select 1 from proposal_signed`)).rows).toEqual([]);
    }
    await db.as("owner");
    expect(await signed()).toEqual([]);
  });
});
