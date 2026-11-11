// Audit, lot 5 : C07 (passages rapportés), C09 (limites de réservation), Q02 (trace des rappels envoyés),
// Q03 (réception Gmail : rattachement, doublons, campagnes, ambiguïté, rattachement manuel).
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "test-server-key-0123456789abcdef0123456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let db: Db;
let account: string;
let acme: string;
let paul: string;

const msg = (over: Record<string, unknown> = {}) => ({
  provider_message_id: `g-${Math.random().toString(36).slice(2)}`, provider_thread_id: "t-1", rfc_message_id: null, in_reply_to: null, references: null,
  from: "paul@acme.example.test", to: ["moi@example.test"], subject: "Re: notre échange", text: "Oui, parlons-en jeudi.",
  received_at: new Date().toISOString(), automatic: false, attachments: [], ...over,
});
const ingest = (messages: unknown[], initial = false) => db.rpc<Record<string, number>>("mail_inbound_ingest", { p_server_key: KEY, p_account: account, p_messages: messages, p_history_id: "100", p_initial: initial });
const n = async (sql: string, p?: unknown[]) => (await db.one<{ n: number }>(sql, p)).n;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(KEY) });
  await db.exec(`reset role;`);
  account = (await db.one<{ id: string }>(`insert into mail_accounts (email, scopes) values ('moi@example.test', '{}') returning id`)).id;
  await db.query(`insert into mail_account_secrets (account_id, refresh_token_enc) values ($1, 'x')`, [account]);
  await db.as("owner");
  acme = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Acme" }, p_people: [{ first_name: "Paul", email: "paul@acme.example.test" }] })).id;
  paul = (await db.one<{ id: string }>(`select id from people where company_id = $1`, [acme])).id;
  await db.as("anon");
});

describe("Q03 — réception Gmail", () => {
  test("réponse d'un contact : rattachée à sa fiche, historique, relances en pause (Réponses à traiter) ; doublon ignoré", async () => {
    await db.as("owner");
    const campaign = await db.rpc<string>("create_campaign_draft", { p_name: "Fondateurs" });
    await db.rpc("save_campaign_sequence", { p_campaign: campaign, p_steps: [{ name: "Email", step_type: "email", delay_days: 0, subject: "Bonjour", message: "Bonjour" }, { name: "Relance", step_type: "email", delay_days: 3, subject: "Relance", message: "Relance" }] });
    await db.rpc("enroll_in_campaign", { p_campaign: campaign, p_company_ids: [acme] });
    const part = (await db.one<{ id: string }>(`select id from campaign_participants`)).id;
    await db.rpc("activate_participants", { p_campaign: campaign, p_ids: [part] });
    await db.as("anon");
    const m = msg();
    expect(await ingest([m])).toEqual({ linked: 1, to_link: 0, ignored: 0, skipped: 0 });
    expect(await ingest([m])).toEqual({ linked: 0, to_link: 0, ignored: 0, skipped: 1 });
    await db.as("owner");
    expect(await db.one(`select status from campaign_participants where id = $1`, [part])).toEqual({ status: "a_repondu" });
    expect(await db.one(`select company_id, person_id, link_state, direction from mail_messages where provider_message_id = $1`, [m.provider_message_id]))
      .toEqual({ company_id: acme, person_id: paul, link_state: "linked", direction: "in" });
    expect(await n(`select count(*)::int n from interactions where company_id = $1 and kind = 'message_in' and person_id = $2`, [acme, paul])).toBe(1);
    expect(await db.rpc("nav_counters", { p_today: new Date().toISOString().slice(0, 10) })).toMatchObject({ replies: 1 });
  });

  test("automatique : conservé « ignoré », sans effet ; inconnu : rien n'est conservé ; écho d'un envoi du CRM : ignoré", async () => {
    await db.exec(`reset role; insert into mail_messages (account_id, status, rfc_message_id, direction) values ('${account}', 'pending', '<a@cely>', 'out');`);
    await db.as("anon");
    expect(await ingest([msg({ automatic: true }), msg({ from: "inconnu@ailleurs.example.test" }), msg({ rfc_message_id: "<a@cely>" })]))
      .toEqual({ linked: 0, to_link: 0, ignored: 1, skipped: 2 });
    await db.as("owner");
    expect(await n(`select count(*)::int n from interactions where kind = 'message_in'`)).toBe(0);
  });

  test("même adresse sur deux fiches : à rattacher ; la résolution manuelle crée l'échange et n'est plus modifiée", async () => {
    await db.as("owner");
    const beta = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Beta" }, p_people: [{ first_name: "Paul", email: "paul@acme.example.test" }] })).id;
    await db.as("anon");
    const m = msg();
    expect(await ingest([m])).toMatchObject({ to_link: 1 });
    await db.as("owner");
    const id = (await db.one<{ id: string; link_candidates: unknown[] }>(`select id, link_candidates from mail_messages where provider_message_id = $1`, [m.provider_message_id]));
    expect(id.link_candidates).toHaveLength(2);
    await db.rpc("mail_inbound_link", { p_message: id.id, p_company: beta });
    expect(await db.one(`select company_id, link_state, linked_manually from mail_messages where id = $1`, [id.id])).toEqual({ company_id: beta, link_state: "linked", linked_manually: true });
    expect(await n(`select count(*)::int n from interactions where company_id = $1 and kind = 'message_in'`, [beta])).toBe(1);
  });

  test("import initial : historique rattaché sans mettre les campagnes en pause ; sans clé serveur : refus", async () => {
    expect(await ingest([msg()], true)).toMatchObject({ linked: 1 });
    await expect(db.rpc("mail_inbound_ingest", { p_server_key: "mauvaise-cle-0123456789abcdef0123456789", p_account: account, p_messages: [] })).rejects.toThrow(/Accès refusé/);
    await db.as("owner");
    expect(await db.one(`select initial_done_at is not null d, history_id from mail_sync_state`)).toEqual({ d: true, history_id: "100" });
  });
});

