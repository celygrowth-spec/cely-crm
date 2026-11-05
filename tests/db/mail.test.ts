// États des emails, double envoi, droits : sur les vraies migrations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let company: string;
const ID = "11111111-1111-4111-8111-111111111111";

const connect = (email = "moi@cely.fr") =>
  db.rpc<string>("mail_connect", { p_email: email, p_name: "Moi", p_scopes: ["send"], p_refresh_enc: "v1.r", p_access_enc: "v1.a", p_expires: new Date(Date.now() + 3600e3).toISOString() });
const draft = (p: Record<string, unknown> = {}, id = ID) =>
  db.rpc<{ status: string; subject: string }>("mail_save_draft", { p_id: id, p: { company_id: company, to: ["paul@acme.io"], subject: "Bonjour", body: "Texte", ...p } });
const status = async (id = ID) => (await db.one<{ status: string }>(`select status from mail_messages where id = $1`, [id])).status;
const history = async () => (await db.one<{ n: number }>(`select count(*)::int n from interactions where kind = 'message_out'`)).n;

beforeEach(async () => {
  db = await createDb();
  company = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
});

describe("brouillons", () => {
  test("enregistrer deux fois met à jour sans doublon ; rien dans l'historique", async () => {
    await draft({ subject: "Un" });
    await draft({ subject: "Deux" });
    expect(await db.one(`select count(*)::int n, max(subject) s from mail_messages`)).toEqual({ n: 1, s: "Deux" });
    expect(await status()).toBe("draft");
    expect(await history()).toBe(0);
  });

  test("un brouillon ne peut pas devenir accepté, ni directement ni par la fonction", async () => {
    await draft();
    await expect(db.query(`update mail_messages set status = 'accepted' where id = $1`, [ID])).rejects.toThrow(/interdit/);
    await expect(db.rpc("mail_mark_accepted", { p_id: ID, p_message_id: "g1", p_thread_id: "t1" })).rejects.toThrow(/pas en cours/);
    await expect(db.query(`insert into mail_messages (status) values ('accepted')`)).rejects.toThrow(/commence/);
    expect(await status()).toBe("draft");
  });
});

