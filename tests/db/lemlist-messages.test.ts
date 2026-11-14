// Messages lemlist, lot M2 : liste unifiée et fil. Vraies migrations, lemlist simulé (aucun appel réseau réel).
// Comptes lus séparément (un compte en erreur n'empêche pas les autres), seules les métadonnées sont enregistrées,
// le fil est lu avec la clé du compte de la conversation, non-lus, droits imposés par la base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectLemlistAccount, disconnectLemlistAccount } from "@/lib/lemlist/accounts";
import { loadInbox, messageText, openThread, syncInbox } from "@/lib/lemlist/inbox";
import { createDb, type Db } from "./harness";

const TOKEN_KEY = Buffer.alloc(32, 5).toString("base64");
const KEY_A = "fake-lemlist-key-AAAA-0001";
const KEY_B = "fake-lemlist-key-BBBB-0002";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

type Conv = { _id: string; contactId: string; channels: string[]; lastActivityAt: string; users: { userId: string; sender: boolean; read: boolean }[]; contact: Record<string, string>; haveReplies?: boolean; lastRepliedAt?: string; lastRepliedChannel?: string };
let teams: Record<string, { _id: string; name: string; userIds: string[]; convs: Conv[]; messages: Record<string, unknown[]> }>;
let db: Db;
let sb: SupabaseClient;
let calls: { url: string; key: string }[];
let refused: Set<string>;
let limited: Set<string>;
let alpha: string;
let beta: string;

const keyOf = (auth: string | null) => Buffer.from((auth ?? "").replace(/^Basic /, ""), "base64").toString("utf8").replace(/^:/, "");
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

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
  teams = {
    [KEY_A]: {
      _id: "tea_A", name: "Équipe Alpha", userIds: ["usr_a1", "usr_a2"],
      convs: [
        // suivie par deux membres : une seule conversation ; non lue par l'un d'eux
        { _id: "ibx_A1", contactId: "ctc_A1", channels: ["email"], lastActivityAt: iso(30), users: [{ userId: "usr_a1", sender: true, read: false }, { userId: "usr_a2", sender: true, read: true }], contact: { _id: "ctc_A1", fullName: "Camille Martin", email: "camille@prospect.example.test" }, haveReplies: true, lastRepliedAt: iso(30), lastRepliedChannel: "email" },
        { _id: "ibx_A2", contactId: "ctc_A2", channels: ["linkedin"], lastActivityAt: iso(1500), users: [{ userId: "usr_a2", sender: true, read: true }], contact: { _id: "ctc_A2", fullName: "Hugo Leroy" } },
        { _id: "ibx_A3", contactId: "ctc_A3", channels: ["whatsapp"], lastActivityAt: iso(5), users: [{ userId: "usr_a1", sender: true, read: false }], contact: { _id: "ctc_A3", fullName: "Hors canal" } },
      ],
      messages: {
        ctc_A1: [
          { _id: "act_2", type: "emailsReplied", createdAt: iso(30), fromEmail: "camille@prospect.example.test", subject: "Re: Offre", message: `<div>Oui, intéressée.</div><blockquote class="gmail_quote">Bonjour Camille, ancien texte</blockquote><img src="https://track.example.test/x.png">` },
          { _id: "act_1b", type: "emailsOpened", createdAt: iso(200) },
          { _id: "act_1", type: "emailsSent", createdAt: iso(300), sendUserId: "usr_a1", sendUserName: "Léa Alpha", sendUserEmail: "lea@alpha.example.test", sendUserMailboxId: "usm_a1", subject: "Offre", message: "<p>Bonjour Camille,</p><p>Notre offre.</p>" },
        ],
      },
    },
    [KEY_B]: {
      _id: "tea_B", name: "Équipe Beta", userIds: ["usr_b1"],
      convs: [
        // même contact (même email) que chez Alpha : conversation distincte
        { _id: "ibx_B1", contactId: "ctc_B1", channels: ["email", "linkedin"], lastActivityAt: iso(10), users: [{ userId: "usr_b1", sender: true, read: false }], contact: { _id: "ctc_B1", fullName: "Camille Martin", email: "camille@prospect.example.test" } },
      ],
      messages: { ctc_B1: [{ _id: "act_b1", type: "linkedinReplied", createdAt: iso(10), message: "Pas pour le moment.\nMerci." }] },
    },
  };
  db = await createDb();
  sb = fakeClient();
  calls = [];
  refused = new Set();
  limited = new Set();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const key = keyOf(new Headers(init.headers).get("authorization"));
    calls.push({ url, key });
    const u = new URL(url);
    if (u.origin !== "https://api.lemlist.com") throw new Error("appel inattendu");
    const t = teams[key];
    if (!t || refused.has(key)) return new Response("The authentication you supplied is incorrect", { status: 401 });
    if (limited.has(key)) return new Response("Too many", { status: 429, headers: { "retry-after": "2" } });
    if (u.pathname === "/api/team") return json({ _id: t._id, name: t.name, userIds: t.userIds });
    if (u.pathname === "/api/inbox") {
      const user = u.searchParams.get("userId");
      if (!user || !t.userIds.includes(user)) return new Response("User not in team", { status: 400 });
      const data = t.convs.filter((c) => c.users.some((x) => x.userId === user));
      return json({ data, pagination: { nextPage: null } });
    }
    const m = u.pathname.match(/^\/api\/inbox\/(ctc_\w+)$/);
    if (m) return t.convs.some((c) => c.contactId === m[1]) ? json({ data: t.messages[m[1]] ?? [] }) : new Response("Invalid contactId", { status: 400 });
    return new Response("Not found", { status: 404 });
  });
  alpha = await client("[TEST] Client Alpha");
  beta = await client("[TEST] Client Beta");
  await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
  await connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_B });
  calls = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const accountOf = async (companyId: string) => (await db.one<{ id: string }>(`select id from lemlist_accounts where company_id = $1`, [companyId])).id;

