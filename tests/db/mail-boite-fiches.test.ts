// Mail, lot M05 : lien entre la boîte et les fiches. Vraies migrations, données fictives en example.test.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "test-server-key-0123456789abcdef0123456789";
let db: Db;
let account: string;
let acme: string;
let beta: string;

const admin = async <T>(sql: string, p?: unknown[]) => { await db.exec(`reset role;`); return db.one<T>(sql, p); };
const n = async (sql: string, p?: unknown[]) => (await admin<{ n: number }>(sql, p)).n;
type Match = { email: string; person: { name: string | null; title: string | null }; company: { id: string; name: string }; pipeline: string | null; stage: string | null; next_action: { title: string; due_date: string } | null };
const context = async (emails: string[], who: "owner" | "stranger" = "owner") => { await db.as(who); return db.rpc<Match[]>("mailbox_crm_context", { p_emails: emails }); };
const record = async (over: Record<string, unknown> = {}) => {
  await db.as("anon");
  return db.rpc<{ recorded: boolean; reason?: string; company_id?: string }>("mailbox_record_sent", { p_server_key: KEY, p_account: account,
    p: { provider_message_id: "g-1", provider_thread_id: "t-1", rfc_message_id: "<g1@example.test>", to: ["Paul@Acme.example.test"], cc: [], subject: "Proposition", text: "Bonjour Paul", ...over } });
};

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
  await db.exec(`reset role;`);
  account = (await db.one<{ id: string }>(`insert into mail_accounts (email, scopes, status, is_default) values ('moi@example.test', '{}', 'connected', true) returning id`)).id;
  await db.as("owner");
  acme = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Acme" }, p_people: [{ first_name: "Paul", last_name: "Martin", title: "Gérant", email: "paul@acme.example.test" }, { first_name: "Léa", email: "lea@acme.example.test" }] })).id;
  beta = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Beta" }, p_people: [{ first_name: "Nina", email: "nina@beta.example.test" }] })).id;
});

