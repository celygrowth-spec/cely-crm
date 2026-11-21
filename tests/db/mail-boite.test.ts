// Mail, lot M01 : index de toute la boîte Gmail. Vraies migrations, Gmail simulé (aucun appel réseau réel),
// adresses fictives en example.test.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { serverRpcKey, serverRpcKeyHash } from "@/lib/appointments/secrets";
import { syncMailbox } from "@/lib/mail/box-sync";
import { parseAddresses, toBoxMessage } from "@/lib/mail/gmail-box";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@/lib/mail/google";
import { createDb, type Db } from "./harness";

process.env.APPOINTMENTS_SECRET = "secret-de-test-0123456789-0123456789-0123456789";

let db: Db;
let sb: SupabaseClient;
let account: string;
let KEY: string;

// --- Gmail simulé -----------------------------------------------------------------------------------------------
type Fake = { id: string; threadId: string; labelIds: string[]; subject: string; from: string; date: number; file?: boolean };
let box: Map<string, Fake>;
let history: { id: string; messagesAdded?: string[]; messagesDeleted?: string[]; labelsAdded?: string[]; labelsRemoved?: string[] }[];
let historyId: number;
let oldestHistory: number;
let calls: string[];
let failNext: ((url: URL) => Response | null) | null;
let pageSize: number;
let historyPage: number;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const add = (m: Partial<Fake> & { id: string }) => {
  const full: Fake = { threadId: m.id, labelIds: ["INBOX", "UNREAD"], subject: `Objet ${m.id}`, from: "Claire Test <claire@example.test>", date: 1_700_000_000_000 + box.size * 1000, ...m };
  box.set(full.id, full);
  history.push({ id: String(++historyId), messagesAdded: [full.id] });
  return full;
};
const relabel = (id: string, labels: string[]) => {
  box.get(id)!.labelIds = labels;
  history.push({ id: String(++historyId), labelsAdded: [id] });
};
const remove = (id: string) => {
  box.delete(id);
  history.push({ id: String(++historyId), messagesDeleted: [id] });
};

function gmail(input: string | URL | Request): Response {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  const failed = failNext?.(url);
  if (failed) return failed;
  const path = url.pathname.replace("/gmail/v1/users/me", "");
  if (path === "/profile") return json({ historyId: String(historyId) });
  if (path === "/labels") return json({ labels: [{ id: "INBOX" }, { id: "SPAM" }, { id: "Label_1" }] });
  if (path.startsWith("/labels/")) {
    const id = path.slice(8);
    const inLabel = [...box.values()].filter((m) => m.labelIds.includes(id));
    return json({ id, name: id === "Label_1" ? "Clients" : id, type: id.startsWith("Label_") ? "user" : "system", messagesTotal: inLabel.length,
      messagesUnread: inLabel.filter((m) => m.labelIds.includes("UNREAD")).length, threadsTotal: new Set(inLabel.map((m) => m.threadId)).size, threadsUnread: 0 });
  }
  if (path === "/messages") {
    const all = [...box.values()].sort((a, b) => b.date - a.date).map((m) => ({ id: m.id }));
    const from = Number(url.searchParams.get("pageToken") ?? 0);
    const next = from + pageSize < all.length ? String(from + pageSize) : undefined;
    return json({ messages: all.slice(from, from + pageSize), nextPageToken: next });
  }
  if (path.startsWith("/messages/")) {
    const m = box.get(path.slice(10));
    if (!m) return json({ error: { code: 404 } }, 404);
    return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, snippet: `Extrait ${m.id}`, internalDate: String(m.date), sizeEstimate: 1234,
      payload: { headers: [{ name: "From", value: m.from }, { name: "To", value: "moi@example.test" }, { name: "Subject", value: m.subject }, { name: "Message-ID", value: `<${m.id}@example.test>` }],
        parts: m.file ? [{ mimeType: "text/plain", filename: "" }, { mimeType: "application/pdf", filename: "devis.pdf" }] : [] } });
  }
  if (path === "/history") {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (start < oldestHistory) return json({ error: { code: 404 } }, 404);
    const ref = (ids?: string[]) => ids?.map((id) => ({ message: { id } }));
    const after = history.filter((h) => Number(h.id) > start);
    const max = Math.min(historyPage, Number(url.searchParams.get("maxResults") ?? 100));
    return json({ historyId: String(historyId), nextPageToken: after.length > max ? "suite" : undefined, history: after.slice(0, max).map((h) => ({ id: h.id, messagesAdded: ref(h.messagesAdded), messagesDeleted: ref(h.messagesDeleted), labelsAdded: ref(h.labelsAdded), labelsRemoved: ref(h.labelsRemoved) })) });
  }
  return json({}, 500);
}

