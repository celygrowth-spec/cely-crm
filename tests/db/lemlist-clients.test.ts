// Messages lemlist : entrée par client (grille). Vraies migrations, lemlist simulé : aucune vraie clé, aucun envoi.
// Une case par client actif (Connecté ou À reconnecter) ; pastille = conversations non lues, même règle que le compteur
// du menu (la somme des pastilles lui est égale) ; nouvelles réponses d'abord, puis réponse la plus récente.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectLemlistAccount, disconnectLemlistAccount } from "@/lib/lemlist/accounts";
import { inboxCounts, loadInbox, openThread, syncInbox } from "@/lib/lemlist/inbox";
import { createDb, type Db } from "./harness";

const TOKEN_KEY = Buffer.alloc(32, 5).toString("base64");
const KEY_A = "fake-lemlist-key-AAAA-0001";
const KEY_B = "fake-lemlist-key-BBBB-0002";
const KEY_C = "fake-lemlist-key-CCCC-0003";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

let db: Db;
let sb: SupabaseClient;
let refused: Set<string>;
let ids: { alpha: string; beta: string; gamma: string };

const conv = (id: string, minAgo: number, read: boolean, replyAgo: number | null) => ({
  _id: `ibx_${id}`, contactId: `ctc_${id}`, channels: ["linkedin"], lastActivityAt: iso(minAgo),
  ...(replyAgo !== null ? { lastRepliedAt: iso(replyAgo), haveReplies: true } : {}),
  users: [{ userId: "usr_1", sender: true, read }], contact: { _id: `ctc_${id}`, fullName: `Contact ${id}` },
});

const TEAMS: Record<string, { _id: string; convs: unknown[] }> = {
  // Alpha : deux non lues, réponse il y a 2 h
  [KEY_A]: { _id: "tea_A", convs: [conv("A1", 120, false, 120), conv("A2", 200, false, 200), conv("A3", 300, true, null)] },
  // Beta : aucune non lue, réponse la plus récente de toutes (10 min)
  [KEY_B]: { _id: "tea_B", convs: [conv("B1", 10, true, 10)] },
  // Gamma : une non lue, réponse il y a 1 jour
  [KEY_C]: { _id: "tea_C", convs: [conv("C1", 1440, false, 1440)] },
};

