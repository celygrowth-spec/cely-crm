// Proposition : la version et son devis naissent ensemble ; jamais deux devis pour une version ; l'appel à Make ne se
// réserve qu'une fois et reste relançable ; les retours de Make s'appliquent une seule fois et ne font jamais reculer l'état.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
let db: Db;
let acme: string;
let dossier: string;

const payload = (price = 250000) => ({ proposal: { id: dossier }, client: { company_name: "Acme" }, signatory: { first_name: "Ada", last_name: "Martin" }, quote: { currency: "EUR", lines: [{ label: "Growth Part-Time", quantity: 3, unit: "mois", unit_price_cents: price, vat_rate: 20, recurrence: "monthly" }], total_ht_cents: 3 * price } });
const generate = (key: string, quote: unknown = payload(), id = dossier) =>
  db.rpc<{ id: string; version: number; created: boolean; quote_id: string; quote_created: boolean }>("proposal_generate", { p_id: id, p_key: key, p_feedback: null, p_quote: JSON.stringify(quote), p_total_cents: 750000 });
const quote = (id: string) => db.one<{ status: string; number: string | null; url: string | null; request_id: string; error: string | null; signed_on: string | null }>(`select status, number, url, request_id, error, signed_on::text from quotes where id = $1`, [id]);
const claim = (id: string) => db.rpc<{ request_id: string; payload: unknown } | null>("proposal_quote_claim", { p_quote: id });
async function makeReturn(event: string, request: string, extra: Record<string, unknown> = {}) {
  await db.as("anon");
  const r = await db.rpc<string>("make_return", { p_server_key: KEY, p_outcome: "valid", p_event: event, p_request_id: request, ...extra });
  await db.as("owner");
  return r;
}
async function slidesReady(id = dossier) {
  const v = await db.rpc<{ id: string; version: number }>("generator_version_open", { p_id: id });
  await db.exec(`reset role;`);
  const f = await db.one<{ id: string }>(`insert into company_files (company_id, display_name, mime_type, size_bytes, storage_path, status) values ($1, 'Proposition.pdf', 'application/pdf', 10, $2, 'ready') returning id`, [acme, `${acme}/${crypto.randomUUID()}.pdf`]);
  await db.as("owner");
  await db.rpc("generator_version_attach", { p_version: v.id, p_file: f.id });
  await db.rpc("generator_version_ready", { p_id: id, p_version: v.version });
}

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
  acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
  dossier = (await db.rpc<{ id: string }>("generator_start", { p_kind: "proposal", p_company: acme, p_project: null, p_key: "cle-acme-1" })).id;
});

describe("génération", () => {
  test("la version et son devis naissent ensemble ; un double clic ne crée ni seconde version ni second devis", async () => {
    const a = await generate("gen-0000001");
    expect(a).toMatchObject({ version: 1, created: true, quote_created: true });
    expect(await generate("gen-0000001")).toMatchObject({ id: a.id, created: false, quote_id: a.quote_id, quote_created: false });
    expect(await generate("gen-0000002")).toMatchObject({ id: a.id, created: false, quote_id: a.quote_id });
    expect((await db.one<{ n: number }>(`select count(*)::int n from quotes`)).n).toBe(1);
    expect((await db.one<{ n: number }>(`select count(*)::int n from generator_versions`)).n).toBe(1);
    expect((await quote(a.quote_id)).status).toBe("to_send");
  });

  test("un devis sans ligne est refusé et aucune version n'est créée", async () => {
    await expect(generate("gen-0000001", { quote: { lines: [] } })).rejects.toThrow(/aucune ligne/);
    expect((await db.one<{ n: number }>(`select count(*)::int n from generator_versions`)).n).toBe(0);
  });

  test("nouvelle version : devis inchangé repris tel quel, devis modifié recréé (l'ancien garde sa version)", async () => {
    const v1 = await generate("gen-0000001");
    await slidesReady();
    const v2 = await generate("gen-0000002");
    expect(v2).toMatchObject({ version: 2, created: true, quote_id: v1.quote_id, quote_created: false });
    await slidesReady();
    const v3 = await generate("gen-0000003", payload(300000));
    expect(v3).toMatchObject({ version: 3, quote_created: true });
    expect(v3.quote_id).not.toBe(v1.quote_id);
    expect((await quote(v1.quote_id)).status).toBe("to_send");
    // jamais deux devis pour une même version
    await db.exec(`reset role;`);
    await expect(db.query(`insert into proposal_versions (version_id, quote_id) values ($1, $2)`, [v3.id, v1.quote_id])).rejects.toThrow(/duplicate key/);
  });

  test("Claude, un autre compte et un anonyme ne génèrent pas, ne lisent pas les devis et n'appellent pas Make", async () => {
    const v = await generate("gen-0000001");
    for (const who of ["claude", "stranger", "anon"] as const) {
      await db.as(who);
      const refused = who === "anon" ? /permission denied/ : who === "claude" ? /impossible via Claude/ : /Accès refusé/;
      await expect(generate(`gen-${who}-0001`)).rejects.toThrow(refused);
      await expect(claim(v.quote_id)).rejects.toThrow(refused);
      await expect(db.rpc("proposal_quote_result", { p_quote: v.quote_id, p_ok: false, p_error: "x" })).rejects.toThrow(refused);
      if (who !== "anon") {
        expect((await db.query(`select 1 from quotes`)).rows).toEqual([]);
        expect((await db.query(`select 1 from proposal_versions`)).rows).toEqual([]);
      } else await expect(db.query(`select 1 from quotes`)).rejects.toThrow(/permission denied/);
    }
    await db.as("owner");
    await expect(db.query(`update quotes set status = 'signed'`)).rejects.toThrow(/permission denied/);
  });
});

