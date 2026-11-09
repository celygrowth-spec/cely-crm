// Envoi depuis la fiche (phase 4) : variables résolues côté serveur, « Ne plus contacter », contenu exact
// conservé, brouillon rendu intact après un échec, Message-ID et réponse dans le même fil, historique.
// Vraies migrations ; Google simulé (aucun appel réseau réel).
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GMAIL_SEND_SCOPE } from "@/lib/mail/google";
import { saveConnection, saveDraft, sendMail, sendStored } from "@/lib/mail/service";
import type { MailMessage } from "@/lib/mail/types";
import { createDb, type Db } from "./harness";

const KEY = Buffer.alloc(32, 7).toString("base64");
const ID = "33333333-3333-4333-8333-333333333333";
const ID2 = "44444444-4444-4444-8444-444444444444";

let db: Db;
let sb: SupabaseClient;
let calls: { url: string; init: RequestInit }[];
let gmail: () => Response;
let company: string;
let claire: string;

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const sends = () => calls.filter((c) => c.url.includes("gmail.googleapis.com"));

/** Le message tel que Gmail l'a reçu : en-têtes en clair et parties base64 décodées. */
function sentMime(i = sends().length - 1) {
  const b = sends()[i].init.body;
  const raw = typeof b === "string" ? b : Buffer.from(b as Uint8Array).toString();
  const decoded = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|\r\n$)/g)]
    .map((m) => Buffer.from(m[1].replace(/\r\n/g, ""), "base64").toString("utf8"));
  return { raw, text: decoded.join("\n---\n") };
}

function fakeClient(): SupabaseClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      try {
        return { data: await db.rpc(fn, args), error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
    storage: { from: () => ({ download: async () => ({ data: null, error: { message: "absent" } }) }) },
  } as unknown as SupabaseClient;
}

const draft = (p = {}, id = ID) => saveDraft(sb, id, {
  company_id: company, to: ["claire@studio.fr"], subject: "{{prenom}}, une idée pour {{entreprise}}",
  body: "", html: `<p>Bonjour <span data-variable="prenom">Prénom</span>, voici une piste pour <span data-variable="entreprise">Entreprise</span>.</p>`,
  signature: "Célien", ...p,
});
const row = (id = ID) => db.one<MailMessage & { draft_snapshot: unknown; rfc_message_id: string | null }>(`select * from mail_messages where id = $1`, [id]);