describe("Q02 — rappel envoyé : une seule trace, avec la personne", () => {
  test("même clé : pas de doublon ; l'échange apparaît sur la fiche avec la personne", async () => {
    const p = { account_id: account, status: "accepted", company_id: acme, person_id: paul, to: ["paul@acme.example.test"], subject: "Rappel : demain", body: "À demain", dedupe_key: "rappel:abc" };
    const a = await db.rpc<{ id: string; duplicate: boolean }>("mail_server_record", { p_server_key: KEY, p });
    const b = await db.rpc<{ id: string; duplicate: boolean }>("mail_server_record", { p_server_key: KEY, p });
    expect(b).toEqual({ id: a.id, duplicate: true });
    await db.as("owner");
    expect(await n(`select count(*)::int n from interactions where company_id = $1 and kind = 'message_out' and person_id = $2`, [acme, paul])).toBe(1);
  });
});

describe("C07 / C09 — passages rapportés, limites de réservation", () => {
  test("dernière réussite et dernière erreur visibles", async () => {
    await db.rpc("job_report", { p_server_key: KEY, p_job: "agenda", p_ok: true, p_result: { pushed: 1 } });
    await db.rpc("job_report", { p_server_key: KEY, p_job: "agenda", p_ok: false, p_error: "Google indisponible" });
    await db.as("owner");
    expect(await db.one(`select last_success_at is not null s, last_error, last_result from scheduled_jobs where job = 'agenda'`)).toEqual({ s: true, last_error: "Google indisponible", last_result: { pushed: 1 } });
  });

  test("au-delà de 10 tentatives par heure depuis une même connexion : refus", async () => {
    for (let i = 0; i < 10; i++) expect(await db.rpc("appt_rate_check", { p_server_key: KEY, p_email: `x${i}@ex.test`, p_ip_hash: "ip1" })).toBeNull();
    expect(await db.rpc("appt_rate_check", { p_server_key: KEY, p_email: "y@ex.test", p_ip_hash: "ip1" })).toMatch(/Trop de tentatives/);
    expect(await db.rpc("appt_rate_check", { p_server_key: KEY, p_email: "y@ex.test", p_ip_hash: "ip2" })).toBeNull();
  });
});
