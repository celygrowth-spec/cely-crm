// Service d'envoi complet : vraies migrations, Google simulé (aucun appel réseau réel).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/mail/crypto";
import { GMAIL_SEND_SCOPE, authorizeUrl } from "@/lib/mail/google";
import { disconnectAccount, safeHtml, saveConnection, saveDraft, sendMail, sendStored } from "@/lib/mail/service";
import { createDb, type Db } from "./harness";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ID = "22222222-2222-4222-8222-222222222222";
const REFRESH = "refresh-secret-value";
const ACCESS = "access-secret-value";

let db: Db;
let sb: SupabaseClient;
let calls: { url: string; init: RequestInit }[];
let gmail: () => Response | Promise<Response>;
let token: () => Response;
let revoke: () => Response;
let stored: Record<string, Buffer>;
let company: string;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const sends = () => calls.filter((c) => c.url.includes("gmail.googleapis.com"));

function fakeClient(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        return { data: await db.rpc(fn, args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    storage: { from: () => ({ download: async (p: string) => (stored[p] ? { data: new Blob([new Uint8Array(stored[p])]), error: null } : { data: null, error: { message: "absent" } }) }) },
  } as unknown as SupabaseClient;
}

const connect = (expiresInSec = 3000) =>
  saveConnection(sb, { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date(Date.now() + expiresInSec * 1000).toISOString(), scopes: [GMAIL_SEND_SCOPE], email: "moi@cely.fr", name: "Moi" });
const draft = (p = {}) => saveDraft(sb, ID, { company_id: company, to: ["test@cely.fr"], subject: "Bonjour", body: "Texte", signature: "Célien", ...p });
const history = async () => (await db.one<{ n: number }>(`select count(*)::int n from interactions where kind = 'message_out'`)).n;

beforeEach(async () => {
  vi.stubEnv("GOOGLE_MAIL_CLIENT_ID", "client");
  vi.stubEnv("GOOGLE_MAIL_CLIENT_SECRET", "client-secret");
  vi.stubEnv("MAIL_TOKEN_KEY", KEY);
  db = await createDb();
  sb = fakeClient();
  calls = [];
  stored = {};
  gmail = () => json({ id: "gm1", threadId: "th1" });
  token = () => json({ access_token: "access-new", expires_in: 3600 });
  revoke = () => new Response("", { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) return token();
    if (url.includes("oauth2.googleapis.com/revoke")) return revoke();
    return gmail();
  });
  company = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("connexion", () => {
  test("la demande Google contient l'envoi et la lecture (réception, Q03), et exige l'accès durable", () => {
    const u = new URL(authorizeUrl({ clientId: "c", clientSecret: "s" }, { redirectUri: "https://x/cb", state: "st", challenge: "ch" }));
    expect(u.searchParams.get("scope")).toBe(`openid email profile ${GMAIL_SEND_SCOPE} https://www.googleapis.com/auth/gmail.readonly`);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toContain("consent");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.toString()).not.toContain("s=s");
    expect(u.searchParams.has("include_granted_scopes")).toBe(false); // n'agrège pas d'autres autorisations
  });

  test("les jetons sont chiffrés en base", async () => {
    await connect();
    const r = await db.one<{ refresh_token_enc: string; access_token_enc: string }>(`select refresh_token_enc, access_token_enc from mail_account_secrets`);
    expect(JSON.stringify(r)).not.toContain(REFRESH);
    expect(JSON.stringify(r)).not.toContain(ACCESS);
    expect(decryptSecret(r.refresh_token_enc, KEY)).toBe(REFRESH);
  });

  test("chiffrement : altération et mauvaise clé détectées", () => {
    const blob = encryptSecret("x", KEY);
    expect(() => decryptSecret(blob, Buffer.alloc(32, 8).toString("base64"))).toThrow();
    expect(() => decryptSecret(blob.slice(0, -2) + "AA", KEY)).toThrow();
    expect(() => encryptSecret("x", "courte")).toThrow(/32 octets/);
  });

  test("autorisation d'envoi décochée, ou accès durable absent : refus", async () => {
    await expect(saveConnection(sb, { accessToken: "a", refreshToken: "r", expiresAt: new Date().toISOString(), scopes: ["openid"], email: "a@b.fr" })).rejects.toThrow(/envoi/);
    await expect(saveConnection(sb, { accessToken: "a", expiresAt: new Date().toISOString(), scopes: [GMAIL_SEND_SCOPE], email: "a@b.fr" })).rejects.toThrow(/durable/);
  });
});

describe("envoi réel simulé", () => {
  test("accepté : le corps part signé, l'historique a une entrée, le jeton n'est pas renouvelé inutilement", async () => {
    await connect();
    await draft();
    const r = await sendStored(sb, ID);
    expect(r).toMatchObject({ status: "accepted", provider_message_id: "gm1", provider_thread_id: "th1" });
    expect(sends()).toHaveLength(1);
    const raw = Buffer.from(sends()[0].init.body as Uint8Array).toString();
    expect(raw).toContain(Buffer.from("Texte\n\n-- \nCélien").toString("base64"));
    expect((sends()[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS}`);
    expect(calls.some((c) => c.url.includes("/token"))).toBe(false);
    expect(await history()).toBe(1);
  });

  test("double clic : deux appels simultanés, un seul envoi à Gmail", async () => {
    await connect();
    await draft();
    const [a, b] = await Promise.all([sendStored(sb, ID), sendStored(sb, ID)]);
    expect(sends()).toHaveLength(1);
    expect([a.status, b.status]).toContain("accepted");
    await sendStored(sb, ID);
    expect(sends()).toHaveLength(1);
    expect(await history()).toBe(1);
  });

  test("jeton expiré : renouvelé puis conservé chiffré", async () => {
    await connect(10);
    await draft();
    expect((await sendStored(sb, ID)).status).toBe("accepted");
    expect((sends()[0].init.headers as Record<string, string>).authorization).toBe("Bearer access-new");
    const r = await db.one<{ access_token_enc: string }>(`select access_token_enc from mail_account_secrets`);
    expect(decryptSecret(r.access_token_enc, KEY)).toBe("access-new");
  });

  test("révocation : échec clair, compte à reconnecter, Gmail non appelé, texte conservé", async () => {
    await connect(10);
    await draft();
    token = () => json({ error: "invalid_grant" }, 400);
    const r = await sendStored(sb, ID);
    expect(r).toMatchObject({ status: "failed", error_code: "reconnect", body_text: "Texte" });
    expect(sends()).toHaveLength(0);
    expect(await db.one(`select status from mail_accounts`)).toEqual({ status: "needs_reconnect" });
    expect(await db.one(`select count(*)::int n from mail_account_secrets`)).toEqual({ n: 0 });
  });

  test("401 de Gmail : une seule nouvelle tentative avec un accès renouvelé", async () => {
    await connect();
    await draft();
    const seq = [json({ error: {} }, 401), json({ id: "gm2", threadId: "th2" })];
    gmail = () => seq.shift()!;
    expect((await sendStored(sb, ID)).status).toBe("accepted");
    expect(sends()).toHaveLength(2);
  });

  test.each([
    [400, { error: { message: "Invalid To" } }, "http_400"],
    [403, { error: { errors: [{ reason: "insufficientPermissions" }] } }, "forbidden"],
    [403, { error: { errors: [{ reason: "dailyLimitExceeded" }] } }, "quota"],
    [429, { error: {} }, "quota"],
  ])("refus Gmail %i : échec certain, pas d'historique, reprise possible", async (status, body, code) => {
    await connect();
    await draft();
    gmail = () => json(body, status);
    expect(await sendStored(sb, ID)).toMatchObject({ status: "failed", error_code: code });
    expect(sends()).toHaveLength(1);
    expect(await history()).toBe(0);
  });

  test.each([
    ["coupure réseau", () => Promise.reject(new TypeError("fetch failed"))],
    ["erreur 500", () => json({}, 500)],
    ["erreur 503", () => json({}, 503)],
    ["réponse sans identifiant", () => json({})],
  ])("%s : résultat incertain, jamais de nouvel essai automatique", async (_, impl) => {
    await connect();
    await draft();
    gmail = impl as () => Response;
    expect((await sendStored(sb, ID)).status).toBe("uncertain");
    expect(sends()).toHaveLength(1);
    await sendStored(sb, ID);
    expect(sends()).toHaveLength(1);
    expect(await history()).toBe(0);
  });

  test("déconnecté : aucun envoi, le brouillon reste", async () => {
    const acc = await connect();
    await draft();
    const { revoked } = await disconnectAccount(sb, acc);
    expect(revoked).toBe(true);
    expect(decodeURIComponent(String(calls.find((c) => c.url.includes("/revoke"))?.init.body))).toContain(REFRESH);
    await expect(sendStored(sb, ID)).rejects.toThrow(/Aucun compte/);
    expect(sends()).toHaveLength(0);
    expect((await db.one<{ status: string }>(`select status from mail_messages`)).status).toBe("draft");
  });

  test("révocation Google indisponible : déconnecté quand même, et signalé", async () => {
    const acc = await connect();
    revoke = () => new Response("", { status: 500 });
    expect(await disconnectAccount(sb, acc)).toEqual({ revoked: false });
    expect(await db.one(`select status from mail_accounts`)).toEqual({ status: "disconnected" });
    expect(await db.one(`select count(*)::int n from mail_account_secrets`)).toEqual({ n: 0 });
  });
});

describe("pièces jointes", () => {
  const file = async (name: string, size: number, data?: Buffer) => {
    const path = `${company}/${name}`;
    if (data) stored[path] = data;
    return (await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, 'application/pdf', $4, 'ready') returning id`, [company, path, name, size])).id;
  };

  test("le contenu part avec le message", async () => {
    await connect();
    const data = Buffer.from("%PDF-contenu");
    await draft({ file_ids: [await file("devis.pdf", data.length, data)] });
    expect((await sendStored(sb, ID)).status).toBe("accepted");
    const raw = Buffer.from(sends()[0].init.body as Uint8Array).toString();
    expect(raw).toContain("devis.pdf");
    expect(raw).toContain(data.toString("base64"));
  });

  test("illisible ou trop lourd : échec avant Gmail, jamais d'envoi sans la pièce", async () => {
    await connect();
    await draft({ file_ids: [await file("absent.pdf", 10)] });
    expect(await sendStored(sb, ID)).toMatchObject({ status: "failed", last_error: expect.stringContaining("absent.pdf") });
    expect(sends()).toHaveLength(0);
    await db.rpc("mail_reopen", { p_id: ID });
    await draft({ file_ids: [await file("a.pdf", 15 * 1024 * 1024, Buffer.from("x")), await file("b.pdf", 15 * 1024 * 1024, Buffer.from("x"))] });
    expect(await sendStored(sb, ID)).toMatchObject({ status: "failed", last_error: expect.stringContaining("18 Mo") });
    expect(sends()).toHaveLength(0);
  });
});

describe("service partagé", () => {
  const req = { to: ["client@test.fr"], subject: "Rendez-vous confirmé", text: "À demain", origin: "appointment" as const, business: { type: "appointment", id: "rdv1" } };

  test("une même clé n'envoie qu'une fois ; le module récupère l'état existant", async () => {
    await connect();
    const a = await sendMail(sb, { ...req, dedupeKey: "rdv1:confirmation" });
    const b = await sendMail(sb, { ...req, dedupeKey: "rdv1:confirmation" });
    expect(a).toMatchObject({ status: "accepted", duplicate: false, origin: "appointment", business_id: "rdv1" });
    expect(b).toMatchObject({ id: a.id, status: "accepted", duplicate: true });
    expect(sends()).toHaveLength(1);
  });

  test("envoi sans fiche : aucune entrée d'historique", async () => {
    await connect();
    await sendMail(sb, req);
    expect(await history()).toBe(0);
  });

  test("destinataire invalide refusé avant tout enregistrement ; envoi programmé refusé pour l'instant", async () => {
    await connect();
    await expect(sendMail(sb, { ...req, to: ["pas-une-adresse"] })).rejects.toThrow();
    await expect(sendMail(sb, { ...req, scheduledAt: new Date().toISOString() })).rejects.toThrow(/programmé/);
    expect(await db.one(`select count(*)::int n from mail_messages`)).toEqual({ n: 0 });
  });

  test("configuration absente : erreur claire, aucun appel", async () => {
    await connect();
    vi.stubEnv("MAIL_TOKEN_KEY", "");
    await draft();
    await expect(sendStored(sb, ID)).rejects.toThrow(/pas encore configuré/);
    expect(calls).toHaveLength(0);
    expect(await db.one(`select status from mail_messages`)).toEqual({ status: "draft" });
  });

  test("HTML nettoyé : ni script, ni image distante, ni lien javascript", () => {
    const out = safeHtml(`<p onclick="x()">Salut<script>alert(1)</script><img src="https://traceur/x.png"><a href="javascript:alert(1)">a</a><a href="https://ok.fr">b</a></p>`);
    expect(out).toContain("Salut");
    expect(out).toContain(`href="https://ok.fr"`);
    for (const bad of ["script", "onclick", "img", "javascript:"]) expect(out).not.toContain(bad);
  });
});

test("les jetons ne sortent jamais du service : aucune référence dans le code navigateur", () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  const client = walk("src").filter((f) => /\.tsx?$/.test(f) && readFileSync(f, "utf8").startsWith(`"use client"`));
  expect(client.length).toBeGreaterThan(10);
  for (const f of client) {
    const s = readFileSync(f, "utf8");
    expect(s, f).not.toMatch(/refresh_token|access_token|GOOGLE_MAIL|MAIL_TOKEN_KEY|mail_account_secret|lib\/mail\/(service|google|crypto)/);
  }
});