describe("envoi", () => {
  test("le double clic ne prend le message qu'une fois", async () => {
    await connect();
    await draft();
    const a = await db.rpc<{ claimed: boolean }>("mail_claim", { p_id: ID });
    const b = await db.rpc<{ claimed: boolean; status: string }>("mail_claim", { p_id: ID });
    expect(a.claimed).toBe(true);
    expect(b).toMatchObject({ claimed: false, status: "sending" });
  });

  test("accepté : une seule entrée d'historique, et plus aucune modification", async () => {
    await connect();
    await draft();
    await db.rpc("mail_claim", { p_id: ID });
    await db.rpc("mail_mark_accepted", { p_id: ID, p_message_id: "g1", p_thread_id: "t1" });
    await expect(db.rpc("mail_mark_accepted", { p_id: ID, p_message_id: "g1", p_thread_id: "t1" })).rejects.toThrow();
    expect(await history()).toBe(1);
    expect(await db.one(`select content, channel, source from interactions where kind = 'message_out'`)).toEqual({ content: "Objet : Bonjour\n\nTexte", channel: "email", source: "user" });
    await expect(draft({ subject: "Modifié" })).rejects.toThrow(/plus un brouillon/);
    await expect(db.query(`update mail_messages set subject = 'x' where id = $1`, [ID])).rejects.toThrow(/plus un brouillon/);
    await expect(db.rpc("mail_discard", { p_id: ID })).rejects.toThrow(/plus être annulé/);
  });

  test("échec : aucun historique, le texte est conservé et le message peut être repris", async () => {
    await connect();
    await draft();
    await db.rpc("mail_claim", { p_id: ID });
    await db.rpc("mail_mark_failed", { p_id: ID, p_code: "quota", p_error: "Limite" });
    expect(await status()).toBe("failed");
    expect(await history()).toBe(0);
    const r = await db.rpc<{ status: string; body_text: string }>("mail_reopen", { p_id: ID });
    expect(r).toMatchObject({ status: "draft", body_text: "Texte" });
  });

  test("incertain : jamais relancé tout seul ; seul l'utilisateur tranche", async () => {
    await connect();
    await draft();
    await db.rpc("mail_claim", { p_id: ID });
    await db.rpc("mail_mark_failed", { p_id: ID, p_code: "network", p_error: "?", p_uncertain: true });
    expect((await db.rpc<{ claimed: boolean }>("mail_claim", { p_id: ID })).claimed).toBe(false);
    await expect(db.rpc("mail_reopen", { p_id: ID })).rejects.toThrow();
    expect(await history()).toBe(0);
    await db.rpc("mail_resolve_uncertain", { p_id: ID, p_sent: true });
    expect(await status()).toBe("accepted");
    expect(await history()).toBe(1);
  });

  test("incertain confirmé « non parti » : échec, puis reprise possible", async () => {
    await connect();
    await draft();
    await db.rpc("mail_claim", { p_id: ID });
    await db.rpc("mail_mark_failed", { p_id: ID, p_code: "http_503", p_error: "?", p_uncertain: true });
    await db.rpc("mail_resolve_uncertain", { p_id: ID, p_sent: false });
    expect(await status()).toBe("failed");
    expect(await history()).toBe(0);
  });

  test("traitement interrompu : devient incertain après 5 minutes, pas avant", async () => {
    await connect();
    await draft();
    await db.rpc("mail_claim", { p_id: ID });
    expect(await db.rpc("mail_reap_stale", {})).toBe(0);
    await db.query(`update mail_messages set claimed_at = now() - interval '6 minutes' where id = $1`, [ID]);
    expect(await db.rpc("mail_reap_stale", {})).toBe(1);
    expect(await status()).toBe("uncertain");
  });

  test("sans destinataire, sans compte ou compte déconnecté : refus", async () => {
    await draft();
    await expect(db.rpc("mail_claim", { p_id: ID })).rejects.toThrow(/Aucun compte/);
    const acc = await connect();
    await draft({ to: [] });
    await expect(db.rpc("mail_claim", { p_id: ID })).rejects.toThrow(/destinataire/);
    await draft();
    await db.rpc("mail_disconnect", { p_id: acc });
    await expect(db.rpc("mail_claim", { p_id: ID })).rejects.toThrow(/Aucun compte/);
    expect(await status()).toBe("draft");
  });
});

describe("déduplication", () => {
  test("une même clé ne crée qu'un seul message", async () => {
    await connect();
    const p = { to: ["a@b.fr"], subject: "Rappel", body: "x", origin: "appointment", dedupe_key: "rdv:1:v1:j-1" };
    const a = await db.rpc<{ id: string; duplicate: boolean }>("mail_enqueue", { p });
    const b = await db.rpc<{ id: string; duplicate: boolean }>("mail_enqueue", { p });
    expect(a.duplicate).toBe(false);
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    expect(await db.one(`select count(*)::int n from mail_messages`)).toEqual({ n: 1 });
  });
});

describe("déconnexion", () => {
  test("efface les jetons, annule ce qui attend, et la reconnexion ne relance rien", async () => {
    const acc = await connect();
    const m = await db.rpc<{ id: string }>("mail_enqueue", { p: { account_id: acc, to: ["a@b.fr"], subject: "x", body: "y" } });
    await db.rpc("mail_disconnect", { p_id: acc });
    expect(await db.one(`select count(*)::int n from mail_account_secrets`)).toEqual({ n: 0 });
    expect(await status(m.id)).toBe("cancelled");
    const again = await connect();
    expect(again).toBe(acc);
    expect(await status(m.id)).toBe("cancelled");
    expect(await db.one(`select status, is_default from mail_accounts`)).toEqual({ status: "connected", is_default: true });
  });

  test("Google retire l'accès : plus d'envoi jusqu'à la reconnexion", async () => {
    const acc = await connect();
    await db.rpc("mail_mark_reconnect", { p_id: acc, p_error: "révoqué" });
    expect(await db.rpc("mail_account_secret", { p_id: acc })).toBeNull();
    await draft();
    await expect(db.rpc("mail_claim", { p_id: ID })).rejects.toThrow(/Aucun compte/);
  });

  test("un seul compte actif ; l'ancien reste connu", async () => {
    await connect("a@cely.fr");
    await connect("b@cely.fr");
    const r = await db.query<{ email: string; is_default: boolean }>(`select email, is_default from mail_accounts order by email`);
    expect(r.rows).toEqual([{ email: "a@cely.fr", is_default: false }, { email: "b@cely.fr", is_default: true }]);
  });
});

