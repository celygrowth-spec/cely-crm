// Mail, lot M04 : rédaction depuis la boîte (brouillons Gmail, envoi unique). Vraies migrations, Gmail simulé,
// adresses fictives en example.test.
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createDb, type Db } from "./harness";

process.env.APPOINTMENTS_SECRET = "secret-de-test-0123456789-0123456789-0123456789";
process.env.GOOGLE_MAIL_CLIENT_ID = "client-fictif";
process.env.GOOGLE_MAIL_CLIENT_SECRET = "secret-fictif";
process.env.MAIL_TOKEN_KEY = Buffer.alloc(32, 9).toString("base64");

let db: Db;
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
import { composeContext, discardComposeDraft, loadComposeDraft, saveComposeDraft, sendComposeDraft } from "@/lib/mail/box-compose";
import { encryptSecret } from "@/lib/mail/crypto";
import { GMAIL_MODIFY_SCOPE, GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "@/lib/mail/google";

// --- Gmail simulé : brouillons, envoi, réglages -----------------------------------------------------------------
type Part = { filename?: string; mimeType: string; body: { data?: string; attachmentId?: string; size?: number } };
type Draft = { id: string; messageId: string; threadId: string | null; raw: string };
let drafts: Map<string, Draft>;
let sent: Draft[];
let seq: number;
let fail: ((url: URL, method: string) => Response | "throw" | null) | null;
let sendAs: unknown;
let received: Map<string, { headers: { name: string; value: string }[]; parts: Part[]; blobs: Record<string, Buffer> }>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });

/** Lecture minimale du message construit par le CRM : en-têtes, HTML, pièces jointes. */
function parse(raw: string) {
  const [head, ...rest] = raw.split("\r\n\r\n");
  // comme Gmail : les en-têtes encodés (objet accentué) sont rendus décodés
  const word = (x: string) => x.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_, b: string) => Buffer.from(b, "base64").toString("utf8"));
  const headers = head.replace(/\r\n[ \t]+/g, " ").split("\r\n").map((l) => ({ name: l.slice(0, l.indexOf(":")), value: word(l.slice(l.indexOf(":") + 2)) }));
  const body = rest.join("\r\n\r\n");
  const parts: Part[] = [];
  const blobs: Record<string, Buffer> = {};
  for (const chunk of body.split(/\r\n--=_cely_[a-z]+_[0-9a-f]+(?:--)?/)) {
    const [h, ...b] = chunk.replace(/^\r\n/, "").split("\r\n\r\n");
    const data = b.join("").replace(/\r\n/g, "");
    const type = /Content-Type: ([^;\r\n]+)/.exec(h ?? "")?.[1];
    if (!type || !data || type.startsWith("multipart/")) continue;
    const name = /filename\*=UTF-8''([^\r\n;]+)/.exec(h)?.[1];
    const buf = Buffer.from(data, "base64");
    if (name) {
      const id = `att-${++seq}`;
      blobs[id] = buf;
      parts.push({ filename: decodeURIComponent(name), mimeType: type, body: { attachmentId: id, size: buf.length } });
    } else parts.push({ mimeType: type, body: { data: buf.toString("base64url") } });
  }
  return { headers, parts, blobs };
}
const headerOf = (d: Draft, name: string) => parse(d.raw).headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
const htmlOf = (d: Draft) => Buffer.from(parse(d.raw).parts.find((p) => p.mimeType === "text/html")!.body.data!, "base64url").toString("utf8");
const filesOf = (d: Draft) => parse(d.raw).parts.filter((p) => p.filename).map((p) => p.filename);

