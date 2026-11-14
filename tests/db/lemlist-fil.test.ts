// Messages lemlist : le fil affiche les messages reçus comme les envoyés, email et LinkedIn. Vraies migrations,
// lemlist simulé (aucune vraie clé, aucun envoi). Défaut corrigé : les réponses LinkedIn du contact n'apparaissaient
// pas (le fil n'était lu que tel que l'équipe le voit, et un message au format imprévu était écarté sans bruit).
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { connectLemlistAccount } from "@/lib/lemlist/accounts";
import { loadInbox, openThread, syncInbox, toThreadMessage } from "@/lib/lemlist/inbox";
import { createDb, type Db } from "./harness";

const TOKEN_KEY = Buffer.alloc(32, 6).toString("base64");
const KEY = "fake-lemlist-key-FFFF-0001";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();

let db: Db;
let sb: SupabaseClient;
let calls: string[];
/** fil tel que l'équipe le voit (sans userId) et tel que le voit le membre (avec userId) */
let teamView: Record<string, unknown>[];
let memberView: Record<string, unknown>[] | "bad_request" | "refused";

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

const page = (list: Record<string, unknown>[], u: URL) => {
  const skip = Number(u.searchParams.get("skip") ?? 0);
  const limit = Number(u.searchParams.get("limit") ?? 100);
  return json({ data: list.slice(skip, skip + limit) });
};