const keyOf = (auth: string | null) => Buffer.from((auth ?? "").replace(/^Basic /, ""), "base64").toString("utf8").replace(/^:/, "");
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

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
  refused = new Set();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const key = keyOf(new Headers(init.headers).get("authorization"));
    const u = new URL(url);
    if (u.origin !== "https://api.lemlist.com" || init.method === "POST") throw new Error("appel inattendu");
    const t = TEAMS[key];
    if (!t || refused.has(key)) return new Response("The authentication you supplied is incorrect", { status: 401 });
    if (u.pathname === "/api/team") return json({ _id: t._id, name: t._id, userIds: ["usr_1"] });
    if (u.pathname === "/api/inbox") return json({ data: t.convs, pagination: { nextPage: null } });
    if (/^\/api\/inbox\/ctc_\w+$/.test(u.pathname)) return json({ data: [] });
    return new Response("Invalid contactId", { status: 400 });
  });
  ids = { alpha: await client("[TEST] Client Alpha"), beta: await client("[TEST] Client Beta"), gamma: await client("[TEST] Client Gamma") };
  await connectLemlistAccount(sb, { companyId: ids.alpha, apiKey: KEY_A });
  await connectLemlistAccount(sb, { companyId: ids.beta, apiKey: KEY_B });
  await connectLemlistAccount(sb, { companyId: ids.gamma, apiKey: KEY_C });
  await syncInbox(sb, { force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const grid = async () => (await loadInbox(sb)).clients.map((c) => [c.company_name, c.unread, c.status]);
const sum = async () => (await loadInbox(sb)).clients.reduce((n, c) => n + c.unread, 0);

describe("grille des clients", () => {
  test("une case par client actif : nouvelles réponses d'abord, puis réponse la plus récente", async () => {
    expect(await grid()).toEqual([
      ["[TEST] Client Alpha", 2, "connected"],
      ["[TEST] Client Gamma", 1, "connected"],
      ["[TEST] Client Beta", 0, "connected"],
    ]);
  });

  test("somme des pastilles = compteur du menu ; ouvrir une conversation non lue fait baisser la pastille", async () => {
    expect(await sum()).toBe((await inboxCounts(sb)).unread);
    expect(await sum()).toBe(3);
    const a1 = (await loadInbox(sb, ids.alpha)).conversations.find((c) => c.contact_name === "Contact A1")!.id;
    await openThread(sb, a1);
    expect((await loadInbox(sb)).clients.find((c) => c.company_id === ids.alpha)?.unread).toBe(1);
    expect(await sum()).toBe((await inboxCounts(sb)).unread);
    const a2 = (await loadInbox(sb, ids.alpha)).conversations.find((c) => c.contact_name === "Contact A2")!.id;
    await openThread(sb, a2);
    expect((await loadInbox(sb)).clients.find((c) => c.company_id === ids.alpha)?.unread).toBe(0);
    expect(await sum()).toBe((await inboxCounts(sb)).unread);
    // Alpha n'a plus de nouvelle réponse : Gamma passe devant ; Beta (réponse la plus récente) devant Alpha
    expect((await grid()).map((g) => g[0])).toEqual(["[TEST] Client Gamma", "[TEST] Client Beta", "[TEST] Client Alpha"]);
  });

  test("dans un client : seulement ses conversations et ses comptes", async () => {
    const d = await loadInbox(sb, ids.alpha);
    expect(d.conversations.map((c) => c.contact_name).sort()).toEqual(["Contact A1", "Contact A2", "Contact A3"]);
    expect(d.accounts.map((a) => a.company_id)).toEqual([ids.alpha]);
    expect(d.clients).toHaveLength(3); // la grille reste disponible (en-tête, retour)
  });

  test("compte à reconnecter : la case reste visible avec cet état, sans bloquer les autres", async () => {
    refused.add(KEY_C);
    const r = await syncInbox(sb, { force: true });
    expect(r.filter((x) => x.ok).map((x) => x.company_name).sort()).toEqual(["[TEST] Client Alpha", "[TEST] Client Beta"]);
    expect((await grid()).find((g) => g[0] === "[TEST] Client Gamma")).toEqual(["[TEST] Client Gamma", 1, "needs_reconnect"]);
    expect(await sum()).toBe((await inboxCounts(sb)).unread);
  });

  test("compte déconnecté : plus de case ; aucun client actif : grille vide", async () => {
    const accounts = (await loadInbox(sb)).accounts;
    await disconnectLemlistAccount(sb, accounts.find((a) => a.company_id === ids.beta)!.id);
    expect((await grid()).map((g) => g[0])).toEqual(["[TEST] Client Alpha", "[TEST] Client Gamma"]);
    for (const a of accounts.filter((x) => x.company_id !== ids.beta)) await disconnectLemlistAccount(sb, a.id);
    expect((await loadInbox(sb)).clients).toEqual([]);
  });

  test("lien direct vers une conversation : le serveur retrouve son client", async () => {
    const c1 = (await loadInbox(sb, ids.gamma)).conversations[0].id;
    expect(await db.rpc("lemlist_conversation_get", { p_id: c1 })).toMatchObject({ company_id: ids.gamma });
  });

  test("portail, autre compte et Claude : rien", async () => {
    await db.as("anon");
    await expect(db.rpc("lemlist_clients", {})).rejects.toThrow(/permission denied/);
    await expect(db.rpc("lemlist_company_inbox", { p_company: ids.alpha })).rejects.toThrow(/permission denied/);
    for (const who of ["stranger", "claude"] as const) {
      await db.as(who);
      expect(await db.rpc("lemlist_clients", {})).toEqual([]);
      expect(await db.rpc("lemlist_company_inbox", { p_company: ids.alpha })).toEqual({ conversations: [], accounts: [] });
    }
  });
});
