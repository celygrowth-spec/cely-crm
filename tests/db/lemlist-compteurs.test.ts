// Messages lemlist, lot M4 : compteurs (menu et Aujourd'hui). Vraies migrations, lemlist simulé.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectLemlistAccount } from "@/lib/lemlist/accounts";
import { inboxCounts, loadInbox, openThread, refreshIfStale, sendReply, syncInbox } from "@/lib/lemlist/inbox";
import { createDb, type Db } from "./harness";

const TOKEN_KEY = Buffer.alloc(32, 2).toString("base64");
const KEY = "fake-lemlist-key-AAAA-0001";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

let db: Db;
let sb: SupabaseClient;
let calls: string[];
let hang: boolean;
let convs: Record<string, unknown>[];

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

beforeEach(async () => {
  vi.stubEnv("MAIL_TOKEN_KEY", TOKEN_KEY);
  db = await createDb();
  sb = fakeClient();
  calls = [];
  hang = false;
  convs = [
    // réponse du contact, la plus récente : attend une réponse ; non lue
    { _id: "ibx_1", contactId: "ctc_1", channels: ["email"], lastActivityAt: iso(30), lastRepliedAt: iso(30), haveReplies: true, users: [{ userId: "usr_1", sender: true, read: false }], contact: { _id: "ctc_1", fullName: "Camille" } },
    // réponse du contact, déjà lue chez lemlist : attend quand même une réponse
    { _id: "ibx_2", contactId: "ctc_2", channels: ["linkedin"], lastActivityAt: iso(60), lastRepliedAt: iso(60), haveReplies: true, users: [{ userId: "usr_1", sender: true, read: true }], contact: { _id: "ctc_2", fullName: "Hugo" } },
    // dernier événement : notre message, après la réponse du contact
    { _id: "ibx_3", contactId: "ctc_3", channels: ["email"], lastActivityAt: iso(5), lastRepliedAt: iso(500), haveReplies: true, users: [{ userId: "usr_1", sender: true, read: true }], contact: { _id: "ctc_3", fullName: "Sarah" } },
  ];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    calls.push(`${init.method ?? "GET"} ${u.pathname}`);
    if (hang && u.pathname === "/api/team") return new Promise<Response>(() => {});
    if (u.pathname === "/api/team") return json({ _id: "tea_1", name: "Équipe", userIds: ["usr_1"] });
    if (u.pathname === "/api/inbox") return json({ data: convs, pagination: { nextPage: null } });
    if (u.pathname === "/api/inbox/ctc_1") return json({ data: [
      { _id: "act_in", type: "emailsReplied", createdAt: iso(30), leadId: "lea_1", message: "Oui" },
      { _id: "act_out", type: "emailsSent", createdAt: iso(300), sendUserId: "usr_1", sendUserEmail: "a@x.example.test", sendUserMailboxId: "usm_1", leadId: "lea_1", message: "Offre" },
    ] });
    if (init.method === "POST") return json({ ok: true });
    return new Response("Not found", { status: 404 });
  });
  const company = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Client" }, p_people: [], p_force: true })).id;
  await db.exec("reset role");
  await db.query(`update companies set deal_status = 'won' where id = $1`, [company]);
  await db.as("owner");
  await connectLemlistAccount(sb, { companyId: company, apiKey: KEY });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("compteurs", () => {
  test("non-lus (menu) et conversations qui attendent une réponse (Aujourd'hui)", async () => {
    await syncInbox(sb, { force: true });
    expect(await inboxCounts(sb)).toEqual({ unread: 1, awaiting: 2 });
  });

  test("ouvrir le fil retire le non-lu ; répondre depuis le CRM retire « attend une réponse »", async () => {
    await syncInbox(sb, { force: true });
    const id = (await loadInbox(sb)).conversations.find((c) => c.contact_name === "Camille")!.id;
    await openThread(sb, id);
    expect(await inboxCounts(sb)).toEqual({ unread: 0, awaiting: 2 });
    await sendReply(sb, id, { channel: "email", text: "Merci", key: `k-${crypto.randomUUID()}` });
    expect(await inboxCounts(sb)).toEqual({ unread: 0, awaiting: 1 });
  });

  test("réponse faite dans lemlist : au rafraîchissement suivant, elle ne compte plus", async () => {
    await syncInbox(sb, { force: true });
    convs[1] = { ...convs[1], lastActivityAt: iso(1) };
    await syncInbox(sb, { force: true });
    expect((await inboxCounts(sb)).awaiting).toBe(1);
  });

  test("portail, autre compte et Claude : rien", async () => {
    await syncInbox(sb, { force: true });
    await db.as("anon");
    await expect(db.rpc("lemlist_counts", {})).rejects.toThrow(/permission denied/);
    for (const who of ["stranger", "claude"] as const) {
      await db.as(who);
      expect(await db.rpc("lemlist_counts", {})).toEqual({ unread: 0, awaiting: 0 });
    }
  });
});

describe("actualisation de fond du compteur", () => {
  test("comptes lus il y a moins de 5 minutes : aucun appel à lemlist", async () => {
    await syncInbox(sb, { force: true });
    calls = [];
    await refreshIfStale(sb);
    expect(calls).toEqual([]);
  });

  test("comptes jamais lus ou trop anciens : relus", async () => {
    await refreshIfStale(sb);
    expect(calls).toContain("GET /api/inbox");
    expect((await inboxCounts(sb)).unread).toBe(1);
  });

  test("lemlist ne répond pas : le compteur n'attend pas plus que le délai prévu", async () => {
    hang = true;
    const t0 = Date.now();
    await refreshIfStale(sb, { timeoutMs: 200 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(await inboxCounts(sb)).toEqual({ unread: 0, awaiting: 0 });
  });
});