describe("appel à Make", () => {
  test("l'envoi ne se réserve qu'une fois ; Make injoignable : « à relancer », puis relance possible", async () => {
    const v = await generate("gen-0000001");
    const first = await claim(v.quote_id);
    expect(first?.payload).toMatchObject({ client: { company_name: "Acme" } });
    expect(await claim(v.quote_id)).toBeNull();
    await db.rpc("proposal_quote_result", { p_quote: v.quote_id, p_ok: false, p_error: "Make est injoignable." });
    expect(await quote(v.quote_id)).toMatchObject({ status: "to_retry", error: "Make est injoignable." });
    const again = await claim(v.quote_id);
    // la relance réutilise la même demande : Make peut reconnaître un doublon
    expect(again?.request_id).toBe(first?.request_id);
    await db.rpc("proposal_quote_result", { p_quote: v.quote_id, p_ok: true, p_error: null });
    expect((await quote(v.quote_id)).status).toBe("requested");
    expect(await claim(v.quote_id)).toBeNull();
    // dix minutes sans retour : relançable
    await db.exec(`reset role; update quotes set requested_at = now() - interval '11 minutes';`);
    await db.as("owner");
    expect(await claim(v.quote_id)).not.toBeNull();
  });

  test("slides en échec et devis réussi (ou l'inverse) : chacun garde son état", async () => {
    const v = await generate("gen-0000001");
    const c = await claim(v.quote_id);
    await db.rpc("generator_report_failure", { p_id: dossier, p_message: "Modèle illisible" });
    expect(await makeReturn("quote.created", c!.request_id, { p_quote_number: "D-1", p_quote_url: "https://exemple.test/d/1" })).toBe("recorded");
    expect((await db.one<{ slides_status: string }>(`select slides_status from generator_versions where id = $1`, [v.id])).slides_status).toBe("failed");
    expect(await quote(v.quote_id)).toMatchObject({ status: "created", number: "D-1" });
    // relancer les slides ne touche pas au devis et n'en crée pas d'autre
    await db.rpc("generator_retry_slides", { p_version: v.id });
    await slidesReady();
    expect((await db.one<{ n: number }>(`select count(*)::int n from quotes`)).n).toBe(1);
    expect((await quote(v.quote_id)).status).toBe("created");
  });
});

describe("retours de Make", () => {
  test("créé, envoyé, signé : numéro et lien enregistrés ; un retour rejoué ou arrivé en retard ne change rien", async () => {
    const v = await generate("gen-0000001");
    const { request_id } = (await claim(v.quote_id))!;
    expect(await makeReturn("quote.created", request_id, { p_quote_number: "D-2026-041", p_quote_url: "https://exemple.test/d/41" })).toBe("recorded");
    expect(await makeReturn("quote.created", request_id, { p_quote_number: "D-AUTRE" })).toBe("duplicate");
    expect(await quote(v.quote_id)).toMatchObject({ status: "created", number: "D-2026-041", url: "https://exemple.test/d/41" });
    expect(await makeReturn("quote.signed", request_id, { p_signed_on: "2026-11-25" })).toBe("recorded");
    // « envoyé » arrivé après « signé » : enregistré, sans faire reculer le devis
    expect(await makeReturn("quote.sent", request_id)).toBe("recorded");
    expect(await quote(v.quote_id)).toMatchObject({ status: "signed", number: "D-2026-041", signed_on: "2026-11-25" });
    expect(await makeReturn("quote.error", request_id, { p_error: "Erreur tardive" })).toBe("recorded");
    expect((await quote(v.quote_id)).status).toBe("signed");
  });

  test("erreur de Make : devis en erreur avec la raison, relançable", async () => {
    const v = await generate("gen-0000001");
    const { request_id } = (await claim(v.quote_id))!;
    expect(await makeReturn("quote.error", request_id, { p_error: "Client introuvable dans Tiime" })).toBe("recorded");
    expect(await quote(v.quote_id)).toMatchObject({ status: "error", error: "Client introuvable dans Tiime" });
    expect(await claim(v.quote_id)).not.toBeNull();
  });

  test("devis inconnu ou annulé : journalisé et ignoré", async () => {
    expect(await makeReturn("quote.signed", crypto.randomUUID())).toBe("ignored");
    const v1 = await generate("gen-0000001");
    const { request_id } = (await claim(v1.quote_id))!;
    await db.exec(`reset role; update quotes set status = 'cancelled' where id = '${v1.quote_id}';`);
    await db.as("owner");
    expect(await makeReturn("quote.signed", request_id)).toBe("ignored");
    expect((await quote(v1.quote_id)).status).toBe("cancelled");
    const log = (await db.query<{ status: string; error: string | null }>(`select status, error from make_calls where direction = 'in' order by id`)).rows;
    expect(log).toEqual([{ status: "ignored", error: "Devis inconnu ou annulé." }, { status: "ignored", error: "Devis inconnu ou annulé." }]);
  });
});
