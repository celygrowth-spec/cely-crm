// Mail, lot M03 : tri des fils. Vraies migrations, Gmail simulé (aucun appel réseau réel), adresses fictives.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, type Db } from "./harness";

process.env.APPOINTMENTS_SECRET = "secret-de-test-0123456789-0123456789-0123456789";
process.env.GOOGLE_MAIL_CLIENT_ID = "client-fictif";
process.env.GOOGLE_MAIL_CLIENT_SECRET = "secret-fictif";
process.env.MAIL_TOKEN_KEY = Buffer.alloc(32, 9).toString("base64");

let db: Db;
/** Client sans session (clé serveur), branché sur la base de test. */
const server = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    await db.as("anon");
    try {
      return { data: await db.rpc(fn, args), error: null };
    } catch (e) {
      return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
    }
  },
} as unknown as SupabaseClient;
vi.mock("@/lib/appointments/server", async (original) => ({ ...(await original<typeof import("@/lib/appointments/server")>()), publicClient: () => server }));

import { serverRpcKey, serverRpcKeyHash } from "@/lib/appointments/secrets";
import { runBoxAction } from "@/lib/mail/box";
import { syncMailbox } from "@/lib/mail/box-sync";
import { applyBoxAction, inFolder } from "@/lib/mail/box-types";
import { encryptSecret } from "@/lib/mail/crypto";
import { GMAIL_MODIFY_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@/lib/mail/google";

let account: string;
type Fake = { id: string; threadId: string; labelIds: string[] };
let box: Map<string, Fake>;
let historyId: number;
let history: { id: string; ids: string[] }[];
let writes: string[];
let fail: ((url: URL, method: string) => Response | null) | null;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

function gmail(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const path = url.pathname.replace("/gmail/v1/users/me", "");
  const failed = fail?.(url, method);
  if (failed) return failed;
  const inThread = (id: string) => [...box.values()].filter((m) => m.threadId === id);
  if (method === "POST") {
    writes.push(path);
    const [, id, op] = path.match(/^\/threads\/([^/]+)\/(modify|trash|untrash)$/) ?? [];
    const ms = id ? inThread(id) : [];
    if (!ms.length) return json({ error: { code: 404 } }, 404);
    const body = JSON.parse(String(init?.body ?? "{}")) as { addLabelIds?: string[]; removeLabelIds?: string[] };
    const add = op === "trash" ? ["TRASH"] : (body.addLabelIds ?? []);
    const remove = op === "trash" ? ["INBOX", "SPAM"] : op === "untrash" ? ["TRASH"] : (body.removeLabelIds ?? []);
    for (const m of ms) m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
    history.push({ id: String(++historyId), ids: ms.map((m) => m.id) });
    return json({ id, messages: ms.map((m) => ({ id: m.id, threadId: id, labelIds: m.labelIds })) });
  }
  if (path === "/profile") return json({ historyId: String(historyId) });
  if (path === "/labels") return json({ labels: [{ id: "INBOX" }, { id: "Label_1" }, { id: "Label_2" }] });
  if (path.startsWith("/labels/")) return json({ id: path.slice(8), name: path.slice(8) === "Label_1" ? "Clients" : path.slice(8), type: path.slice(8).startsWith("Label_") ? "user" : "system" });
  if (path === "/messages") return json({ messages: [...box.values()].map((m) => ({ id: m.id })) });
  if (path.startsWith("/messages/")) {
    const m = box.get(path.slice(10));
    return m ? json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: "", internalDate: "1700000000000", payload: { headers: [{ name: "From", value: "claire@example.test" }, { name: "Subject", value: m.id }] } }) : json({}, 404);
  }
  if (path === "/history") {
    const start = Number(url.searchParams.get("startHistoryId"));
    return json({ historyId: String(historyId), history: history.filter((h) => Number(h.id) > start).map((h) => ({ id: h.id, labelsAdded: h.ids.map((id) => ({ message: { id } })) })) });
  }
  return json({}, 500);
}

