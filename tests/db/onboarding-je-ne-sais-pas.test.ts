// Onboarding de l'offre découverte : « Je ne sais pas » et lien du site (migration 20261128090000).
// Réponses déjà enregistrées conservées, case cochée puis réponse (et l'inverse), lien recopié sur la fiche sans
// écraser un site que j'ai saisi, cloisonnement entre clients. Données fictives.
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigrations, createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

const BEFORE = "20261127100500";
let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let globex: Awaited<ReturnType<typeof company>>;
let pid: string;
let gid: string;
let alice: string;
let bob: string;
let gina: string;

const err = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; message: string }) => e.code ?? e.message);
type Answer = { value: string; unknown: boolean; rev: number; mine: boolean };
type View = { answers: Record<string, Answer> };
type Admin = View & { company_website: string | null; changes: { label: string; before: string | null; after: string | null }[] };
const answer = (session: string, key: string, value: string, rev: number, unknown?: boolean, p = pid) =>
  portal<{ ok: boolean; rev: number; conflict?: boolean; value?: string; unknown?: boolean }>(db, "portal_discovery_answer", session,
    { p_project: p, p_key: key, p_value: value, p_base_rev: rev, ...(unknown === undefined ? {} : { p_unknown: unknown }) });
const view = (session: string, p = pid) => portal<View>(db, "portal_discovery", session, { p_project: p });
const admin = async (p = pid) => { await db.as("owner"); return db.rpc<Admin>("discovery_admin", { p_project: p }); };
const website = async (id: string) => { await db.as("owner"); return (await db.one<{ website: string | null }>(`select website from companies where id = $1`, [id])).website; };

async function setup(d: Db) {
  await d.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(d, "[TEST] Acme", [{ first_name: "Alice", email: "alice@acme.test" }, { first_name: "Bob", email: "bob@acme.test" }]);
  globex = await company(d, "[TEST] Globex", [{ first_name: "Gina", email: "gina@globex.test" }]);
  pid = await project(d, acme.id, "Test découverte", [acme.people["alice@acme.test"], acme.people["bob@acme.test"]]);
  gid = await project(d, globex.id, "Autre client", [globex.people["gina@globex.test"]]);
  alice = (await login(d, acme.people["alice@acme.test"])).session;
  bob = (await login(d, acme.people["bob@acme.test"])).session;
  gina = (await login(d, globex.people["gina@globex.test"])).session;
  await d.as("owner");
  await d.rpc("discovery_set_enabled", { p_project: pid, p_enabled: true });
  await d.rpc("discovery_set_enabled", { p_project: gid, p_enabled: true });
}

describe("mise à niveau : onboarding commencé ou terminé avant la migration", () => {
  test("les réponses déjà enregistrées restent valides, case décochée par défaut ; l'ancien appel (sans p_unknown) fonctionne", async () => {
    db = await createDb({ upTo: BEFORE });
    await setup(db);
    await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "offer_pitch", p_value: "On fait X", p_base_rev: 0 });
    await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "problem", p_value: "", p_base_rev: 0 });
    await portal(db, "portal_discovery_send", alice, { p_project: pid });
    await applyMigrations(db, { after: BEFORE });

    const v = await view(alice);
    expect(v.answers.offer_pitch).toMatchObject({ value: "On fait X", unknown: false, rev: 1 });
    expect(v.answers.problem).toMatchObject({ value: "", unknown: false, rev: 1 });
    await db.as("owner");
    expect(await db.one(`select count(*)::int as n from discovery_answers where unknown`)).toEqual({ n: 0 });
    // une application pas encore mise à jour n'envoie pas p_unknown : même comportement qu'avant
    expect(await answer(alice, "offer_pitch", "On fait Y", 1)).toEqual({ ok: true, rev: 2 });
    expect((await view(alice)).answers.offer_pitch).toMatchObject({ value: "On fait Y", unknown: false });
    // après l'envoi, cocher « Je ne sais pas » reste possible et se voit dans les changements
    expect(await answer(alice, "problem", "", 1, true)).toEqual({ ok: true, rev: 2 });
    expect((await admin()).changes[0]).toMatchObject({ label: "problem", before: "", after: "Je ne sais pas" });
  });
});