async function gmail(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const f = fail?.(url, method);
  if (f === "throw") throw new Error("ECONNRESET");
  if (f) return f;
  const path = url.pathname.replace("/upload", "").replace("/gmail/v1/users/me", "");
  if (path === "/settings/sendAs") return sendAs ? json(sendAs) : json({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }, 403);
  if (url.pathname.includes("/upload/") && (method === "POST" || method === "PUT")) {
    const body = Buffer.from(init!.body as Uint8Array).toString("latin1");
    const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/.exec(body)![1]) as { message: { threadId?: string } };
    const raw = body.slice(body.indexOf("message/rfc822\r\n\r\n") + 18, body.lastIndexOf("\r\n--cely_"));
    const id = method === "PUT" ? path.slice(8) : `d${++seq}`;
    if (method === "PUT" && !drafts.has(id)) return json({ error: { code: 404 } }, 404);
    const d: Draft = { id, messageId: `m${++seq}`, threadId: meta.message.threadId ?? drafts.get(id)?.threadId ?? `t${seq}`, raw };
    drafts.set(id, d);
    return json({ id, message: { id: d.messageId, threadId: d.threadId } });
  }
  if (path === "/drafts/send") {
    const d = drafts.get((JSON.parse(String(init!.body)) as { id: string }).id);
    if (!d) return json({ error: { code: 404 } }, 404);
    drafts.delete(d.id);
    sent.push(d);
    return json({ id: d.messageId, threadId: d.threadId, labelIds: ["SENT"] });
  }
  if (path === "/drafts") return json({ drafts: [...drafts.values()].map((d) => ({ id: d.id, message: { id: d.messageId, threadId: d.threadId } })) });
  if (path.startsWith("/drafts/")) {
    const d = drafts.get(path.slice(8));
    if (!d) return json({ error: { code: 404 } }, 404);
    if (method === "DELETE") { drafts.delete(d.id); return new Response(null, { status: 204 }); }
    const p = parse(d.raw);
    return json({ id: d.id, message: { id: d.messageId, threadId: d.threadId, labelIds: ["DRAFT"], internalDate: "1700000000000", payload: { headers: p.headers, parts: p.parts } } });
  }
  const att = /^\/messages\/([^/]+)\/attachments\/(.+)$/.exec(path);
  if (att) {
    const owner = [...drafts.values()].find((d) => d.messageId === att[1]);
    const blob = owner ? Object.values(parse(owner.raw).blobs)[Number(att[2].split("#")[1] ?? 0)] : received.get(att[1])?.blobs[att[2]];
    return blob ? json({ data: blob.toString("base64url") }) : json({ error: { code: 404 } }, 404);
  }
  if (path.startsWith("/messages/")) {
    const id = path.slice(10);
    const d = [...drafts.values()].find((x) => x.messageId === id);
    if (d) {
      const p = parse(d.raw);
      // comme Gmail : l'identifiant d'une pièce jointe change à chaque lecture
      let n = 0;
      return json({ id, threadId: d.threadId, labelIds: ["DRAFT"], payload: { headers: p.headers, parts: p.parts.map((x) => (x.filename ? { ...x, body: { ...x.body, attachmentId: `${Math.random()}#${n++}` } } : x)) } });
    }
    const r = received.get(id);
    return r ? json({ id, threadId: "t-recu", labelIds: ["INBOX"], payload: { headers: r.headers, parts: r.parts } }) : json({ error: { code: 404 } }, 404);
  }
  return json({}, 500);
}

const owner = { rpc: async (fn: string, args: Record<string, unknown>) => { await db.as("owner"); return { data: await db.rpc(fn, args), error: null }; } } as unknown as SupabaseClient;
const base = { to: ["claire@example.test"], cc: [], bcc: [], subject: "Bonjour", html: "<p>Un <strong>message</strong></p>", keep: [] };
const save = (over: Record<string, unknown> = {}, files: { name: string; type: string; data: Buffer }[] = []) => saveComposeDraft(owner, { ...base, ...over }, files);
const only = () => { expect(drafts.size).toBe(1); return [...drafts.values()][0]; };
const setScopes = async (scopes: string[]) => { await db.exec(`reset role;`); await db.query(`update mail_accounts set scopes = $1`, [scopes]); };
const locks = async () => { await db.exec(`reset role;`); return (await db.one<{ n: number }>(`select count(*)::int n from mailbox_sends`)).n; };

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: serverRpcKeyHash() });
  await db.exec(`reset role;`);
  const account = (await db.one<{ id: string }>(`insert into mail_accounts (email, display_name, signature, scopes, status, is_default) values ('moi@example.test', 'Moi Test', 'Signature CRM', $1, 'connected', true) returning id`, [[GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE, GMAIL_MODIFY_SCOPE]])).id;
  await db.query(`insert into mail_account_secrets (account_id, refresh_token_enc, access_token_enc, access_token_expires_at) values ($1, $2, $3, now() + interval '1 hour')`,
    [account, encryptSecret("renouvellement-fictif", process.env.MAIL_TOKEN_KEY!), encryptSecret("acces-fictif", process.env.MAIL_TOKEN_KEY!)]);
  drafts = new Map();
  sent = [];
  seq = 0;
  fail = null;
  sendAs = { sendAs: [{ sendAsEmail: "moi@example.test", displayName: "Moi (Gmail)", signature: "<div><b>Moi</b><br>Cely Growth<script>x()</script></div>", isPrimary: true }] };
  received = new Map([["recu1", { headers: [{ name: "From", value: "claire@example.test" }, { name: "Subject", value: "Plan" }], parts: [{ filename: "plan.pdf", mimeType: "application/pdf", body: { attachmentId: "a1", size: 4 } }], blobs: { a1: Buffer.from("PLAN") } }]]);
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => gmail(input, init)));
});
afterEach(() => vi.unstubAllGlobals());