/** Session du propriétaire : lecture de ses libellés sous RLS, comme le fait la route. */
function ownerClient(who: "owner" | "stranger" = "owner"): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => { await db.as(who); return { data: await db.rpc(fn, args), error: null }; },
    from: (table: string) => {
      const where: [string, unknown][] = [];
      const q = {
        select: () => q,
        eq: (c: string, v: unknown) => { where.push([c, v]); return q; },
        maybeSingle: async () => {
          await db.as(who);
          const row = await db.one(`select * from ${table} where ${where.map(([c], i) => `${c} = $${i + 1}`).join(" and ")} limit 1`, where.map(([, v]) => v));
          return { data: row ?? null, error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const admin = async <T>(sql: string, p?: unknown[]) => { await db.exec(`reset role;`); return db.one<T>(sql, p); };
const indexed = async (thread: string) => (await admin<{ label_ids: string[] }>(`select label_ids from mailbox_threads where thread_id = $1`, [thread]))?.label_ids ?? null;
const inGmail = (id: string) => [...box.get(id)!.labelIds].sort();
const act = (action: string, thread_ids: string[], extra: Record<string, unknown> = {}) => runBoxAction(ownerClient(), { action, thread_ids, ...extra });
const setScopes = async (scopes: string[]) => { await db.exec(`reset role;`); await db.query(`update mail_accounts set scopes = $1`, [scopes]); };

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: serverRpcKeyHash() });
  await db.exec(`reset role;`);
  account = (await db.one<{ id: string }>(`insert into mail_accounts (email, scopes, status, is_default) values ('moi@example.test', $1, 'connected', true) returning id`, [[GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE, GMAIL_MODIFY_SCOPE]])).id;
  await db.query(`insert into mail_account_secrets (account_id, refresh_token_enc, access_token_enc, access_token_expires_at) values ($1, $2, $3, now() + interval '1 hour')`,
    [account, encryptSecret("renouvellement-fictif", process.env.MAIL_TOKEN_KEY!), encryptSecret("acces-fictif", process.env.MAIL_TOKEN_KEY!)]);
  box = new Map([
    ["a", { id: "a", threadId: "a", labelIds: ["INBOX", "UNREAD"] }],
    ["b1", { id: "b1", threadId: "b", labelIds: ["INBOX"] }],
    ["b2", { id: "b2", threadId: "b", labelIds: ["SENT"] }],
    ["c", { id: "c", threadId: "c", labelIds: ["SPAM"] }],
  ]);
  historyId = 100;
  history = [];
  writes = [];
  fail = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => gmail(input, init)));
  await syncMailbox(server, { id: account, scopes: [GMAIL_MODIFY_SCOPE] }, "acces-fictif");
  writes = [];
});
afterEach(() => vi.unstubAllGlobals());

describe("estimation côté écran", () => {
  test("libellés attendus après chaque action", () => {
    expect(applyBoxAction(["INBOX", "UNREAD"], "archive")).toEqual(["UNREAD"]);
    expect(applyBoxAction(["INBOX", "Label_1"], "trash").sort()).toEqual(["Label_1", "TRASH"]);
    expect(applyBoxAction(["TRASH"], "untrash").sort()).toEqual(["INBOX"]);
    expect(applyBoxAction(["INBOX", "UNREAD"], "read")).toEqual(["INBOX"]);
    expect(applyBoxAction(["INBOX"], "spam")).toEqual(["SPAM"]);
    expect(applyBoxAction(["SPAM"], "unspam")).toEqual(["INBOX"]);
    expect(applyBoxAction(["INBOX"], "move", { label_id: "Label_1", from_label: "INBOX" })).toEqual(["Label_1"]);
    expect(applyBoxAction(["Label_1"], "move", { label_id: "INBOX", from_label: "Label_1" })).toEqual(["INBOX"]);
    expect(applyBoxAction(["INBOX"], "label", { label_id: "Label_1" }).sort()).toEqual(["INBOX", "Label_1"]);
  });
  test("appartenance à un dossier", () => {
    expect(inFolder(["INBOX"], "INBOX")).toBe(true);
    expect(inFolder(["SENT"], "INBOX")).toBe(false);
    expect(inFolder(["SENT"], "ALL")).toBe(true);
    expect(inFolder(["TRASH"], "ALL")).toBe(false);
  });
});

describe("actions répercutées dans Gmail et dans l'index", () => {
  const cases: [string, string, Record<string, unknown>, string[]][] = [
    ["archive", "a", {}, ["UNREAD"]],
    ["trash", "a", {}, ["TRASH", "UNREAD"]],
    ["read", "a", {}, ["INBOX"]],
    ["star", "a", {}, ["INBOX", "STARRED", "UNREAD"]],
    ["important", "a", {}, ["IMPORTANT", "INBOX", "UNREAD"]],
    ["spam", "a", {}, ["SPAM", "UNREAD"]],
    ["unspam", "c", {}, ["INBOX"]],
    ["label", "a", { label_id: "Label_1" }, ["INBOX", "Label_1", "UNREAD"]],
    ["move", "a", { label_id: "Label_1", from_label: "INBOX" }, ["Label_1", "UNREAD"]],
    ["move", "c", { label_id: "INBOX", from_label: "SPAM" }, ["INBOX"]],
  ];
  test.each(cases)("%s sur %s", async (action, id, extra, expected) => {
    expect(await act(action, [id], extra)).toEqual({ done: [id], failed: [] });
    expect(inGmail(id)).toEqual(expected);
    expect(await indexed(id)).toEqual(expected); // sans attendre la synchronisation
  });

  test("actions inverses : non lu, retirer le suivi, non important, retirer un libellé, restaurer de la corbeille", async () => {
    await act("read", ["a"]); await act("unread", ["a"]);
    await act("star", ["a"]); await act("unstar", ["a"]);
    await act("important", ["a"]); await act("unimportant", ["a"]);
    await act("label", ["a"], { label_id: "Label_1" }); await act("unlabel", ["a"], { label_id: "Label_1" });
    expect(await indexed("a")).toEqual(["INBOX", "UNREAD"]);
    await act("trash", ["a"]);
    await act("untrash", ["a"]);
    expect(inGmail("a")).toEqual(["INBOX", "UNREAD"]);
    await act("move", ["a"], { label_id: "Label_2" });
    await act("trash", ["a"]);
    await act("move", ["a"], { label_id: "INBOX", from_label: "TRASH" });
    expect(await indexed("a")).toEqual(["INBOX", "Label_2", "UNREAD"]);
  });

  test("une action porte sur tous les messages du fil, et sur une sélection de fils", async () => {
    expect(await act("label", ["a", "b"], { label_id: "Label_1" })).toMatchObject({ done: expect.arrayContaining(["a", "b"]) });
    expect(inGmail("b1")).toContain("Label_1");
    expect(inGmail("b2")).toContain("Label_1");
    expect(await indexed("b")).toEqual(["INBOX", "Label_1", "SENT"]);
    expect(await indexed("a")).toContain("Label_1");
  });

  test("rejouer la même action (double clic, nouvel essai) ne change rien de plus", async () => {
    await act("archive", ["a"]);
    const once = { gmail: inGmail("a"), index: await indexed("a") };
    await act("archive", ["a"]);
    expect({ gmail: inGmail("a"), index: await indexed("a") }).toEqual(once);
    await Promise.all([act("star", ["b"]), act("star", ["b"])]);
    expect((await indexed("b"))!.filter((l) => l === "STARRED")).toHaveLength(1);
  });

  test("la synchronisation suivante confirme l'état sans rien défaire", async () => {
    await act("spam", ["a"]);
    await syncMailbox(server, { id: account, scopes: [GMAIL_MODIFY_SCOPE] }, "acces-fictif");
    expect(await indexed("a")).toEqual(["SPAM", "UNREAD"]);
  });
});

