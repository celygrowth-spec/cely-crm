// Messages lemlist, lot M1 : comptes lemlist des clients. Vraies migrations, lemlist simulé (aucun appel réseau réel,
// aucune vraie clé). Clé testée puis chiffrée ; un compte refusé passe « À reconnecter » sans toucher aux autres ;
// chaque appel part avec la clé du compte demandé ; droits imposés par la base ; Corbeille, purge et fusion.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectLemlistAccount, disconnectLemlistAccount, listClientOptions, listLemlistAccounts, verifyLemlistAccount, withLemlistAccount } from "@/lib/lemlist/accounts";
import { decryptSecret } from "@/lib/mail/crypto";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, sha } from "./projets-helpers";

const TOKEN_KEY = Buffer.alloc(32, 9).toString("base64");
const KEY_A = "fake-lemlist-key-AAAA-0001";
const KEY_B = "fake-lemlist-key-BBBB-0002";
const TEAMS: Record<string, { _id: string; name: string; userIds: string[] }> = {
  [KEY_A]: { _id: "tea_A", name: "Équipe Alpha", userIds: ["usr_a1"] },
  [KEY_B]: { _id: "tea_B", name: "Équipe Beta", userIds: ["usr_b1"] },
};

let db: Db;
let sb: SupabaseClient;
let calls: { url: string; key: string }[];
let refused: Set<string>;
let limited: Set<string>;
let alpha: string;
let beta: string;

const keyOf = (auth: string | null) => Buffer.from((auth ?? "").replace(/^Basic /, ""), "base64").toString("utf8").replace(/^:/, "");
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers });

function fakeClient(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        return { data: await db.rpc(fn, args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
  } as unknown as SupabaseClient;
}

async function client(name: string) {
  const id = (await db.rpc<{ id: string }>("create_company", { p_company: { name }, p_people: [], p_force: true })).id;
  await db.exec("reset role");
  await db.query(`update companies set deal_status = 'won', deal_closed_at = now() where id = $1`, [id]);
  await db.as("owner");
  return id;
}

beforeEach(async () => {
  vi.stubEnv("MAIL_TOKEN_KEY", TOKEN_KEY);
  db = await createDb();
  sb = fakeClient();
  calls = [];
  refused = new Set();
  limited = new Set();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const key = keyOf(new Headers(init.headers).get("authorization"));
    calls.push({ url, key });
    if (!url.startsWith("https://api.lemlist.com/api/")) throw new Error("appel inattendu");
    if (refused.has(key) || !TEAMS[key]) return new Response("The authentication you supplied is incorrect", { status: 401 });
    if (limited.has(key)) return json({}, 429, { "retry-after": "2" });
    if (url.endsWith("/team")) return json(TEAMS[key]);
    return json({}, 404);
  });
  alpha = await client("[TEST] Client Alpha");
  beta = await client("[TEST] Client Beta");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const status = async (id: string) => (await db.one<{ status: string }>(`select status from lemlist_accounts where id = $1`, [id])).status;

describe("connexion", () => {
  test("clé valide : testée chez lemlist (Basic, identifiant vide), nom de l'équipe, état Connecté ; clé stockée chiffrée seulement", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: `  ${KEY_A} ` });
    expect(a).toMatchObject({ company_id: alpha, company_name: "[TEST] Client Alpha", team_id: "tea_A", team_name: "Équipe Alpha", status: "connected" });
    expect(calls).toEqual([{ url: "https://api.lemlist.com/api/team", key: KEY_A }]);
    await db.exec("reset role");
    const s = await db.one<{ api_key_enc: string }>(`select api_key_enc from lemlist_account_secrets where account_id = $1`, [a.id]);
    expect(s.api_key_enc).not.toContain(KEY_A);
    expect(decryptSecret(s.api_key_enc, TOKEN_KEY)).toBe(KEY_A);
    const everything = JSON.stringify((await db.query(`select * from lemlist_accounts`)).rows);
    expect(everything).not.toContain(KEY_A);
    // la liste affichée ne porte jamais la clé, même chiffrée
    await db.as("owner");
    expect(JSON.stringify(await listLemlistAccounts(sb))).not.toMatch(/v1\.|fake-lemlist/);
  });

  test("clé invalide : refus clair, rien n'est enregistré", async () => {
    await expect(connectLemlistAccount(sb, { companyId: alpha, apiKey: "fake-invalid-key-000" })).rejects.toThrow(/lemlist a refusé cette clé API/);
    expect(await db.one(`select count(*)::int n from lemlist_accounts`)).toEqual({ n: 0 });
  });

  test("lemlist injoignable : pas d'ajout, message sans détail sensible", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("ECONNRESET secret"); });
    await expect(connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A })).rejects.toThrow(/^lemlist n'a pas répondu\. Le compte n'a pas été ajouté\.$/);
  });

  test("MAIL_TOKEN_KEY absente : aucun ajout, la clé n'est même pas envoyée", async () => {
    vi.stubEnv("MAIL_TOKEN_KEY", "");
    await expect(connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A })).rejects.toThrow(/MAIL_TOKEN_KEY/);
    expect(calls).toEqual([]);
  });

  test("un compte lemlist n'appartient qu'à une fiche ; après déconnexion il peut changer de fiche", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    await expect(connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_A })).rejects.toThrow(/déjà rattaché à la fiche « \[TEST\] Client Alpha »/);
    await disconnectLemlistAccount(sb, a.id);
    const moved = await connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_A });
    expect(moved).toMatchObject({ id: a.id, company_id: beta, status: "connected" });
  });

  test("fiches proposées : seulement les clients", async () => {
    await db.rpc("create_company", { p_company: { name: "[TEST] Simple prospect" }, p_people: [], p_force: true });
    expect((await listClientOptions(sb)).map((c) => c.name)).toEqual(["[TEST] Client Alpha", "[TEST] Client Beta"]);
  });
});