describe("fiches correspondant aux adresses d'un fil", () => {
  test("entreprise, personne, étape de pipeline et prochaine action", async () => {
    await db.exec(`reset role;`);
    const pipeline = (await db.one<{ id: string }>(`insert into pipelines (name) values ('[TEST] Ventes') returning id`)).id;
    const stage = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name) values ($1, 'Proposition envoyée') returning id`, [pipeline])).id;
    await db.query(`update companies set pipeline_id = $1, stage_id = $2 where id = $3`, [pipeline, stage, acme]);
    await db.query(`insert into tasks (company_id, title, due_date) values ($1, 'Relancer Paul', '2030-02-01'), ($1, 'Appeler Paul', '2030-01-15'), ($1, 'Déjà faite', '2029-01-01')`, [acme]);
    await db.query(`update tasks set done_at = now() where title = 'Déjà faite'`);
    const [m, ...rest] = await context(["PAUL@acme.example.test ", "inconnu@example.test"]);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ email: "paul@acme.example.test", person: { name: "Paul Martin", title: "Gérant" }, company: { id: acme, name: "Acme" },
      pipeline: "[TEST] Ventes", stage: "Proposition envoyée", next_action: { title: "Appeler Paul", due_date: "2030-01-15" } });
  });

  test("fiche hors pipeline et sans action ; plusieurs fiches dans un même fil", async () => {
    const all = await context(["paul@acme.example.test", "lea@acme.example.test", "nina@beta.example.test"]);
    expect(all.map((x) => x.company.name)).toEqual(["Acme", "Acme", "Beta"]);
    expect(all[0]).toMatchObject({ pipeline: null, stage: null, next_action: null });
  });

  test("aucune adresse connue, liste vide, fiche fusionnée : rien", async () => {
    expect(await context(["inconnu@example.test"])).toEqual([]);
    expect(await context([])).toEqual([]);
    await admin(`update companies set merged_into_id = $1 where id = $2 returning id`, [acme, beta]);
    expect(await context(["nina@beta.example.test"])).toEqual([]);
  });

  test("un autre compte n'obtient rien ; un visiteur est refusé", async () => {
    expect(await context(["paul@acme.example.test"], "stranger")).toEqual([]);
    await db.as("anon");
    await expect(db.rpc("mailbox_crm_context", { p_emails: ["paul@acme.example.test"] })).rejects.toThrow(/permission denied/);
  });
});

describe("message envoyé depuis la boîte : historique de la fiche, sans doublon", () => {
  test("destinataire d'une seule fiche : une ligne d'historique et un email envoyé rattaché", async () => {
    expect(await record()).toMatchObject({ recorded: true, company_id: acme });
    expect(await admin(`select kind, channel, content from interactions where company_id = $1 and kind = 'message_out'`, [acme])).toEqual({ kind: "message_out", channel: "email", content: "Proposition\n\nBonjour Paul" });
    expect(await admin(`select status, direction, origin, company_id, provider_message_id, to_addrs, (interaction_id is not null) linked, (sent_at is not null) sent from mail_messages`))
      .toEqual({ status: "accepted", direction: "out", origin: "manual", company_id: acme, provider_message_id: "g-1", to_addrs: ["paul@acme.example.test"], linked: true, sent: true });
  });

  test("le même message enregistré deux fois (nouvel essai) : une seule trace", async () => {
    await record();
    expect(await record()).toMatchObject({ recorded: false, reason: "duplicate" });
    expect(await n(`select count(*)::int n from interactions where kind = 'message_out'`)).toBe(1);
    expect(await n(`select count(*)::int n from mail_messages`)).toBe(1);
  });

  test("la lecture des mails reçus ne réimporte pas ce message", async () => {
    await record();
    await db.as("anon");
    const r = await db.rpc<Record<string, number>>("mail_inbound_ingest", { p_server_key: KEY, p_account: account, p_history_id: "1", p_messages: [
      { provider_message_id: "g-1", provider_thread_id: "t-1", rfc_message_id: "<g1@example.test>", from: "paul@acme.example.test", to: ["moi@example.test"], subject: "Proposition", text: "x", received_at: new Date().toISOString(), automatic: false, attachments: [] }] });
    expect(r).toMatchObject({ linked: 0, skipped: 1 });
    expect(await n(`select count(*)::int n from mail_messages`)).toBe(1);
  });

  test("la réponse du contact dans le même fil s'ajoute une fois, par le mécanisme existant", async () => {
    await record();
    await db.as("anon");
    const reply = { provider_message_id: "g-2", provider_thread_id: "t-1", rfc_message_id: "<g2@acme.example.test>", in_reply_to: "<g1@example.test>", from: "paul@acme.example.test", to: ["moi@example.test"], subject: "Re: Proposition", text: "D'accord", received_at: new Date().toISOString(), automatic: false, attachments: [] };
    await db.rpc("mail_inbound_ingest", { p_server_key: KEY, p_account: account, p_history_id: "2", p_messages: [reply] });
    await db.rpc("mail_inbound_ingest", { p_server_key: KEY, p_account: account, p_history_id: "3", p_messages: [reply] });
    expect(await n(`select count(*)::int n from interactions where company_id = $1 and kind in ('message_out', 'message_in')`, [acme])).toBe(2);
  });

  test("aucune fiche : rien n'est conservé ; plusieurs fiches : rien n'est rattaché d'office", async () => {
    expect(await record({ to: ["inconnu@example.test"] })).toMatchObject({ recorded: false, reason: "no_record" });
    expect(await record({ provider_message_id: "g-9", to: ["paul@acme.example.test"], cc: ["nina@beta.example.test"] })).toMatchObject({ recorded: false, reason: "several_records" });
    expect(await n(`select count(*)::int n from mail_messages`)).toBe(0);
    expect(await n(`select count(*)::int n from interactions where kind = 'message_out'`)).toBe(0);
  });

  test("personne en copie seulement : rattaché à sa fiche ; destinataire direct préféré", async () => {
    expect(await record({ to: ["inconnu@example.test"], cc: ["lea@acme.example.test"] })).toMatchObject({ recorded: true, company_id: acme });
    const r = await record({ provider_message_id: "g-3", to: ["lea@acme.example.test"], cc: ["paul@acme.example.test"] });
    const lea = (await admin<{ id: string }>(`select id from people where email_norm = 'lea@acme.example.test'`)).id;
    expect(r).toMatchObject({ recorded: true, person_id: lea });
  });

  test("clé serveur exigée, quel que soit le compte", async () => {
    for (const who of ["owner", "stranger", "claude", "anon"] as const) {
      await db.as(who);
      await expect(db.rpc("mailbox_record_sent", { p_server_key: "mauvaise-cle-0123456789abcdef0123456789", p_account: account, p: { provider_message_id: "g-1", to: ["paul@acme.example.test"] } }), who).rejects.toThrow(/Accès refusé/);
    }
    expect(await n(`select count(*)::int n from mail_messages`)).toBe(0);
  });
});
