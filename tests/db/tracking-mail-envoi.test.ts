// Tracking site · lot 2 : un mail envoyé depuis Mail à une adresse fictive porte des UTM sur ses liens vers
// celygrowth.com, dans la version HTML comme dans la version texte. Vraies migrations, vrai service d'envoi ;
// Gmail simulé (aucun appel réseau, aucun vrai destinataire).
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GMAIL_SEND_SCOPE } from "@/lib/mail/google";
import { saveConnection, saveDraft, sendStored } from "@/lib/mail/service";
import { createDb, type Db } from "./harness";

const ID = "55555555-5555-4555-8555-555555555555";
let db: Db;
let sb: SupabaseClient;
let calls: { url: string; init: RequestInit }[];
let company: string;

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
function sentParts() {
  const b = calls.filter((c) => c.url.includes("gmail.googleapis.com")).at(-1)!.init.body;
  const raw = typeof b === "string" ? b : Buffer.from(b as Uint8Array).toString();
  return [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$)/g)].map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));
}

beforeEach(async () => {
  vi.stubEnv("GOOGLE_MAIL_CLIENT_ID", "client");
  vi.stubEnv("GOOGLE_MAIL_CLIENT_SECRET", "client-secret");
  vi.stubEnv("MAIL_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
  db = await createDb();
  sb = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        return { data: await db.rpc(fn, args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: "absent" } }) }) },
  } as unknown as SupabaseClient;
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return url.includes("oauth2.googleapis.com/token") ? json({ access_token: "a", expires_in: 3600 }) : json({ id: "gm1", threadId: "th1" });
  });
  company = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "[TEST] Studio Démo" }, p_people: [{ first_name: "Claire", email: "claire@studio.example.test" }] })).id;
  await saveConnection(sb, { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3e6).toISOString(), scopes: [GMAIL_SEND_SCOPE], email: "moi@cely.fr", name: "Moi" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("mail de test : liens vers celygrowth.com marqués (support email), lien déjà marqué et autres sites intacts", async () => {
  await saveDraft(sb, ID, {
    company_id: company, to: ["claire@studio.example.test"], subject: "Suite à notre échange", body: "",
    html: '<p>Bonjour, voici <a href="https://www.celygrowth.com/services/offre-decouverte">l\'offre découverte</a>, '
      + '<a href="https://www.celygrowth.com/growth?utm_source=linkedin&amp;utm_campaign=lancement">un lien déjà marqué</a> '
      + 'et <a href="https://exemple.fr/article">un article</a>.</p>',
    signature: "Célien\ncelygrowth.com",
  });
  const m = await sendStored(sb, ID);
  expect(m.status).toBe("accepted");
  const [text, html] = sentParts();
  const utm = "utm_source=email&utm_medium=email&utm_campaign=mail-direct";
  expect(html).toContain(`href="https://www.celygrowth.com/services/offre-decouverte?${utm.replace(/&/g, "&amp;")}"`);
  expect(html).toContain('href="https://www.celygrowth.com/growth?utm_source=linkedin&amp;utm_campaign=lancement"');
  expect(html).toContain('href="https://exemple.fr/article"');
  expect(text).toContain(`https://www.celygrowth.com/services/offre-decouverte?${utm}`);
  expect(text).toContain("https://www.celygrowth.com/growth?utm_source=linkedin&utm_campaign=lancement");
  // la simple mention du domaine dans la signature reste lisible, sans adresse à rallonge
  expect(text).toMatch(/Célien\ncelygrowth\.com$/);
  // le contenu conservé dans le CRM reste celui que j'ai écrit
  expect((await db.one<{ body_html: string }>(`select body_html from mail_messages where id = $1`, [ID])).body_html).not.toContain("utm_source=email");
});