describe("« Je ne sais pas »", () => {
  beforeEach(async () => { db = await createDb(); await setup(db); });

  test("cochée : réponse vide marquée, visible de l'autre contact et dans mon panneau", async () => {
    expect(await answer(alice, "results", "", 0, true)).toEqual({ ok: true, rev: 1 });
    expect((await view(bob)).answers.results).toMatchObject({ value: "", unknown: true, mine: false });
    expect((await admin()).answers.results).toMatchObject({ value: "", unknown: true });
    // même envoi répété (double clic, reprise réseau) : rien ne change
    expect(await answer(alice, "results", "", 1, true)).toEqual({ ok: true, rev: 1 });
  });

  test("cochée puis réponse saisie : la case se décoche ; réponse puis case cochée : la réponse s'efface", async () => {
    await answer(alice, "results", "", 0, true);
    expect(await answer(alice, "results", "−30 % en 3 mois", 1)).toEqual({ ok: true, rev: 2 });
    expect((await view(alice)).answers.results).toMatchObject({ value: "−30 % en 3 mois", unknown: false });
    expect(await answer(alice, "results", "", 2, true)).toEqual({ ok: true, rev: 3 });
    expect((await view(alice)).answers.results).toMatchObject({ value: "", unknown: true });
    // décochée sans réponse : ni réponse ni marque
    expect(await answer(alice, "results", "", 3, false)).toEqual({ ok: true, rev: 4 });
    expect((await view(alice)).answers.results).toMatchObject({ value: "", unknown: false });
  });

  test("une réponse saisie l'emporte toujours sur la case (jamais les deux à la fois)", async () => {
    await answer(alice, "problem", "Des pannes imprévues", 0, true);
    expect((await view(alice)).answers.problem).toMatchObject({ value: "Des pannes imprévues", unknown: false });
    await db.as("owner");
    expect(await err(db.query(`update discovery_answers set unknown = true where key = 'problem'`))).not.toBeNull(); // pas d'écriture directe
    await db.query(`reset role`);
    expect(await err(db.query(`update discovery_answers set unknown = true where key = 'problem'`))).toBe("23514"); // et la base refuse l'incohérence
  });

  test("deux contacts : case cochée sur une révision dépassée → conflit, rien n'est écrasé", async () => {
    await answer(alice, "competitors", "X et Y", 0);
    const r = await answer(bob, "competitors", "", 0, true);
    expect(r).toMatchObject({ ok: false, conflict: true, value: "X et Y", unknown: false, rev: 1 });
    expect((await view(alice)).answers.competitors).toMatchObject({ value: "X et Y", unknown: false });
    await answer(bob, "competitors", "", 1, true);
    expect(await answer(alice, "competitors", "X, Y et Z", 1)).toMatchObject({ ok: false, conflict: true, value: "", unknown: true, rev: 2 });
  });

  test("cloisonnement : un client ne lit ni ne modifie l'onboarding d'un autre", async () => {
    await answer(alice, "results", "", 0, true);
    expect(await err(answer(gina, "results", "", 0, true, pid))).toBe("P0002");
    expect(await err(view(gina, pid))).toBe("P0002");
    expect((await view(gina, gid)).answers.results).toBeUndefined();
    await db.as("anon");
    expect(await err(db.query(`select * from discovery_answers`))).not.toBeNull();
    await db.as("stranger");
    expect((await db.query(`select * from discovery_answers`)).rows).toHaveLength(0);
    expect(await err(db.rpc("discovery_admin", { p_project: pid }))).not.toBeNull();
  });
});

describe("lien du site (question 4)", () => {
  beforeEach(async () => { db = await createDb(); await setup(db); });

  test("fiche sans site : le lien du client y arrive, avec une ligne d'historique ; une correction suit", async () => {
    expect(await website(acme.id)).toBeNull();
    expect(await answer(alice, "website_url", "https://www.acme.test", 0)).toEqual({ ok: true, rev: 1 });
    expect(await website(acme.id)).toBe("https://www.acme.test");
    expect(await db.one(`select domain_norm from companies where id = $1`, [acme.id])).toEqual({ domain_norm: "acme.test" });
    expect(await db.one(`select count(*)::int as n from interactions where company_id = $1 and content like 'Site web renseigné par le client%'`, [acme.id])).toEqual({ n: 1 });
    expect(await admin()).toMatchObject({ company_website: "https://www.acme.test", answers: { website_url: { value: "https://www.acme.test", unknown: false } } });
    // le client corrige une faute de frappe : la fiche suit, puisque son site venait de l'onboarding
    await answer(bob, "website_url", "https://www.acme-industrie.test/fr", 1);
    expect(await website(acme.id)).toBe("https://www.acme-industrie.test/fr");
    // lien retiré : la fiche garde le dernier site connu
    await answer(bob, "website_url", "", 2);
    expect(await website(acme.id)).toBe("https://www.acme-industrie.test/fr");
    expect(await website(globex.id)).toBeNull(); // jamais la fiche d'un autre client
  });

  test("fiche avec un site que j'ai saisi : jamais écrasé, le lien du client reste lisible dans le panneau", async () => {
    await db.as("owner");
    await db.rpc("update_company", { p_id: acme.id, p_patch: JSON.stringify({ website: "acme-groupe.test" }), p_force: true });
    await answer(alice, "website_url", "https://www.acme.test", 0);
    expect(await website(acme.id)).toBe("acme-groupe.test");
    expect(await admin()).toMatchObject({ company_website: "acme-groupe.test", answers: { website_url: { value: "https://www.acme.test" } } });
  });

  test("lien invalide refusé par la base ; « Je ne sais pas » ne s'applique pas au lien", async () => {
    for (const bad of ["acme.test", "ftp://acme.test", "https://acme", "https://acme .test", "javascript:alert(1)", `https://acme.test/${"a".repeat(300)}`]) {
      expect(await err(answer(alice, "website_url", bad, 0)), bad).toBe("22023");
    }
    expect(await website(acme.id)).toBeNull();
    await answer(alice, "website_url", "", 0, true);
    expect((await view(alice)).answers.website_url).toMatchObject({ value: "", unknown: false });
  });
});