describe("contexte de rédaction", () => {
  test("signature et nom réglés dans Gmail, nettoyés", async () => {
    const c = await composeContext(owner);
    expect(c).toMatchObject({ email: "moi@example.test", name: "Moi (Gmail)", can_compose: true });
    expect(c.signature_html).toContain("Cely Growth");
    expect(c.signature_html).not.toContain("script");
  });
  test("réglages Gmail non lisibles (autorisation absente) : signature du CRM", async () => {
    sendAs = null;
    expect(await composeContext(owner)).toMatchObject({ name: "Moi Test", signature_html: "<p>Signature CRM</p>" });
  });
});

describe("brouillons dans Gmail", () => {
  test("création : destinataires, copies, objet, contenu nettoyé, expéditeur", async () => {
    const r = await save({ cc: ["copie@example.test"], bcc: ["cachee@example.test"], html: `<p onclick="x()">Bonjour</p><script>alert(1)</script>` });
    const d = only();
    expect(r).toMatchObject({ draft_id: d.id, message_id: d.messageId, attachments: [] });
    expect(headerOf(d, "To")).toBe("claire@example.test");
    expect(headerOf(d, "Cc")).toBe("copie@example.test");
    expect(headerOf(d, "Bcc")).toBe("cachee@example.test");
    expect(headerOf(d, "From")).toBe(`"Moi Test" <moi@example.test>`);
    expect(htmlOf(d)).toBe("<p>Bonjour</p>");
  });

  test("modification : le même brouillon est mis à jour, pas dupliqué", async () => {
    const a = await save();
    const b = await save({ draft_id: a.draft_id, subject: "Bonjour (suite)" });
    expect(b.draft_id).toBe(a.draft_id);
    expect(headerOf(only(), "Subject")).toBe("Bonjour (suite)");
  });

  test("brouillon sans destinataire accepté (Gmail le garde), sans adresse inventée", async () => {
    await save({ to: [] });
    expect(headerOf(only(), "To")).toBeNull();
  });

  test("réponse : rangée dans le fil, avec les en-têtes de réponse", async () => {
    await save({ thread_id: "fil42", in_reply_to: "<abc@example.test>", references: "<racine@example.test> <abc@example.test>", subject: "Re: Plan" });
    const d = only();
    expect(d.threadId).toBe("fil42");
    expect(headerOf(d, "In-Reply-To")).toBe("<abc@example.test>");
    expect(headerOf(d, "References")).toBe("<racine@example.test> <abc@example.test>");
  });

  test("pièces jointes : fichier ajouté, conservé aux enregistrements suivants sans renvoi, puis retiré", async () => {
    const a = await save({}, [{ name: "devis été.pdf", type: "application/pdf", data: Buffer.from("PDF-1") }]);
    expect(a.attachments).toEqual([{ message_id: a.message_id, n: 0, name: "devis été.pdf", size: 5 }]);
    const b = await save({ draft_id: a.draft_id, keep: [{ message_id: a.message_id, n: 0 }] }, [{ name: "note.txt", type: "text/plain", data: Buffer.from("note") }]);
    expect(filesOf(only())).toEqual(["devis été.pdf", "note.txt"]);
    const c = await save({ draft_id: a.draft_id, keep: [{ message_id: b.message_id, n: 1 }] });
    expect(filesOf(only())).toEqual(["note.txt"]);
    expect(c.attachments).toMatchObject([{ n: 0, name: "note.txt" }]);
  });

  test("transfert : la pièce jointe du message d'origine est reprise depuis Gmail", async () => {
    const r = await save({ subject: "Fwd: Plan", keep: [{ message_id: "recu1", n: 0 }] });
    expect(filesOf(only())).toEqual(["plan.pdf"]);
    expect(r.attachments).toMatchObject([{ name: "plan.pdf", size: 4 }]);
    await expect(save({ keep: [{ message_id: "recu1", n: 5 }] })).rejects.toThrow(/n'existe plus/);
    await expect(save({ keep: [{ message_id: "inconnu", n: 0 }] })).rejects.toThrow(/n'existe plus/);
  });

  test("reprise d'un brouillon créé dans Gmail", async () => {
    const a = await save({ cc: ["copie@example.test"], subject: "À finir" }, [{ name: "a.txt", type: "text/plain", data: Buffer.from("a") }]);
    const d = await loadComposeDraft(owner, a.message_id);
    expect(d).toMatchObject({ draft_id: a.draft_id, to: ["claire@example.test"], cc: ["copie@example.test"], subject: "À finir", html: "<p>Un <strong>message</strong></p>" });
    expect(d.attachments).toMatchObject([{ message_id: a.message_id, n: 0, name: "a.txt" }]);
    await expect(loadComposeDraft(owner, "inconnu")).rejects.toThrow(/n'existe plus/);
  });

  test("brouillon supprimé ou envoyé ailleurs entre-temps : signalé, pas recréé en silence", async () => {
    const a = await save();
    drafts.clear();
    await expect(save({ draft_id: a.draft_id })).rejects.toThrow(/n'existe plus dans Gmail/);
    expect(drafts.size).toBe(0);
  });

  test("suppression du brouillon, deux fois sans erreur", async () => {
    const a = await save();
    await discardComposeDraft(owner, a.draft_id);
    await discardComposeDraft(owner, a.draft_id);
    expect(drafts.size).toBe(0);
  });

  test("demandes refusées : adresse invalide, en-tête injecté, trop de fichiers, sans autorisation", async () => {
    await expect(save({ to: ["pas-une-adresse"] })).rejects.toThrow();
    await expect(save({ subject: "Objet\r\nBcc: espion@example.test" })).rejects.toThrow(/interdit/);
    await expect(save({ in_reply_to: "<a@b.test>\r\nBcc: espion@example.test" })).rejects.toThrow(/interdit/);
    await expect(save({}, [{ name: "gros.bin", type: "application/octet-stream", data: Buffer.alloc(4 * 1024 * 1024 + 1) }])).rejects.toThrow(/4 Mo/);
    await expect(save({ draft_id: "../../labels" })).rejects.toThrow();
    expect(drafts.size).toBe(0);
    await setScopes([GMAIL_SEND_SCOPE, GMAIL_READ_SCOPE]);
    await expect(save()).rejects.toThrow(/Reconnectez Gmail/);
    await expect(sendComposeDraft(owner, "d1")).rejects.toThrow(/Reconnectez Gmail/);
    expect(drafts.size).toBe(0);
  });
});

describe("envoi : une seule fois", () => {
  test("le brouillon part et quitte les brouillons ; renvoyer le même ne renvoie rien", async () => {
    const a = await save({ thread_id: "fil42" });
    expect(await sendComposeDraft(owner, a.draft_id)).toEqual({ status: "sent", thread_id: "fil42" });
    expect(await sendComposeDraft(owner, a.draft_id)).toEqual({ status: "already" });
    expect(sent).toHaveLength(1);
    expect(drafts.size).toBe(0);
  });

  test("envoi à une personne d'une fiche : une ligne dans l'historique de la fiche, une seule", async () => {
    await db.as("owner");
    const acme = (await db.rpc<{ id: string }>("create_company", { p_force: true, p_company: { name: "Acme" }, p_people: [{ first_name: "Claire", email: "claire@example.test" }] })).id;
    const a = await save({ subject: "Devis", html: "<p>Voici le devis.</p>" });
    await Promise.all([sendComposeDraft(owner, a.draft_id), sendComposeDraft(owner, a.draft_id)]);
    await db.exec(`reset role;`);
    expect(await db.one(`select count(*)::int n, min(content) content from interactions where company_id = $1 and kind = 'message_out'`, [acme])).toEqual({ n: 1, content: "Devis\n\nVoici le devis." });
    expect(await db.one(`select status, company_id from mail_messages`)).toEqual({ status: "accepted", company_id: acme });
  });

  test("double clic ou deux onglets en même temps : un seul message", async () => {
    const a = await save();
    const results = await Promise.all([sendComposeDraft(owner, a.draft_id), sendComposeDraft(owner, a.draft_id), sendComposeDraft(owner, a.draft_id)]);
    expect(sent).toHaveLength(1);
    expect(results.filter((r) => r.status === "sent")).toHaveLength(1);
  });

  test("sans destinataire : refusé, brouillon conservé", async () => {
    const a = await save({ to: [] });
    await expect(sendComposeDraft(owner, a.draft_id)).rejects.toThrow(/au moins un destinataire/);
    expect(drafts.size).toBe(1);
    expect(await locks()).toBe(0);
  });

  test("Gmail refuse l'envoi : erreur claire, brouillon conservé, nouvel essai possible", async () => {
    const a = await save();
    fail = (u) => (u.pathname.endsWith("/drafts/send") ? json({ error: { code: 429 } }, 429) : null);
    await expect(sendComposeDraft(owner, a.draft_id)).rejects.toThrow(/Le brouillon est conservé/);
    expect(drafts.size).toBe(1);
    expect(sent).toHaveLength(0);
    fail = null;
    expect(await sendComposeDraft(owner, a.draft_id)).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(1);
  });

  test("coupure pendant l'envoi, message parti : conclu « envoyé », jamais renvoyé", async () => {
    const a = await save();
    fail = (u) => {
      if (!u.pathname.endsWith("/drafts/send")) return null;
      sent.push(drafts.get(a.draft_id)!); // Gmail a envoyé, la réponse s'est perdue
      drafts.delete(a.draft_id);
      return "throw";
    };
    expect(await sendComposeDraft(owner, a.draft_id)).toMatchObject({ status: "sent" });
    fail = null;
    expect(await sendComposeDraft(owner, a.draft_id)).toEqual({ status: "already" });
    expect(sent).toHaveLength(1);
  });

  test("coupure pendant l'envoi, message non parti : brouillon conservé, nouvel essai possible", async () => {
    const a = await save();
    fail = (u) => (u.pathname.endsWith("/drafts/send") ? "throw" : null);
    await expect(sendComposeDraft(owner, a.draft_id)).rejects.toThrow(/n'a pas envoyé le message/);
    fail = null;
    expect(await sendComposeDraft(owner, a.draft_id)).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(1);
  });

  test("coupure totale : résultat incertain annoncé, aucun renvoi automatique", async () => {
    const a = await save();
    let cut = false;
    fail = (u) => (u.pathname.endsWith("/drafts/send") ? ((cut = true), "throw") : cut ? "throw" : null);
    await expect(sendComposeDraft(owner, a.draft_id)).rejects.toThrow(/peut-être parti/);
    fail = null;
    expect(await sendComposeDraft(owner, a.draft_id)).toEqual({ status: "already" }); // verrou gardé : pas de second envoi
    expect(sent).toHaveLength(0);
  });

  test("verrous d'envoi : clé serveur exigée, table illisible, effacés à la déconnexion", async () => {
    const account = (await (async () => { await db.exec(`reset role;`); return db.one<{ id: string }>(`select id from mail_accounts`); })()).id;
    for (const who of ["owner", "stranger", "claude", "anon"] as const) {
      await db.as(who);
      await expect(db.rpc("mailbox_send_claim", { p_server_key: "mauvaise-cle-0123456789abcdef0123456789", p_account: account, p_draft: "x" }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.rpc("mailbox_send_release", { p_server_key: "mauvaise-cle-0123456789abcdef0123456789", p_account: account, p_draft: "x" }), who).rejects.toThrow(/Accès refusé/);
      await expect(db.query(`select * from mailbox_sends`), who).rejects.toThrow(/permission denied/);
    }
    await db.as("anon");
    expect(await db.rpc("mailbox_send_claim", { p_server_key: serverRpcKey(), p_account: account, p_draft: "x" })).toBe(true);
    expect(await db.rpc("mailbox_send_claim", { p_server_key: serverRpcKey(), p_account: account, p_draft: "x" })).toBe(false);
    await db.exec(`reset role; update mailbox_sends set claimed_at = now() - interval '11 minutes';`);
    await db.as("anon");
    expect(await db.rpc("mailbox_send_claim", { p_server_key: serverRpcKey(), p_account: account, p_draft: "x" })).toBe(true); // verrou abandonné
    await db.as("owner");
    await db.rpc("mail_disconnect", { p_id: account });
    expect(await locks()).toBe(0);
  });
});