beforeEach(async () => {
  vi.stubEnv("GOOGLE_MAIL_CLIENT_ID", "client");
  vi.stubEnv("GOOGLE_MAIL_CLIENT_SECRET", "client-secret");
  vi.stubEnv("MAIL_TOKEN_KEY", KEY);
  db = await createDb();
  sb = fakeClient();
  calls = [];
  let n = 0;
  gmail = () => json({ id: `gm${++n}`, threadId: `th${n}` });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "a", expires_in: 3600 });
    return gmail();
  });
  company = (await db.rpc<{ id: string }>("create_company", {
    p_company: { name: "Studio Démo", website: "studio.fr" },
    p_people: [{ first_name: "Claire", last_name: "Martin", email: "claire@studio.fr" }, { first_name: "Marc", last_name: "Durand", email: "marc@studio.fr" }],
  })).id;
  claire = (await db.one<{ id: string }>(`select id from people where first_name = 'Claire'`)).id;
  await saveConnection(sb, { accessToken: "a", refreshToken: "r", expiresAt: new Date(Date.now() + 3e6).toISOString(), scopes: [GMAIL_SEND_SCOPE], email: "moi@cely.fr", name: "Moi" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("variables", () => {
  test("résolues avec l'unique destinataire de la fiche ; le contenu exact envoyé est conservé", async () => {
    await draft();
    const m = await sendStored(sb, ID);
    expect(m.status).toBe("accepted");
    const { raw, text } = sentMime();
    expect(raw).toMatch(/^Message-ID: <cely\.[0-9a-f]{32}@cely\.fr>\r$/m);
    expect(text).toContain("Bonjour Claire, voici une piste pour Studio Démo.");
    expect(text).not.toMatch(/Prénom|data-variable|\{\{/);
    const r = await row();
    expect(r.subject).toBe("Claire, une idée pour Studio Démo");
    expect(r.body_text).toBe("Bonjour Claire, voici une piste pour Studio Démo.");
    expect(r.rfc_message_id).toMatch(/^<cely\./);
  });

  test("variable sans valeur : refus nommé, rien n'est envoyé, le brouillon ne change pas", async () => {
    await draft({ html: `<p>Votre poste : <span data-variable="poste">Poste</span></p>`, subject: "Bonjour" });
    await expect(sendStored(sb, ID)).rejects.toThrow(/Variable sans valeur : Poste/);
    expect(sends()).toHaveLength(0);
    const r = await row();
    expect(r.status).toBe("draft");
    expect(r.body_html).toContain('data-variable="poste"');
  });

  test("plusieurs destinataires : jamais de prénom choisi en silence ; formule collective acceptée sans prénom", async () => {
    await draft({ to: ["claire@studio.fr", "marc@studio.fr"] });
    await expect(sendStored(sb, ID)).rejects.toThrow(/contact de référence/);
    await draft({ to: ["claire@studio.fr", "marc@studio.fr"], collective: true, expected_version: 1 });
    await expect(sendStored(sb, ID)).rejects.toThrow(/Variable sans valeur : Prénom/);
    await draft({ to: ["claire@studio.fr", "marc@studio.fr"], collective: true, expected_version: 2, subject: "Une idée pour {{entreprise}}",
      html: `<p>Bonjour à tous, une piste pour <span data-variable="entreprise">Entreprise</span>.</p>` });
    expect((await sendStored(sb, ID)).status).toBe("accepted");
    await draft({ to: ["claire@studio.fr", "marc@studio.fr"], person_id: claire }, ID2);
    expect((await sendStored(sb, ID2)).subject).toBe("Claire, une idée pour Studio Démo");
    expect(sends()).toHaveLength(2);
  });

  test("brouillon modifié entre la lecture et l'envoi : rien ne part", async () => {
    await draft();
    await expect(db.rpc("mail_claim", { p_id: ID, p_final: { subject: "x", html: "<p>x</p>", text: "x", version: 0 } })).rejects.toThrow(/vient d'être modifié/);
    expect((await row()).status).toBe("draft");
  });
});

describe("Ne plus contacter", () => {
  beforeEach(async () => {
    await db.exec(`update companies set do_not_contact = true, do_not_contact_reason = 'Demande du client'`);
  });

  test("email écrit à la main : refusé sans confirmation explicite, envoyé avec", async () => {
    await draft();
    await expect(sendStored(sb, ID)).rejects.toThrow(/Ne plus contacter/);
    expect(sends()).toHaveLength(0);
    expect((await row()).status).toBe("draft");
    expect((await sendStored(sb, ID, { allowDoNotContact: true })).status).toBe("accepted");
  });

  test("envoi automatique : toujours bloqué, même adressé à la personne depuis une autre fiche", async () => {
    const other = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Autre" }, p_people: [] })).id;
    await expect(sendMail(sb, { origin: "prospection", companyId: other, to: ["marc@studio.fr"], subject: "Relance", text: "Bonjour" })).rejects.toThrow(/Ne plus contacter » : marc@studio\.fr/);
    expect(sends()).toHaveLength(0);
  });
});

describe("échec et reprise", () => {
  test("échec Gmail : le brouillon redevient modifiable avec ses variables, pièces jointes comprises", async () => {
    gmail = () => json({ error: { message: "Invalid To header" } }, 400);
    await draft();
    expect((await sendStored(sb, ID)).status).toBe("failed");
    expect((await row()).body_text).toBe("Bonjour Claire, voici une piste pour Studio Démo."); // ce qui a été tenté
    const reopened = await db.rpc<MailMessage>("mail_reopen", { p_id: ID });
    expect(reopened.status).toBe("draft");
    expect(reopened.subject).toBe("{{prenom}}, une idée pour {{entreprise}}");
    expect(reopened.body_html).toContain('data-variable="prenom"');
    // la version n'a pas bougé : le composeur ouvert continue d'enregistrer sans faux conflit
    const saved = await draft({ expected_version: reopened.draft_version });
    expect(saved.conflict).toBe(false);
  });
});

describe("historique et fil", () => {
  test("une seule entrée, décrite : objet, expéditeur, destinataires, aperçu", async () => {
    await draft({ cc: ["marc@studio.fr"] });
    await sendStored(sb, ID);
    await sendStored(sb, ID); // second appel (double clic tardif) : rien de plus
    const h = (await db.query<{ meta: Record<string, unknown>; person_id: string | null }>(`select meta, person_id from interactions where kind = 'message_out'`)).rows;
    expect(h).toHaveLength(1);
    expect(h[0].meta).toMatchObject({ subject: "Claire, une idée pour Studio Démo", from: "moi@cely.fr", to: ["claire@studio.fr"], cc: ["marc@studio.fr"], attachments: 0 });
    expect(String(h[0].meta.preview)).toContain("Bonjour Claire");
    expect(sends()).toHaveLength(1);
  });

  test("réponse : même fil Gmail, In-Reply-To et References vers le message d'origine", async () => {
    await draft();
    await sendStored(sb, ID);
    const first = await row();
    await saveDraft(sb, ID2, {
      company_id: company, to: ["claire@studio.fr"], subject: "Re: Claire, une idée pour Studio Démo", body: "", html: "<p>Je me permets de relancer.</p>",
      in_reply_to: first.rfc_message_id, references: first.rfc_message_id, thread_id: first.provider_thread_id,
    });
    gmail = () => json({ id: "gm2", threadId: "th1" });
    expect((await sendStored(sb, ID2)).provider_thread_id).toBe("th1");
    const { raw } = sentMime();
    expect(raw).toContain(`In-Reply-To: ${first.rfc_message_id}`);
    expect(raw).toContain(`References: ${first.rfc_message_id}`);
    expect(raw).toContain('"threadId":"th1"');
    expect((await row(ID2)).rfc_message_id).not.toBe(first.rfc_message_id);
  });
});