describe("état de chaque compte", () => {
  test("clé révoquée : ce compte passe « À reconnecter », l'autre reste connecté ; une nouvelle clé le reconnecte", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    const b = await connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_B });
    refused.add(KEY_A);
    const r = await verifyLemlistAccount(sb, a.id);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/refusée par lemlist/) });
    expect(await status(a.id)).toBe("needs_reconnect");
    expect(await status(b.id)).toBe("connected");
    expect((await verifyLemlistAccount(sb, b.id)).ok).toBe(true);
    refused.delete(KEY_A);
    await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    expect(await status(a.id)).toBe("connected");
  });

  test("limite de débit : erreur notée sur ce compte, état inchangé", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    limited.add(KEY_A);
    const r = await withLemlistAccount(sb, a.id, async () => { throw new (await import("@/lib/lemlist/client")).LemlistError("rate", "Limite", 2); });
    expect(r).toMatchObject({ ok: false, code: "rate", retryAfterSec: 2 });
    expect(await status(a.id)).toBe("connected");
    expect((await listLemlistAccounts(sb))[0].last_error).toBe("Limite");
  });

  test("chaque appel part avec la clé du compte demandé, retrouvée par le serveur", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    const b = await connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_B });
    expect(await withLemlistAccount(sb, a.id, async (key) => key)).toMatchObject({ ok: true, data: KEY_A });
    expect(await withLemlistAccount(sb, b.id, async (key) => key)).toMatchObject({ data: KEY_B });
    await expect(withLemlistAccount(sb, "00000000-0000-4000-8000-000000000099", async (k) => k)).rejects.toThrow(/introuvable/);
  });

  test("une clé qui change d'équipe est refusée à la vérification", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    TEAMS[KEY_A]._id = "tea_X";
    try {
      expect(await verifyLemlistAccount(sb, a.id)).toMatchObject({ ok: false, message: expect.stringMatching(/autre équipe/) });
      expect(await status(a.id)).toBe("needs_reconnect");
    } finally {
      TEAMS[KEY_A]._id = "tea_A";
    }
  });

  test("déconnexion : clé effacée, plus aucun appel possible, compte hors de la liste", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    await disconnectLemlistAccount(sb, a.id);
    expect(await db.rpc("lemlist_account_key", { p_id: a.id })).toBeNull();
    await expect(withLemlistAccount(sb, a.id, async (k) => k)).rejects.toThrow(/déconnecté/);
    expect(await listLemlistAccounts(sb)).toEqual([]);
    await db.exec("reset role");
    expect(await db.one(`select count(*)::int n from lemlist_account_secrets`)).toEqual({ n: 0 });
  });
});