describe("refus et échecs", () => {
  test("sans l'autorisation de tri : refusé avant tout appel à Gmail", async () => {
    await setScopes([GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE]);
    await expect(act("archive", ["a"])).rejects.toThrow(/Reconnectez Gmail/);
    expect(writes).toEqual([]);
    expect(await indexed("a")).toEqual(["INBOX", "UNREAD"]);
  });

  test("Gmail refuse (autorisation retirée chez Google) : erreur claire, l'index reste tel que Gmail", async () => {
    fail = (_u, method) => (method === "POST" ? json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403) : null);
    await expect(act("archive", ["a", "b"])).rejects.toThrow(/autorisation manquante/);
    expect(await indexed("a")).toEqual(["INBOX", "UNREAD"]);
    expect(inGmail("a")).toEqual(["INBOX", "UNREAD"]);
  });

  test("échec en cours de sélection : ce que Gmail a accepté est reflété, le reste non", async () => {
    let n = 0;
    fail = (_u, method) => (method === "POST" && ++n > 1 ? json({ error: { code: 503 } }, 503) : null);
    await expect(runBoxAction(ownerClient(), { action: "archive", thread_ids: ["a", "b"] })).rejects.toThrow(/injoignable/);
    const [a, b] = [await indexed("a"), await indexed("b")];
    expect([a!.includes("INBOX"), b!.includes("INBOX")].filter(Boolean)).toHaveLength(1);
    expect(a!.includes("INBOX")).toBe(inGmail("a").includes("INBOX"));
  });

  test("fil disparu de Gmail : signalé, les autres sont traités", async () => {
    expect(await act("read", ["a", "inconnu"])).toEqual({ done: ["a"], failed: ["inconnu"] });
  });

  test("demandes manipulées : action inconnue, libellé système ou inconnu, identifiant invalide, sélection trop grande", async () => {
    await expect(act("delete_forever", ["a"])).rejects.toThrow();
    await expect(act("label", ["a"])).rejects.toThrow(/Choisissez un libellé/);
    await expect(act("label", ["a"], { label_id: "TRASH" })).rejects.toThrow(/ne peut pas être choisi/);
    await expect(act("move", ["a"], { label_id: "SPAM" })).rejects.toThrow(/ne peut pas être choisi/);
    await expect(act("label", ["a"], { label_id: "Label_999" })).rejects.toThrow(/introuvable/);
    await expect(act("archive", ["a/../../labels"])).rejects.toThrow();
    await expect(act("archive", Array.from({ length: 51 }, (_, i) => `t${i}`))).rejects.toThrow(/50 fils/);
    await expect(act("archive", [])).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  test("la mise à jour de l'index exige la clé serveur, quel que soit le compte", async () => {
    for (const who of ["owner", "stranger", "claude", "anon"] as const) {
      await db.as(who);
      await expect(db.rpc("mailbox_set_labels", { p_server_key: "mauvaise-cle-0123456789abcdef0123456789", p_account: account, p_messages: [{ id: "a", label_ids: [] }] }), who).rejects.toThrow(/Accès refusé/);
    }
    await db.as("anon");
    expect(await db.rpc("mailbox_set_labels", { p_server_key: serverRpcKey(), p_account: account, p_messages: [{ id: "a", label_ids: ["X"] }, { id: "inconnu", label_ids: [] }] })).toBe(1);
    expect(await indexed("a")).toEqual(["X"]);
  });
});