describe("pièces jointes", () => {
  const file = async (c = company, status = "ready") =>
    (await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, gen_random_uuid()::text, 'a.pdf', 'application/pdf', 10, $2) returning id`, [c, status])).id;

  test("seulement les fichiers disponibles de cette fiche", async () => {
    const other = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Autre" }, p_people: [] })).id;
    await expect(draft({ file_ids: [await file(other)] })).rejects.toThrow(/indisponible/);
    await expect(draft({ file_ids: [await file(company, "pending")] })).rejects.toThrow(/indisponible/);
    const f = await file();
    const r = await draft({ file_ids: [f] }) as unknown as { attachments: { file_id: string; name: string }[] };
    expect(r.attachments).toMatchObject([{ file_id: f, name: "a.pdf" }]);
  });

  test("fichier supprimé après coup : l'envoi est refusé et le nom reste affiché", async () => {
    await connect();
    const f = await file();
    await draft({ file_ids: [f] });
    await db.query(`delete from company_files where id = $1`, [f]);
    await expect(db.rpc("mail_claim", { p_id: ID })).rejects.toThrow(/n'existe plus/);
    expect(await db.one(`select name, file_id from mail_attachments`)).toEqual({ name: "a.pdf", file_id: null });
  });
});

describe("fusion", () => {
  test("les emails suivent la fiche conservée", async () => {
    await draft();
    const keep = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Beta Conservée" }, p_people: [] })).id;
    await db.query(`update companies set merged_into_id = $1 where id = $2`, [keep, company]);
    expect(await db.one(`select company_id from mail_messages`)).toEqual({ company_id: keep });
  });
});

describe("droits", () => {
  test.each(["stranger", "claude"] as const)("%s ne voit ni comptes, ni jetons, ni messages et ne peut rien envoyer", async (who) => {
    const acc = await connect();
    await draft();
    await db.as(who);
    for (const t of ["mail_accounts", "mail_account_secrets", "mail_messages", "mail_attachments"]) {
      expect(await db.one(`select count(*)::int n from ${t}`)).toEqual({ n: 0 });
    }
    expect(await db.rpc("mail_account_secret", { p_id: acc })).toBeNull();
    await expect(db.rpc("mail_claim", { p_id: ID })).rejects.toThrow();
    await expect(db.rpc("mail_enqueue", { p: { to: ["a@b.fr"], subject: "x", body: "y" } })).rejects.toThrow();
    await expect(db.rpc("mail_disconnect", { p_id: acc })).rejects.toThrow();
    await db.as("owner");
    expect(await status()).toBe("draft");
  });

  test("la migration ne touche pas aux droits des fonctions d'un autre module", async () => {
    await db.exec(`reset role;`);
    await db.exec(`create function public.fonction_publique_test() returns int language sql as 'select 1';
      grant execute on function public.fonction_publique_test() to anon;`);
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261106000100_mail.sql"), "utf8");
    await db.exec(sql.slice(sql.lastIndexOf("do $$")));
    await db.as("anon");
    expect(await db.rpc("fonction_publique_test", {})).toBe(1);
    await expect(db.rpc("mail_row", { p_id: ID })).rejects.toThrow();
  });

  test("anonyme : aucun accès", async () => {
    await connect();
    await db.as("anon");
    await expect(db.query(`select * from mail_account_secrets`)).rejects.toThrow();
    await expect(db.rpc("mail_account_secret", { p_id: ID })).rejects.toThrow();
  });
});
