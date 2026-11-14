// Messages lemlist, lot M3 : réponses. Vraies migrations, lemlist simulé : aucun envoi réel, aucune vraie clé.
// Même canal, compte et expéditeur de la conversation retrouvés par le serveur ; un seul envoi par clé (double clic) ;
// échec certain → réessai possible ; résultat inconnu → « incertain », jamais « envoyé » ; jamais la clé d'un autre compte.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectLemlistAccount } from "@/lib/lemlist/accounts";
import { loadInbox, openThread, sendReply, syncInbox } from "@/lib/lemlist/inbox";
import { createDb, type Db } from "./harness";

const TOKEN_KEY = Buffer.alloc(32, 3).toString("base64");
const KEY_A = "fake-lemlist-key-AAAA-0001";
const KEY_B = "fake-lemlist-key-BBBB-0002";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

let db: Db;
let sb: SupabaseClient;
let posts: { path: string; key: string; body: Record<string, unknown> }[];
let sendMode: "ok" | "error" | "network" | "refused";
let alpha: string;
let beta: string;

const TEAMS: Record<string, { _id: string; userIds: string[]; convs: unknown[]; messages: Record<string, unknown[]> }> = {
  [KEY_A]: {
    _id: "tea_A", userIds: ["usr_a1", "usr_a2"],
    convs: [{ _id: "ibx_A1", contactId: "ctc_A1", channels: ["email"], lastActivityAt: iso(30), users: [{ userId: "usr_a1", sender: true, read: false }], contact: { _id: "ctc_A1", fullName: "Camille Martin", email: "camille@prospect.example.test" } }],
    messages: {
      ctc_A1: [
        { _id: "act_A1_in", type: "emailsReplied", createdAt: iso(30), fromEmail: "camille@prospect.example.test", leadId: "lea_A1", message: "<p>Oui</p>" },
        { _id: "act_A1_out", type: "emailsSent", createdAt: iso(300), sendUserId: "usr_a2", sendUserName: "Marc Alpha", sendUserEmail: "marc@alpha.example.test", sendUserMailboxId: "usm_a2", leadId: "lea_A1", subject: "Offre", message: "<p>Offre</p>" },
      ],
    },
  },
  [KEY_B]: {
    _id: "tea_B", userIds: ["usr_b1"],
    convs: [{ _id: "ibx_B1", contactId: "ctc_B1", channels: ["linkedin"], lastActivityAt: iso(10), users: [{ userId: "usr_b1", sender: true, read: false }], contact: { _id: "ctc_B1", fullName: "Paul Bernard" } }],
    messages: {
      ctc_B1: [
        { _id: "act_B1_in", type: "linkedinReplied", createdAt: iso(10), leadId: "lea_B1", message: "Quel tarif ?" },
        { _id: "act_B1_out", type: "linkedinSent", createdAt: iso(900), sendUserId: "usr_b1", sendUserName: "Nora Beta", leadId: "lea_B1", message: "Bonjour Paul" },
      ],
    },
  },
};

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
  db = await createDb();
  sb = fakeClient();
  posts = [];
  sendMode = "ok";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const key = keyOf(new Headers(init.headers).get("authorization"));
    const u = new URL(url);
    if (u.origin !== "https://api.lemlist.com") throw new Error("appel inattendu");
    const t = TEAMS[key];
    if (!t) return new Response("The authentication you supplied is incorrect", { status: 401 });
    if (init.method === "POST") {
      posts.push({ path: u.pathname, key, body: JSON.parse(String(init.body)) });
      if (sendMode === "network") throw new TypeError("fetch failed");
      if (sendMode === "error") return new Response("Failed to send email", { status: 400 });
      if (sendMode === "refused") return new Response("The authentication you supplied is incorrect", { status: 401 });
      return json({ ok: true });
    }
    if (u.pathname === "/api/team") return json({ _id: t._id, name: t._id, userIds: t.userIds });
    if (u.pathname === "/api/inbox") return json({ data: t.convs, pagination: { nextPage: null } });
    const m = u.pathname.match(/^\/api\/inbox\/(ctc_\w+)$/);
    if (m && t.messages[m[1]]) return json({ data: t.messages[m[1]] });
    return new Response("Invalid contactId", { status: 400 });
  });
  alpha = await client("[TEST] Client Alpha");
  beta = await client("[TEST] Client Beta");
  await connectLemlistAccount(sb, { companyId: alpha, apiKey: KEY_A });
  await connectLemlistAccount(sb, { companyId: beta, apiKey: KEY_B });
  await syncInbox(sb, { force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const convOf = async (companyId: string) => (await loadInbox(sb)).conversations.find((c) => c.company_id === companyId)!.id;
const key = () => `k-${crypto.randomUUID()}`;
const replies = async () => { await db.exec("reset role"); const r = (await db.query<Record<string, unknown>>(`select * from lemlist_replies order by created_at`)).rows; await db.as("owner"); return r; };

describe("envoi", () => {
  test("email : même canal, compte et expéditeur de la conversation (boîte comprise), dans le fil existant ; aucun texte gardé au CRM", async () => {
    const id = await convOf(alpha);
    const view = await openThread(sb, id);
    expect(view.reply_from).toEqual({ email: { name: "Marc Alpha", email: "marc@alpha.example.test" }, linkedin: { name: null } });
    const r = await sendReply(sb, id, { channel: "email", text: "Merci Camille,\nje vous appelle demain <b>sans faute</b>.", key: key() });
    expect(r).toEqual({ status: "sent", duplicate: false, message: null });
    expect(posts).toEqual([{ path: "/api/inbox/email", key: KEY_A, body: {
      sendUserId: "usr_a2", sendUserEmail: "marc@alpha.example.test", sendUserMailboxId: "usm_a2", contactId: "ctc_A1",
      message: "<p>Merci Camille,<br>je vous appelle demain &lt;b&gt;sans faute&lt;/b&gt;.</p>", replyToActivityId: "act_A1_in",
    } }]);
    const rows = await replies();
    expect(rows).toMatchObject([{ status: "sent", channel: "email", company_id: alpha }]);
    expect(JSON.stringify(rows)).not.toMatch(/Camille|sans faute/);
  });

  test("LinkedIn : expéditeur et lead tirés du fil, avec la clé du compte Beta", async () => {
    const r = await sendReply(sb, await convOf(beta), { channel: "linkedin", text: "Je vous envoie le tarif.", key: key() });
    expect(r.status).toBe("sent");
    expect(posts).toEqual([{ path: "/api/inbox/linkedin", key: KEY_B, body: { sendUserId: "usr_b1", leadId: "lea_B1", contactId: "ctc_B1", message: "Je vous envoie le tarif." } }]);
  });

  test("double clic : la même clé envoyée deux fois en même temps ne part qu'une fois", async () => {
    const id = await convOf(alpha);
    const k = key();
    const [a, b] = await Promise.all([
      sendReply(sb, id, { channel: "email", text: "Bonjour", key: k }),
      sendReply(sb, id, { channel: "email", text: "Bonjour", key: k }),
    ]);
    expect(posts).toHaveLength(1);
    expect([a.duplicate, b.duplicate].sort()).toEqual([false, true]);
    // et rejouée après coup : toujours un seul envoi
    expect(await sendReply(sb, id, { channel: "email", text: "Bonjour", key: k })).toMatchObject({ status: "sent", duplicate: true });
    expect(posts).toHaveLength(1);
  });

  test("échec certain (refus de lemlist) : « failed », message clair ; un nouvel essai part normalement", async () => {
    const id = await convOf(alpha);
    sendMode = "error";
    expect(await sendReply(sb, id, { channel: "email", text: "Bonjour", key: key() })).toMatchObject({ status: "failed", message: expect.stringMatching(/n'est pas partie/) });
    sendMode = "ok";
    expect(await sendReply(sb, id, { channel: "email", text: "Bonjour", key: key() })).toMatchObject({ status: "sent" });
    expect((await replies()).map((r) => r.status)).toEqual(["failed", "sent"]);
  });

  test("lemlist ne répond pas : « incertain », jamais « envoyé » ; la même clé ne repart pas", async () => {
    const id = await convOf(alpha);
    const k = key();
    sendMode = "network";
    expect(await sendReply(sb, id, { channel: "email", text: "Bonjour", key: k })).toMatchObject({ status: "uncertain", message: expect.stringMatching(/vérifier/) });
    sendMode = "ok";
    expect(await sendReply(sb, id, { channel: "email", text: "Bonjour", key: k })).toMatchObject({ status: "uncertain", duplicate: true });
    expect(posts).toHaveLength(1);
  });

  test("clé révoquée au moment d'envoyer : « failed » et compte « à reconnecter » ; ensuite plus aucun envoi", async () => {
    const id = await convOf(alpha);
    sendMode = "refused";
    expect(await sendReply(sb, id, { channel: "email", text: "Bonjour", key: key() })).toMatchObject({ status: "failed" });
    expect((await loadInbox(sb)).accounts.find((a) => a.company_id === alpha)?.status).toBe("needs_reconnect");
    posts = [];
    await expect(sendReply(sb, id, { channel: "email", text: "Bonjour", key: key() })).rejects.toThrow(/reconnecter/);
    expect(posts).toEqual([]);
  });

  test("canal absent de la conversation, texte vide ou trop long : refus, rien n'est envoyé", async () => {
    const id = await convOf(alpha);
    await expect(sendReply(sb, id, { channel: "linkedin", text: "Bonjour", key: key() })).rejects.toThrow(/pas lieu sur ce canal/);
    await expect(sendReply(sb, id, { channel: "email", text: "   ", key: key() })).rejects.toThrow();
    await expect(sendReply(sb, id, { channel: "email", text: "x".repeat(5001), key: key() })).rejects.toThrow();
    expect(posts).toEqual([]);
  });
});

describe("cloisonnement des comptes", () => {
  test("une réponse ne part jamais avec la clé d'un autre compte : le compte vient de la conversation, pas de la requête", async () => {
    const a = await convOf(alpha);
    const b = await convOf(beta);
    await sendReply(sb, b, { channel: "linkedin", text: "Pour Beta", key: key() });
    await sendReply(sb, a, { channel: "email", text: "Pour Alpha", key: key() });
    expect(posts.map((p) => [p.path, p.key])).toEqual([["/api/inbox/linkedin", KEY_B], ["/api/inbox/email", KEY_A]]);
    // champs manipulés ajoutés à l'appel : ignorés par le service (et refusés par la route, .strict())
    await sendReply(sb, b, { channel: "linkedin", text: "Encore", key: key(), accountId: "x", apiKey: KEY_A } as never);
    expect(posts.at(-1)?.key).toBe(KEY_B);
  });

  test("clé d'envoi d'une conversation réutilisée sur une autre : refus", async () => {
    const k = key();
    await sendReply(sb, await convOf(alpha), { channel: "email", text: "Bonjour", key: k });
    await expect(sendReply(sb, await convOf(beta), { channel: "linkedin", text: "Bonjour", key: k })).rejects.toThrow(/déjà utilisée/);
    expect(posts).toHaveLength(1);
  });

  test("identifiant de conversation inconnu : refus sans appel à lemlist", async () => {
    await expect(sendReply(sb, "00000000-0000-4000-8000-000000000777", { channel: "email", text: "Bonjour", key: key() })).rejects.toThrow(/introuvable/);
    expect(posts).toEqual([]);
  });

  test("portail (anon), autre compte et Claude : ni réservation d'envoi, ni lecture des envois", async () => {
    const id = await convOf(alpha);
    await sendReply(sb, id, { channel: "email", text: "Bonjour", key: key() });
    for (const who of ["anon", "stranger", "claude"] as const) {
      await db.as(who);
      await expect(db.rpc("lemlist_reply_claim", { p_conversation: id, p_channel: "email", p_key: key() })).rejects.toThrow();
      if (who === "anon") await expect(db.query(`select * from lemlist_replies`)).rejects.toThrow(/permission denied/);
      else expect((await db.query(`select * from lemlist_replies`)).rows).toEqual([]);
    }
  });
});