describe("liste unifiée", () => {
  test("conversations des deux comptes mélangées, la plus récente en haut ; email et LinkedIn seulement ; même contact chez deux clients = deux conversations", async () => {
    const results = await syncInbox(sb, { force: true });
    expect(results.every((r) => r.ok)).toBe(true);
    const { conversations, accounts } = await loadInbox(sb);
    expect(conversations.map((c) => [c.contact_name, c.company_name, c.channels, c.unread])).toEqual([
      ["Camille Martin", "[TEST] Client Beta", ["email", "linkedin"], true],
      ["Camille Martin", "[TEST] Client Alpha", ["email"], true],
      ["Hugo Leroy", "[TEST] Client Alpha", ["linkedin"], false],
    ]);
    expect(accounts).toHaveLength(2);
    // chaque compte lu avec SA clé ; Alpha : une liste par membre de l'équipe
    expect(calls.filter((c) => c.key === KEY_A).map((c) => new URL(c.url).pathname + new URL(c.url).search)).toEqual(["/api/team", "/api/inbox?userId=usr_a1&page=1&limit=100", "/api/inbox?userId=usr_a2&page=1&limit=100"]);
    expect(calls.filter((c) => c.key === KEY_B)).toHaveLength(2);
  });

  test("le CRM n'enregistre aucun contenu de message", async () => {
    await syncInbox(sb, { force: true });
    await openThread(sb, (await loadInbox(sb)).conversations.find((c) => c.company_name.includes("Alpha") && c.channels.includes("email"))!.id);
    await db.exec("reset role");
    const dump = JSON.stringify((await db.query(`select * from lemlist_conversations`)).rows);
    expect(dump).not.toMatch(/intéressée|Notre offre|Pas pour le moment|Offre/);
  });

  test("compte limité en débit : les autres s'affichent, message clair sur celui-ci, pas de passage « à reconnecter »", async () => {
    await syncInbox(sb, { force: true });
    limited.add(KEY_A);
    teams[KEY_B].convs[0].lastActivityAt = iso(1);
    const results = await syncInbox(sb, { force: true });
    expect(results.find((r) => r.company_name.includes("Alpha"))).toMatchObject({ ok: false, message: expect.stringMatching(/Limite de requêtes/) });
    expect(results.find((r) => r.company_name.includes("Beta"))).toMatchObject({ ok: true });
    const { conversations, accounts } = await loadInbox(sb);
    expect(conversations).toHaveLength(3); // la liste d'Alpha reste affichée
    expect(accounts.find((a) => a.company_name.includes("Alpha"))).toMatchObject({ status: "connected", last_error: expect.stringMatching(/Limite/) });
  });

  test("clé révoquée : ce compte passe « à reconnecter », l'autre est actualisé normalement", async () => {
    refused.add(KEY_A);
    const results = await syncInbox(sb, { force: true });
    expect(results.find((r) => r.company_name.includes("Alpha"))).toMatchObject({ ok: false });
    expect(results.find((r) => r.company_name.includes("Beta"))).toMatchObject({ ok: true, count: 1 });
    expect((await loadInbox(sb)).accounts.find((a) => a.company_name.includes("Alpha"))?.status).toBe("needs_reconnect");
    // ensuite il n'est plus interrogé jusqu'à sa reconnexion
    calls = [];
    expect((await syncInbox(sb, { force: true })).find((r) => r.company_name.includes("Alpha"))).toMatchObject({ ok: false, skipped: true });
    expect(calls.filter((c) => c.key === KEY_A)).toEqual([]);
  });

  test("actualisation automatique : un compte lu il y a moins d'une minute n'est pas relu ; « Actualiser » relit", async () => {
    await syncInbox(sb, { force: true });
    calls = [];
    expect((await syncInbox(sb)).every((r) => r.skipped)).toBe(true);
    expect(calls).toEqual([]);
    await syncInbox(sb, { force: true });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("fil et non-lus", () => {
  test("fil lu chez lemlist avec la clé du compte de la conversation, dans l'ordre ; citations, images et ouvertures retirées ; rien marqué lu chez lemlist", async () => {
    await syncInbox(sb, { force: true });
    const conv = (await loadInbox(sb)).conversations.find((c) => c.company_name.includes("Alpha") && c.contact_name === "Camille Martin")!;
    calls = [];
    const t = await openThread(sb, conv.id);
    expect(calls).toEqual([{ url: "https://api.lemlist.com/api/inbox/ctc_A1?limit=100", key: KEY_A }]);
    expect(t).toMatchObject({ ok: true, company_name: "[TEST] Client Alpha" });
    expect(t.messages.map((m) => [m.direction, m.channel, m.subject, m.text])).toEqual([
      ["out", "email", "Offre", "Bonjour Camille,\n\nNotre offre."],
      ["in", "email", "Re: Offre", "Oui, intéressée."],
    ]);
    expect(t.messages[0]).toMatchObject({ sender_name: "Léa Alpha", sender_email: "lea@alpha.example.test" });
  });

  test("ouvert dans le CRM : n'est plus non lu ; une nouvelle activité non lue chez lemlist le refait apparaître", async () => {
    await syncInbox(sb, { force: true });
    const id = (await loadInbox(sb)).conversations.find((c) => c.company_name.includes("Beta"))!.id;
    await openThread(sb, id);
    expect((await loadInbox(sb)).conversations.find((c) => c.id === id)?.unread).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    teams[KEY_B].convs[0].lastActivityAt = new Date().toISOString();
    await syncInbox(sb, { force: true });
    expect((await loadInbox(sb)).conversations.find((c) => c.id === id)?.unread).toBe(true);
  });

  test("réponse faite directement dans lemlist : au rafraîchissement suivant, le non-lu disparaît", async () => {
    await syncInbox(sb, { force: true });
    teams[KEY_A].convs[0].users.forEach((u) => (u.read = true));
    teams[KEY_A].convs[0].lastActivityAt = iso(0);
    await syncInbox(sb, { force: true });
    expect((await loadInbox(sb)).conversations.find((c) => c.company_name.includes("Alpha") && c.contact_name === "Camille Martin")?.unread).toBe(false);
  });

  test("LinkedIn : texte brut conservé avec ses retours à la ligne", () => {
    expect(messageText("Pas pour le moment.\nMerci.")).toBe("Pas pour le moment.\nMerci.");
    expect(messageText(`<p>Salut<script>alert(1)</script></p>`)).toBe("Salut");
  });

  test("identifiant manipulé : conversation inconnue ou d'un compte déconnecté refusée, sans appel à lemlist", async () => {
    await syncInbox(sb, { force: true });
    calls = [];
    await expect(openThread(sb, "00000000-0000-4000-8000-000000000123")).rejects.toThrow(/introuvable/);
    await expect(openThread(sb, "pas-un-uuid")).rejects.toThrow();
    const beta1 = (await loadInbox(sb)).conversations.find((c) => c.company_name.includes("Beta"))!.id;
    await disconnectLemlistAccount(sb, await accountOf(beta));
    await expect(openThread(sb, beta1)).rejects.toThrow(/introuvable/);
    expect(calls).toEqual([]);
  });
});

describe("droits et fiche", () => {
  test("portail (anon), autre compte et Claude : aucune conversation, aucune fonction utilisable", async () => {
    await syncInbox(sb, { force: true });
    const id = (await loadInbox(sb)).conversations[0].id;
    for (const who of ["anon", "stranger", "claude"] as const) {
      await db.as(who);
      if (who === "anon") {
        await expect(db.query(`select * from lemlist_conversations`)).rejects.toThrow(/permission denied/);
        await expect(db.rpc("lemlist_inbox", { p_limit: 10 })).rejects.toThrow(/permission denied/);
      } else {
        expect((await db.query(`select * from lemlist_conversations`)).rows).toEqual([]);
        expect(await db.rpc("lemlist_inbox", { p_limit: 10 })).toEqual({ conversations: [], accounts: [] });
        expect(await db.rpc("lemlist_conversation_get", { p_id: id })).toBeNull();
      }
      await expect(db.rpc("lemlist_conversation_seen", { p_id: id })).rejects.toThrow();
      await expect(db.rpc("lemlist_conversations_sync", { p_account: await (async () => { await db.exec("reset role"); const a = await accountOf(alpha); await db.as(who); return a; })(), p_rows: [] })).rejects.toThrow();
    }
  });

  test("fiche à la corbeille : ses conversations disparaissent de Messages et reviennent à la restauration ; déconnexion : retirées", async () => {
    await syncInbox(sb, { force: true });
    const t = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "company", p_id: alpha });
    expect((await loadInbox(sb)).conversations.map((c) => c.company_name)).toEqual(["[TEST] Client Beta"]);
    expect((await syncInbox(sb, { force: true })).map((r) => r.company_name)).toEqual(["[TEST] Client Beta"]);
    await db.rpc("trash_restore", { p_trash: t.trash_id, p_with_parent: false });
    expect((await loadInbox(sb)).conversations).toHaveLength(3);
    await disconnectLemlistAccount(sb, await accountOf(alpha));
    await db.exec("reset role");
    expect(await db.one(`select count(*)::int n from lemlist_conversations where company_id = $1`, [alpha])).toEqual({ n: 0 });
  });

  test("fusion : les conversations suivent la fiche conservée", async () => {
    await syncInbox(sb, { force: true });
    const keep = await client("[TEST] Client conservé");
    await db.rpc("merge_companies", { p_keep: keep, p_merge: beta, p_fields: {}, p_pipeline_from: "keep" });
    expect((await loadInbox(sb)).conversations.filter((c) => c.company_id === keep)).toHaveLength(1);
  });
});