/** Client sans session, comme le passage planifié : seules les fonctions à clé serveur lui sont ouvertes. */
function serverClient(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      await db.as("anon");
      try {
        return { data: await db.rpc(fn, args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
  } as unknown as SupabaseClient;
}

const sync = (budgetMs = 30_000, scopes = [GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE]) => syncMailbox(sb, { id: account, scopes }, "jeton-de-test", { budgetMs });
const admin = async <T>(sql: string, p?: unknown[]) => {
  await db.exec(`reset role;`);
  return db.one<T>(sql, p);
};
const count = async (table: string) => (await admin<{ n: number }>(`select count(*)::int n from ${table}`)).n;
const state = () => admin<{ history_id: string | null; generation: number; backfill_token: string | null; backfill_done_at: string | null; error_code: string | null; last_error: string | null; locked_until: string | null }>(`select * from mailbox_sync`);
const thread = (id: string) => admin<{ subject: string; snippet: string; message_count: number; label_ids: string[]; unread: boolean; starred: boolean; important: boolean; has_attachments: boolean; participants: string[] }>(`select * from mailbox_threads where thread_id = $1`, [id]);

beforeEach(async () => {
  db = await createDb();
  KEY = serverRpcKey();
  await db.rpc("appt_register_server_key", { p_hash: serverRpcKeyHash() });
  await db.exec(`reset role;`);
  account = (await db.one<{ id: string }>(`insert into mail_accounts (email, scopes, status, is_default) values ('moi@example.test', '{}', 'connected', true) returning id`)).id;
  sb = serverClient();
  box = new Map();
  history = [];
  historyId = 1000;
  oldestHistory = 0;
  calls = [];
  failNext = null;
  pageSize = 100;
  historyPage = 100;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => gmail(input)));
});
afterEach(() => vi.unstubAllGlobals());