beforeEach(async () => {
  vi.stubEnv("MAIL_TOKEN_KEY", TOKEN_KEY);
  db = await createDb();
  sb = fakeClient();
  calls = [];
  // conversation LinkedIn : deux messages envoyés vus par l'équipe…
  teamView = [
    { _id: "act_out2", type: "linkedinSent", createdAt: iso(60), sendUserId: "usr_1", sendUserName: "Expéditeur", leadId: "lea_1", message: "Relance" },
    { _id: "act_out1", type: "linkedinSent", createdAt: iso(300), sendUserId: "usr_1", sendUserName: "Expéditeur", leadId: "lea_1", message: "Bonjour" },
  ];
  // … et les réponses du contact, synchronisées depuis la boîte LinkedIn du membre
  memberView = [
    { _id: "act_in2", type: "linkedinReplied", createdAt: iso(30), message: "ok" },
    { _id: "act_out2", type: "linkedinSent", createdAt: iso(60), sendUserId: "usr_1", sendUserName: "Expéditeur", leadId: "lea_1", message: "Relance" },
    { _id: "act_in1", type: "linkedinReplied", createdAt: iso(200), leadId: "lea_1", message: "Avec plaisir" },
    { _id: "act_out1", type: "linkedinSent", createdAt: iso(300), sendUserId: "usr_1", sendUserName: "Expéditeur", leadId: "lea_1", message: "Bonjour" },
  ];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.origin !== "https://api.lemlist.com" || (init.method ?? "GET") !== "GET") throw new Error("appel inattendu");
    calls.push(`${u.pathname}${u.search}`);
    if (u.pathname === "/api/team") return json({ _id: "tea_1", name: "Équipe", userIds: ["usr_1"] });
    if (u.pathname === "/api/inbox") return json({ data: [{ _id: "ibx_1", contactId: "ctc_1", channels: ["linkedin"], lastActivityAt: iso(30), lastRepliedAt: iso(30), haveReplies: true, users: [{ userId: "usr_1", sender: true, read: false }], contact: { _id: "ctc_1", fullName: "Contact simulé" } }], pagination: { nextPage: null } });
    if (u.pathname === "/api/inbox/ctc_1") {
      if (!u.searchParams.get("userId")) return page(teamView, u);
      if (memberView === "bad_request") return new Response("Invalid userId", { status: 400 });
      if (memberView === "refused") return new Response("The authentication you supplied is incorrect", { status: 401 });
      return page(memberView, u);
    }
    return new Response("Not found", { status: 404 });
  });
  const company = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Client" }, p_people: [], p_force: true })).id;
  await db.exec("reset role");
  await db.query(`update companies set deal_status = 'won' where id = $1`, [company]);
  await db.as("owner");
  await connectLemlistAccount(sb, { companyId: company, apiKey: KEY });
  await syncInbox(sb, { force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const conversationId = async () => (await loadInbox(sb)).conversations[0].id;
const shown = (t: Awaited<ReturnType<typeof openThread>>) => t.messages.map((m) => [m.direction, m.channel, m.text]);

describe("fil d'une conversation LinkedIn", () => {
  test("les réponses reçues du contact apparaissent, à leur place chronologique, sans doublon", async () => {
    const t = await openThread(sb, await conversationId());
    expect(t.ok).toBe(true);
    expect(shown(t)).toEqual([
      ["out", "linkedin", "Bonjour"],
      ["in", "linkedin", "Avec plaisir"],
      ["out", "linkedin", "Relance"],
      ["in", "linkedin", "ok"],
    ]);
    // lu tel que le voit le membre qui suit la conversation (usr_1), en plus de la vue de l'équipe
    expect(calls).toContain("/api/inbox/ctc_1?limit=100&skip=0&userId=usr_1");
    expect(calls).toContain("/api/inbox/ctc_1?limit=100&skip=0");
  });

  test("réponses présentes dans la vue de l'équipe : affichées aussi", async () => {
    teamView = memberView as Record<string, unknown>[];
    memberView = [];
    expect(shown(await openThread(sb, await conversationId())).filter((m) => m[0] === "in")).toHaveLength(2);
  });

  test("lecture par membre refusée par lemlist (requête) : le fil de l'équipe reste affiché", async () => {
    memberView = "bad_request";
    const t = await openThread(sb, await conversationId());
    expect(t.ok).toBe(true);
    expect(shown(t)).toEqual([["out", "linkedin", "Bonjour"], ["out", "linkedin", "Relance"]]);
  });

  test("clé refusée : erreur honnête, compte à reconnecter", async () => {
    memberView = "refused";
    const t = await openThread(sb, await conversationId());
    expect(t.ok).toBe(false);
    expect((await loadInbox(sb)).accounts[0].status).toBe("needs_reconnect");
  });

  test("fil long : toutes les pages sont lues (messages antérieurs compris)", async () => {
    const opens = Array.from({ length: 150 }, (_, i) => ({ _id: `act_open${i}`, type: "linkedinOpened", createdAt: iso(100 + i) }));
    memberView = [...opens, { _id: "act_old", type: "linkedinReplied", createdAt: iso(5000), message: "Ancienne réponse" }];
    const t = await openThread(sb, await conversationId());
    expect(calls).toContain("/api/inbox/ctc_1?limit=100&skip=100&userId=usr_1");
    expect(shown(t)[0]).toEqual(["in", "linkedin", "Ancienne réponse"]);
  });
});

describe("lecture d'un message lemlist", () => {
  const base = { createdAt: iso(1) };
  test("email et LinkedIn, reçus et envoyés", () => {
    expect(toThreadMessage({ ...base, _id: "a", type: "emailsReplied", message: "<p>Oui</p>", fromEmail: "x@example.test" })).toMatchObject({ direction: "in", channel: "email", text: "Oui" });
    expect(toThreadMessage({ ...base, _id: "b", type: "emailsSent", message: "Bonjour" })).toMatchObject({ direction: "out", channel: "email" });
    expect(toThreadMessage({ ...base, _id: "c", type: "linkedinReplied", message: "ok" })).toMatchObject({ direction: "in", channel: "linkedin", text: "ok" });
    expect(toThreadMessage({ ...base, _id: "d", type: "linkedinVoiceNoteReplied" })).toMatchObject({ direction: "in", channel: "linkedin" });
    expect(toThreadMessage({ ...base, _id: "e", type: "linkedinInMailSent", message: "InMail" })).toMatchObject({ direction: "out" });
  });

  test("variantes de format : identifiant `id`, texte dans `body` ou `text`, date `sentAt`", () => {
    expect(toThreadMessage({ id: "f", type: "linkedinReplied", sentAt: iso(2), text: "Merci" })).toMatchObject({ id: "f", direction: "in", text: "Merci" });
    expect(toThreadMessage({ ...base, _id: "g", type: "linkedinReplied", body: "Oui" })).toMatchObject({ text: "Oui" });
  });

  test("message reçu sans texte lisible : affiché quand même, jamais écarté en silence", () => {
    expect(toThreadMessage({ ...base, _id: "h", type: "linkedinReplied", attachments: [{}] } as never)).toMatchObject({ direction: "in", text: "" });
  });

  test("ce qui n'est pas un message échangé reste ignoré", () => {
    for (const type of ["emailsOpened", "emailsClicked", "linkedinInviteAccepted", "linkedinVisitDone", "linkedinSendFailed", "whatsappReplied"]) {
      expect(toThreadMessage({ ...base, _id: "i", type, message: "x" })).toBeNull();
    }
  });
});