describe("droits imposés par la base", () => {
  test("portail (anon), autre compte et Claude : ni lecture, ni écriture, ni clé", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    for (const who of ["anon", "stranger", "claude"] as const) {
      await db.as(who);
      for (const t of ["lemlist_accounts", "lemlist_account_secrets"]) {
        const read = db.query(`select * from ${t}`);
        if (who === "anon") await expect(read).rejects.toThrow(/permission denied/);
        else expect((await read).rows).toEqual([]);
      }
      if (who === "anon") {
        await expect(db.rpc("lemlist_account_key", { p_id: a.id })).rejects.toThrow(/permission denied/);
        await expect(db.rpc("lemlist_accounts_list", {})).rejects.toThrow(/permission denied/);
      } else {
        expect(await db.rpc("lemlist_account_key", { p_id: a.id })).toBeNull();
        expect(await db.rpc("lemlist_accounts_list", {})).toEqual([]);
      }
      await expect(db.rpc("lemlist_connect", { p_company: alpha, p_team_id: "tea_Z", p_team_name: "x", p_key_enc: "v1.a.b.c" })).rejects.toThrow();
      await expect(db.rpc("lemlist_disconnect", { p_id: a.id })).rejects.toThrow();
    }
    await db.as("owner");
    expect(await status(a.id)).toBe("connected");
  });

  test("une clé non chiffrée est refusée par la base", async () => {
    await expect(db.rpc("lemlist_connect", { p_company: alpha, p_team_id: "tea_Z", p_team_name: "x", p_key_enc: KEY_A })).rejects.toThrow(/chiffrée/);
  });
});

describe("fiche du client", () => {
  test("corbeille : compte caché et inutilisable, il revient à la restauration", async () => {
    const a = await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    const t = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "company", p_id: alpha });
    expect(await listLemlistAccounts(sb)).toEqual([]);
    expect(await db.rpc("lemlist_account_key", { p_id: a.id })).toBeNull();
    await expect(withLemlistAccount(sb, a.id, async (k) => k)).rejects.toThrow(/introuvable/);
    // la même équipe ne peut pas être rattachée ailleurs pendant ce temps
    await expect(connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_A })).rejects.toThrow(/corbeille/);
    await db.rpc("trash_restore", { p_trash: t.trash_id, p_with_parent: false });
    expect((await listLemlistAccounts(sb)).map((x) => x.id)).toEqual([a.id]);
    expect(await withLemlistAccount(sb, a.id, async (k) => k)).toMatchObject({ ok: true, data: KEY_A });
  });

  test("purge définitive : compte et clé supprimés", async () => {
    await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
    await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
    const t = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "company", p_id: alpha });
    await db.exec(`reset role; update trash_items set purge_after = now() - interval '1 day' where id = '${t.trash_id}'`);
    await db.as("anon");
    expect(await db.rpc("trash_purge_due", { p_server_key: SERVER_KEY })).toMatchObject({ purged: 1, failed: 0 });
    await db.exec("reset role");
    expect(await db.one(`select (select count(*)::int from lemlist_accounts) a, (select count(*)::int from lemlist_account_secrets) s`)).toEqual({ a: 0, s: 0 });
  });

  test("fusion : le compte suit la fiche conservée ; archivage : le compte reste actif", async () => {
    const a = await connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_A });
    await db.rpc("merge_companies", { p_keep: alpha, p_merge: beta, p_fields: {}, p_pipeline_from: "keep" });
    expect((await listLemlistAccounts(sb))[0]).toMatchObject({ id: a.id, company_id: alpha, status: "connected" });
    await db.exec("reset role");
    await db.query(`update companies set archived_at = now() where id = $1`, [alpha]);
    await db.as("owner");
    expect((await listLemlistAccounts(sb))[0]).toMatchObject({ id: a.id, company_archived: true, status: "connected" });
  });
});

test("code navigateur : aucune référence à la clé, au chiffrement ni au service serveur lemlist", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const browser = walk("src").filter((f) => /\.tsx?$/.test(f) && readFileSync(f, "utf8").startsWith(`"use client"`));
  for (const f of browser) expect(readFileSync(f, "utf8"), f).not.toMatch(/api_key_enc|lemlist_account_secrets|lemlist_account_key|lib\/lemlist\/(accounts|client)|lib\/mail\/crypto/);
});

test("adresse de lemlist : le faux lemlist local n'est accepté qu'en environnement de test, sur 127.0.0.1", async () => {
  const { getTeam } = await import("@/lib/lemlist/client");
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => { seen.push(url); return new Response(JSON.stringify({ _id: "tea_A", name: "A" }), { status: 200 }); });
  vi.stubEnv("LEMLIST_API_URL", "http://127.0.0.1:54400");
  await getTeam("k-0000000000"); // sans CELY_TEST_ENV : ignoré
  vi.stubEnv("CELY_TEST_ENV", "1");
  vi.stubEnv("LEMLIST_API_URL", "https://evil.example.test");
  await getTeam("k-0000000000"); // pas local : ignoré
  vi.stubEnv("LEMLIST_API_URL", "http://127.0.0.1:54400");
  await getTeam("k-0000000000");
  expect(seen).toEqual(["https://api.lemlist.com/api/team", "https://api.lemlist.com/api/team", "http://127.0.0.1:54400/api/team"]);
});