describe("lecture d'un message Gmail", () => {
  test("adresses : nom entre guillemets avec virgule, adresse seule, entrée invalide ignorée", () => {
    expect(parseAddresses('"Test, Claire" <Claire@Example.test>, paul@example.test, pas-une-adresse')).toEqual([
      { name: "Test, Claire", email: "claire@example.test" }, { name: null, email: "paul@example.test" }]);
  });
  test("pièce jointe repérée dans une structure imbriquée, extrait décodé, date absente tolérée", () => {
    const m = toBoxMessage({ id: "a", snippet: "l&#39;offre &amp; la suite", payload: { headers: [{ name: "SUBJECT", value: "Bonjour" }], parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", filename: "" }] }, { mimeType: "multipart/mixed", parts: [{ filename: "plan.pdf" }] }] } });
    expect(m).toMatchObject({ thread_id: "a", subject: "Bonjour", snippet: "l'offre & la suite", has_attachments: true, from_email: null });
  });
});

describe("synchronisation complète", () => {
  test("toute la boîte est indexée : boîte de réception, envoyés, brouillons, spam, corbeille, libellés et catégories", async () => {
    add({ id: "m1" });
    add({ id: "m2", labelIds: ["SENT"] });
    add({ id: "m3", labelIds: ["DRAFT"] });
    add({ id: "m4", labelIds: ["SPAM", "UNREAD"] });
    add({ id: "m5", labelIds: ["TRASH"] });
    add({ id: "m6", labelIds: ["INBOX", "Label_1", "CATEGORY_PROMOTIONS", "STARRED", "IMPORTANT"], file: true });
    const r = await sync();
    expect(r).toMatchObject({ mode: "initiale", ajoutes_ou_modifies: 6, lecture_complete_terminee: true, a_suivre: false });
    expect(await count("mailbox_messages")).toBe(6);
    expect(await count("mailbox_threads")).toBe(6);
    expect(calls.some((c) => c.includes("includeSpamTrash=true"))).toBe(true);
    expect(await thread("m6")).toMatchObject({ unread: false, starred: true, important: true, has_attachments: true, participants: ["Claire Test"] });
    expect((await thread("m4")).unread).toBe(true);
    expect(await admin(`select name, kind, messages_total, messages_unread from mailbox_labels where label_id = 'Label_1'`)).toEqual({ name: "Clients", kind: "user", messages_total: 1, messages_unread: 0 });
    expect(await admin(`select messages_total, messages_unread from mailbox_labels where label_id = 'SPAM'`)).toEqual({ messages_total: 1, messages_unread: 1 });
    expect(await state()).toMatchObject({ history_id: "1006", error_code: null, last_error: null, locked_until: null });
  });

  test("un fil réunit ses messages : objet du premier, extrait du dernier, libellés réunis", async () => {
    add({ id: "a1", threadId: "t1", labelIds: ["SENT"], subject: "Proposition", from: "moi@example.test" });
    add({ id: "a2", threadId: "t1", labelIds: ["INBOX", "UNREAD"], subject: "Re: Proposition" });
    await sync();
    expect(await thread("t1")).toMatchObject({ subject: "Proposition", snippet: "Extrait a2", message_count: 2, label_ids: ["INBOX", "SENT", "UNREAD"], unread: true });
    expect((await thread("t1")).participants.sort()).toEqual(["Claire Test", "moi@example.test"]);
  });

  test("coupure en cours de lecture : le passage suivant reprend au lot suivant, sans doublon", async () => {
    for (let i = 0; i < 7; i++) add({ id: `m${i}` });
    pageSize = 3;
    // temps imparti nul : un seul lot ne part même pas, mais le repère de départ est pris
    await sync(0);
    expect(await count("mailbox_messages")).toBe(0);
    expect(await state()).toMatchObject({ history_id: "1007", generation: 1, backfill_done_at: null });
    // panne Gmail au deuxième lot
    let lists = 0;
    failNext = (u) => (u.pathname.endsWith("/messages") && ++lists === 2 ? json({ error: { code: 503 } }, 503) : null);
    await expect(sync()).rejects.toThrow(/injoignable/);
    expect(await count("mailbox_messages")).toBe(3);
    expect(await state()).toMatchObject({ backfill_token: "3", error_code: "network", locked_until: null });
    failNext = null;
    calls = [];
    const r = await sync();
    expect(r).toMatchObject({ lecture_complete_terminee: true });
    expect(await count("mailbox_messages")).toBe(7);
    expect(calls.filter((c) => c.startsWith("/gmail/v1/users/me/messages?")).every((c) => c.includes("pageToken="))).toBe(true); // repris, pas recommencé
    expect(await state()).toMatchObject({ generation: 1, error_code: null, last_error: null });
    expect((await state()).backfill_done_at).not.toBeNull();
  });

  test("un message arrivé pendant la première lecture est rejoué ensuite", async () => {
    for (let i = 0; i < 4; i++) add({ id: `m${i}` });
    pageSize = 2;
    let lists = 0;
    failNext = (u) => {
      if (u.pathname.endsWith("/messages") && ++lists === 2) add({ id: "nouveau", date: 1 }); // le plus ancien : la liste en cours ne le verra pas en tête
      return null;
    };
    await sync();
    failNext = null;
    await sync();
    expect(await count("mailbox_messages")).toBe(5);
  });
});

describe("synchronisation incrémentale", () => {
  beforeEach(async () => {
    add({ id: "m1" });
    add({ id: "m2", threadId: "t2" });
    add({ id: "m3", threadId: "t2" });
    await sync();
    calls = [];
  });

  test("lu, suivi, archivé, mis au spam dans Gmail : repris sans relire la boîte", async () => {
    relabel("m1", ["STARRED"]); // lu + archivé + suivi
    relabel("m2", ["SPAM"]);
    const r = await sync();
    expect(r).toMatchObject({ mode: "incrementale", ajoutes_ou_modifies: 2, supprimes: 0, a_suivre: false });
    expect(await thread("m1")).toMatchObject({ unread: false, starred: true, label_ids: ["STARRED"] });
    expect((await thread("t2")).label_ids).toEqual(["INBOX", "SPAM", "UNREAD"]);
    expect(calls.some((c) => c.startsWith("/gmail/v1/users/me/messages?"))).toBe(false);
    expect((await state()).history_id).toBe(String(historyId));
  });

  test("nouveau message et suppression définitive ; un fil vidé disparaît", async () => {
    add({ id: "m4" });
    remove("m1");
    remove("m2");
    const r = await sync();
    expect(r).toMatchObject({ ajoutes_ou_modifies: 1, supprimes: 2 });
    expect(await count("mailbox_messages")).toBe(2);
    expect(await count("mailbox_threads")).toBe(2);
    expect((await thread("t2")).message_count).toBe(1);
    expect(await admin(`select messages_total from mailbox_labels where label_id = 'INBOX'`)).toEqual({ messages_total: 2 });
  });

  test("message modifié puis supprimé avant le passage : retiré, sans erreur", async () => {
    relabel("m1", ["STARRED"]);
    box.delete("m1"); // supprimé sans trace dans l'historique lu
    await sync();
    expect(await count("mailbox_messages")).toBe(2);
  });

  test("gros retard : le repère avance page par page, un passage interrompu ne recommence pas du début", async () => {
    for (let i = 0; i < 5; i++) add({ id: `n${i}` });
    remove("m1");
    historyPage = 2;
    const start = Number((await state()).history_id);
    const r1 = await sync(0); // temps imparti nul : une seule page de changements
    expect(r1).toMatchObject({ ajoutes_ou_modifies: 2, a_suivre: true });
    expect(Number((await state()).history_id)).toBe(start + 2);
    const r2 = await sync();
    expect(r2).toMatchObject({ ajoutes_ou_modifies: 3, supprimes: 1, a_suivre: false });
    expect(await count("mailbox_messages")).toBe(7);
    expect((await state()).history_id).toBe(String(historyId));
  });

  test("rien de nouveau : aucun message relu, deux passages identiques ne changent rien", async () => {
    await sync();
    await sync();
    expect(calls.some((c) => c.includes("/messages/"))).toBe(false);
    expect(await count("mailbox_messages")).toBe(3);
  });

  test("historique expiré : la boîte est relue en entier et ce qui n'existe plus est retiré", async () => {
    box.delete("m1"); // supprimé pendant que le repère expirait : aucun historique ne le dira
    relabel("m2", ["TRASH"]);
    oldestHistory = historyId + 1;
    historyId += 50;
    const r = await sync();
    expect(r).toMatchObject({ mode: "initiale", lecture_complete_terminee: true });
    expect(await count("mailbox_messages")).toBe(2);
    expect(await count("mailbox_threads")).toBe(1);
    expect(await state()).toMatchObject({ generation: 2, history_id: String(historyId), error_code: null });
  });
});

describe("échecs : message clair, repères conservés, reprise", () => {
  beforeEach(async () => {
    add({ id: "m1" });
    await sync();
  });
  const before = async () => (await state()).history_id;

  test("jeton refusé par Gmail", async () => {
    const h = await before();
    add({ id: "m2" });
    failNext = () => json({ error: { code: 401 } }, 401);
    await expect(sync()).rejects.toThrow(/Reconnectez Gmail/);
    expect(await state()).toMatchObject({ error_code: "auth", history_id: h, locked_until: null });
    failNext = null;
    await sync();
    expect(await count("mailbox_messages")).toBe(2);
    expect((await state()).last_error).toBeNull();
  });

  test("quota Gmail atteint", async () => {
    failNext = () => json({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
    await expect(sync()).rejects.toThrow(/limite temporairement/);
    expect((await state()).error_code).toBe("quota");
  });

  test("autorisation de lecture retirée chez Google, ou jamais accordée", async () => {
    failNext = () => json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403);
    await expect(sync()).rejects.toThrow(/en acceptant toutes les autorisations/);
    expect((await state()).error_code).toBe("scope");
    failNext = null;
    calls = [];
    expect(await sync(30_000, [GMAIL_SEND_SCOPE])).toMatchObject({ skipped: expect.stringMatching(/Reconnectez Gmail/) });
    expect(calls).toEqual([]);
  });

  test("réseau coupé : aucune réponse de Google ni détail technique dans le message enregistré", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET jeton-de-test"); }));
    await expect(sync()).rejects.toThrow(/injoignable/);
    expect((await state()).last_error).not.toMatch(/ECONNRESET|jeton/);
  });

  test("deux passages en même temps : le second s'abstient", async () => {
    await db.as("anon");
    expect(await db.rpc("mailbox_sync_claim", { p_server_key: KEY, p_account: account })).not.toBeNull();
    calls = [];
    expect(await sync()).toMatchObject({ skipped: expect.stringMatching(/déjà en cours/) });
    expect(calls).toEqual([]);
    await db.exec(`reset role; update mailbox_sync set locked_until = now() - interval '1 second';`); // verrou abandonné : il expire
    expect(await sync()).toMatchObject({ mode: "incrementale" });
  });
});

describe("accès : imposé par la base", () => {
  beforeEach(async () => {
    add({ id: "m1" });
    await sync();
  });
  const TABLES = ["mailbox_labels", "mailbox_messages", "mailbox_threads", "mailbox_sync"];
  const visible = async (t: string) => (await db.one<{ n: number }>(`select count(*)::int n from ${t}`)).n;

  test("le propriétaire lit son index ; un autre compte et le connecteur Claude ne voient rien ; un visiteur est refusé", async () => {
    for (const t of TABLES) {
      await db.as("owner");
      expect(await visible(t), t).toBeGreaterThan(0);
      await db.as("stranger");
      expect(await visible(t), t).toBe(0);
      await db.as("claude");
      expect(await visible(t), t).toBe(0);
      await db.as("anon");
      await expect(db.query(`select * from ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });

  test("aucune écriture directe, même pour le propriétaire", async () => {
    for (const who of ["owner", "stranger", "claude"] as const) {
      await db.as(who);
      await expect(db.query(`update mailbox_threads set subject = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`delete from mailbox_messages`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`insert into mailbox_labels (account_id, label_id, name, kind) values ($1, 'X', 'X', 'user')`, [account])).rejects.toThrow(/permission denied/);
      await expect(db.query(`update mailbox_sync set history_id = null`)).rejects.toThrow(/permission denied/);
    }
  });

  test("fonctions de synchronisation : refusées sans la clé serveur, quel que soit le compte", async () => {
    const bad = "mauvaise-cle-0123456789abcdef0123456789";
    for (const who of ["owner", "stranger", "claude", "anon"] as const) {
      await db.as(who);
      await expect(db.rpc("mailbox_sync_claim", { p_server_key: bad, p_account: account }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("mailbox_apply", { p_server_key: bad, p_account: account, p: { deleted: ["m1"] } }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("mailbox_sync_begin", { p_server_key: bad, p_account: account, p_history_id: "1" }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("mailbox_sync_fail", { p_server_key: bad, p_account: account, p_code: "x", p_error: "x", p_reset: true }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("mailbox_sync_release", { p_server_key: bad, p_account: account }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.query(`select mailbox_private.refresh_threads($1, '{m1}')`, [account]), who).rejects.toThrow(/permission denied/);
    }
    expect(await count("mailbox_messages")).toBe(1);
  });

  test("compte déconnecté : l'index est effacé et la synchronisation refuse de reprendre", async () => {
    await db.as("owner");
    await db.rpc("mail_disconnect", { p_id: account });
    for (const t of TABLES) expect(await count(t), t).toBe(0);
    await expect(sync()).rejects.toThrow(); // refus de la base (compte non connecté)
    expect(await count("mailbox_sync")).toBe(0);
  });

  test("le passage « boite » est accepté dans le suivi des passages planifiés, sans retirer les autres", async () => {
    await db.as("anon");
    for (const job of ["boite", "gmail", "seo", "corbeille"]) await db.rpc("job_report", { p_server_key: KEY, p_job: job, p_ok: true });
    expect(await count("scheduled_jobs")).toBe(4);
  });
});
