// Ouverture du connecteur Claude (migrations 20261129090000 et 20261129100000), au niveau de la base :
// réparation de onboarding_ensure, mise à niveau avec des données en place, origine posée selon qui écrit
// (portail, application, Claude), droits (anon et compte sans droit refusés), application actuelle inchangée,
// lectures d'une fiche cloisonnées. Les outils eux-mêmes sont testés dans tests/mcp/outils-ouverture.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { applyMigrations, createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

const BEFORE = "20261128090000";
let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let alice: string;

const err = async (p: Promise<unknown>) => p.then(() => null, (e: { code?: string; message: string }) => e.message);
const one = async <T,>(q: string, params: unknown[] = []) => { await db.query("reset role"); return db.one<T>(q, params); };

async function setup(d: Db) {
  await d.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(d, "[TEST] Acme", [{ first_name: "Alice", email: "alice@acme.test" }]);
  pid = await project(d, acme.id, "Test découverte", [acme.people["alice@acme.test"]]);
  alice = (await login(d, acme.people["alice@acme.test"])).session;
  await d.as("owner");
  await d.rpc("discovery_set_enabled", { p_project: pid, p_enabled: true });
}

describe("réparation de onboarding_ensure", () => {
  test("la fonction disparue est recréée, avec ses droits, et l'API est invitée à recharger son cache", async () => {
    db = await createDb({ upTo: BEFORE });
    await setup(db);
    await db.exec("reset role; drop function public.onboarding_ensure(uuid);");
    await db.as("claude");
    expect(await err(db.rpc("onboarding_ensure", { p_project: pid }))).toMatch(/does not exist/);
    await applyMigrations(db, { after: BEFORE, upTo: "20261129090000" });
    await db.as("claude");
    // projet sans vente : pas de préparation, mais la fonction répond
    expect(await db.rpc("onboarding_ensure", { p_project: pid })).toBe(false);
    await db.as("anon");
    expect(await err(db.rpc("onboarding_ensure", { p_project: pid }))).toMatch(/permission denied/);
    await db.as("stranger");
    expect(await err(db.rpc("onboarding_ensure", { p_project: pid }))).toMatch(/Accès refusé/);
    const sql = readFileSync(join(__dirname, "..", "..", "supabase", "migrations", "20261129090000_onboarding_ensure_reparation.sql"), "utf8");
    expect(sql).toMatch(/notify pgrst, 'reload schema'/);
  });
});

describe("mise à niveau : onboarding déjà rempli par le client", () => {
  test("réponses, étapes et envoi existants gardent l'origine « client » ; rien d'autre ne change", async () => {
    db = await createDb({ upTo: BEFORE });
    await setup(db);
    await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "offer_pitch", p_value: "On fait X", p_base_rev: 0 });
    await portal(db, "portal_discovery_step", alice, { p_project: pid, p_step: "lemlist", p_status: "done" });
    await portal(db, "portal_discovery_send", alice, { p_project: pid });
    await applyMigrations(db, { after: BEFORE });
    expect(await one(`select value, origin, rev from discovery_answers where project_id = $1`, [pid])).toEqual({ value: "On fait X", origin: "client", rev: 1 });
    expect(await one(`select origin from discovery_steps where project_id = $1`, [pid])).toEqual({ origin: "client" });
    expect(await one(`select sent_origin from discovery_onboardings where project_id = $1`, [pid])).toEqual({ sent_origin: "client" });
    // Claude ne remplace pas la réponse du client, et ne peut pas annuler son envoi
    await db.as("claude");
    const kept = await db.rpc<{ status: string; current: { value: string; origin: string } }>("discovery_answer_save", { p_project: pid, p_key: "offer_pitch", p_value: "Autre", p_origin: "claude" });
    expect(kept).toMatchObject({ status: "kept", current: { value: "On fait X", origin: "client" } });
    expect(await err(db.rpc("discovery_mark_sent", { p_project: pid, p_sent: false, p_origin: "claude" }))).toMatch(/envoyé par le client/);
    expect(await db.rpc<{ status: string }>("discovery_step_save", { p_project: pid, p_step: "lemlist", p_status: "none", p_origin: "claude" })).toMatchObject({ status: "kept" });
  });
});

describe("origine des valeurs et droits", () => {
  beforeEach(async () => {
    db = await createDb();
    await setup(db);
  });

  test("l'origine suit celui qui écrit en dernier : Claude, puis le client, puis moi", async () => {
    await db.as("claude");
    expect(await db.rpc<{ status: string; origin: string }>("discovery_answer_save", { p_project: pid, p_key: "problem", p_value: "Hypothèse", p_origin: "claude" })).toMatchObject({ status: "saved", origin: "claude" });
    // le client corrige depuis son espace : sa valeur l'emporte et l'origine redevient « client »
    expect(await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "problem", p_value: "Ma réponse", p_base_rev: 1 })).toMatchObject({ ok: true, rev: 2 });
    expect(await one(`select value, origin from discovery_answers where project_id = $1 and key = 'problem'`, [pid])).toEqual({ value: "Ma réponse", origin: "client" });
    // le client ne voit jamais les origines
    const view = await portal<Record<string, unknown>>(db, "portal_discovery", alice, { p_project: pid });
    expect(JSON.stringify(view)).not.toMatch(/"origin|claude_filled|origins/);
    // une valeur dictée par moi (via Claude) est marquée « owner »
    await db.as("claude");
    await db.rpc("discovery_answer_save", { p_project: pid, p_key: "problem", p_value: "Version validée", p_origin: "owner", p_overwrite: true });
    expect(await one(`select origin from discovery_answers where project_id = $1 and key = 'problem'`, [pid])).toEqual({ origin: "owner" });
    const admin = await db.rpc<{ origins: { answers: Record<string, string> } }>("discovery_admin", { p_project: pid });
    expect(admin.origins.answers.problem).toBe("owner");
  });

  test("« je ne sais pas » du client : Claude peut compléter, la réponse saisie l'emporte", async () => {
    await portal(db, "portal_discovery_answer", alice, { p_project: pid, p_key: "result", p_value: "", p_base_rev: 0, p_unknown: true });
    await db.as("claude");
    const r = await db.rpc<{ status: string; replaced: { unknown: boolean } }>("discovery_answer_save", { p_project: pid, p_key: "result", p_value: "Proposition", p_origin: "claude" });
    expect(r).toMatchObject({ status: "saved", replaced: { unknown: true } });
    expect(await one(`select value, unknown, origin from discovery_answers where project_id = $1 and key = 'result'`, [pid])).toEqual({ value: "Proposition", unknown: false, origin: "claude" });
  });

  test("lien du site : validé en base, recopié sur la fiche vide, jamais par-dessus un site saisi", async () => {
    await db.as("claude");
    expect(await err(db.rpc("discovery_answer_save", { p_project: pid, p_key: "website_url", p_value: "pas un lien", p_origin: "claude" }))).toMatch(/Lien de site invalide/);
    expect(await db.rpc<{ fiche: string }>("discovery_answer_save", { p_project: pid, p_key: "website_url", p_value: "https://acme.example.fr", p_origin: "claude" })).toMatchObject({ fiche: "site recopié sur la fiche" });
    expect(await one(`select website from companies where id = $1`, [acme.id])).toEqual({ website: "https://acme.example.fr" });
    await db.exec(`reset role; update companies set website = 'https://saisi-par-moi.example.fr' where id = '${acme.id}';`);
    await db.as("claude");
    const r = await db.rpc<{ fiche: string }>("discovery_answer_save", { p_project: pid, p_key: "website_url", p_value: "https://autre.example.fr", p_origin: "claude" });
    expect(r.fiche).toMatch(/garde son site actuel/);
    expect(await one(`select website from companies where id = $1`, [acme.id])).toEqual({ website: "https://saisi-par-moi.example.fr" });
  });

  test("cibles : l'application garde son appel à 3 paramètres ; Claude ne remplace pas un champ du client", async () => {
    await db.as("owner");
    expect(await db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ name: "PME industrielles" }) })).toMatchObject({ changed: true, rev: 2 });
    await portal(db, "portal_discovery_target_fill", alice, { p_project: pid, p_position: 1, p_field: "geography", p_value: "Île-de-France", p_base_rev: 2 });
    await db.as("claude");
    const kept = await db.rpc<{ changed: boolean; kept: { field: string; origin: string }[] }>("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ name: "ETI", geography: "France", notes: "note" }), p_origin: "claude", p_overwrite: false });
    expect(kept.changed).toBe(false);
    expect(kept.kept).toEqual([expect.objectContaining({ field: "name", origin: "owner" }), expect.objectContaining({ field: "geography", origin: "client" })]);
    expect(await one(`select name, geography, notes from discovery_targets where project_id = $1 and position = 1`, [pid])).toEqual({ name: "PME industrielles", geography: "Île-de-France", notes: "" });
    // un champ vide se complète sans overwrite, et il est marqué
    expect(await db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ notes: "note" }), p_origin: "claude", p_overwrite: false })).toMatchObject({ changed: true });
    expect(await one(`select claude_filled from discovery_targets where project_id = $1 and position = 1`, [pid])).toEqual({ claude_filled: ["notes"] });
    // validée par le client puis modifiée par Claude : la validation tombe, comme dans l'application
    const rev = (await one<{ rev: number }>(`select rev from discovery_targets where project_id = $1 and position = 1`, [pid])).rev;
    await portal(db, "portal_discovery_target_validate", alice, { p_project: pid, p_position: 1, p_base_rev: rev, p_valid: true });
    await db.as("claude");
    expect(await db.rpc("discovery_target_save", { p_project: pid, p_position: 1, p_data: JSON.stringify({ notes: "note corrigée" }), p_origin: "claude", p_overwrite: false })).toMatchObject({ changed: true, validation_dropped: true });
  });

  test("fichier : seul un document prêt de la fiche du projet se rattache, au bon format", async () => {
    const other = await company(db, "[TEST] Globex", [{ first_name: "Gina", email: "gina@globex.test" }]);
    await db.exec("reset role");
    const mine = "11111111-1111-4111-8111-111111111111";
    const theirs = "22222222-2222-4222-8222-222222222222";
    await db.query(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, 'liste.csv', 'text/csv', 10, 'ready'), ($4, $5, $6, 'liste.csv', 'text/csv', 10, 'ready')`,
      [mine, acme.id, `${acme.id}/a.csv`, theirs, other.id, `${other.id}/b.csv`]);
    await db.as("claude");
    expect(await err(db.rpc("discovery_file_attach", { p_project: pid, p_step: "blacklist", p_file: theirs, p_origin: "claude" }))).toMatch(/Document introuvable/);
    expect(await err(db.rpc("discovery_file_attach", { p_project: pid, p_step: "linkedin", p_file: mine, p_account: "Alice", p_origin: "claude" }))).toMatch(/Format non accepté/);
    const r = await db.rpc<{ status: string; id: string }>("discovery_file_attach", { p_project: pid, p_step: "blacklist", p_file: mine, p_origin: "claude" });
    expect(r.status).toBe("saved");
    expect(await one(`select origin from discovery_files where id = $1`, [r.id])).toEqual({ origin: "claude" });
    // le client le voit dans son onboarding, sans pouvoir retirer un fichier qu'il n'a pas déposé
    const view = await portal<{ files: { name: string; mine: boolean | null }[] }>(db, "portal_discovery", alice, { p_project: pid });
    expect(view.files).toEqual([expect.objectContaining({ name: "liste.csv" })]);
    expect(await err(portal(db, "portal_discovery_file_remove", alice, { p_id: r.id }))).toMatch(/Seule la personne/);
  });

  test("droits : ni anon ni un compte sans droit ; chaque écriture de Claude est journalisée", async () => {
    const calls: [string, Record<string, unknown>][] = [
      ["discovery_answer_save", { p_project: pid, p_key: "problem", p_value: "x" }],
      ["discovery_step_save", { p_project: pid, p_step: "lemlist", p_status: "done" }],
      ["discovery_mark_sent", { p_project: pid, p_sent: true }],
      ["discovery_target_save", { p_project: pid, p_position: 1, p_data: "{}" }],
      ["discovery_set_enabled", { p_project: pid, p_enabled: false }],
      ["discovery_settings_save", { p_lemlist_invite_email: "x@exemple.test" }],
      ["discovery_file_detach", { p_id: pid }],
      ["company_calls", { p_company: acme.id, p_before: null, p_limit: 10 }],
      ["company_call_transcript", { p_company: acme.id, p_call: pid, p_offset: 0, p_limit: 10 }],
      ["company_mail_list", { p_company: acme.id, p_before: null, p_limit: 10 }],
      ["company_mail_thread", { p_company: acme.id, p_mail: pid, p_offset: 0, p_limit: 10 }],
    ];
    for (const [fn, args] of calls) {
      await db.as("anon");
      expect(await err(db.rpc(fn, args)), `anon ${fn}`).toMatch(/permission denied/);
      await db.as("stranger");
      expect(await err(db.rpc(fn, args)), `stranger ${fn}`).toMatch(/Accès refusé/);
    }
    // aucune écriture directe sur les tables, même pour Claude
    await db.as("claude");
    expect(await err(db.query(`update discovery_answers set value = 'x'`))).toMatch(/permission denied/);
    await db.rpc("discovery_answer_save", { p_project: pid, p_key: "problem", p_value: "x", p_origin: "claude" });
    await db.rpc("discovery_step_save", { p_project: pid, p_step: "lemlist", p_status: "done", p_origin: "owner" });
    await db.rpc("discovery_set_enabled", { p_project: pid, p_enabled: false });
    await db.query("reset role");
    const log = (await db.query<{ table_name: string; summary: string; company_id: string }>(`select table_name, summary, company_id from activity_log where actor = 'claude' and table_name like 'discovery_%' order by id`)).rows;
    expect(log).toEqual([
      { table_name: "discovery_answers", summary: "origine : claude", company_id: acme.id },
      { table_name: "discovery_steps", summary: "origine : owner", company_id: acme.id },
      { table_name: "discovery_onboardings", summary: "origine : owner", company_id: acme.id },
    ]);
    // l'application (moi, sans jeton Claude) n'écrit rien dans ce journal
    await db.as("owner");
    await db.rpc("discovery_set_enabled", { p_project: pid, p_enabled: true });
    expect((await one<{ n: number }>(`select count(*)::int as n from activity_log where table_name like 'discovery_%'`)).n).toBe(3);
  });

  test("emails d'une fiche : envoyés acceptés et reçus rattachés seulement", async () => {
    await db.exec(`reset role;
      insert into mail_messages (id, company_id, status, subject, body_text) values ('33333333-3333-4333-8333-333333333333', '${acme.id}', 'draft', 'Brouillon', 'pas envoyé');
      insert into mail_messages (id, company_id, direction, status, origin, from_addr, subject, body_text, received_at, link_state)
        values ('44444444-4444-4444-8444-444444444444', '${acme.id}', 'in', 'received', 'system', 'alice@acme.test', 'Réponse', 'Bonjour', now(), 'linked'),
               ('55555555-5555-4555-8555-555555555555', '${acme.id}', 'in', 'received', 'system', 'alice@acme.test', 'À rattacher', 'Bonjour', now(), 'to_link');`);
    await db.as("claude");
    const list = await db.rpc<{ objet: string; sens: string }[]>("company_mail_list", { p_company: acme.id, p_before: null, p_limit: 10 });
    expect(list.map((m) => [m.objet, m.sens])).toEqual([["Réponse", "reçu"]]);
    expect(await err(db.rpc("company_mail_thread", { p_company: acme.id, p_mail: "33333333-3333-4333-8333-333333333333", p_offset: 0, p_limit: 5 }))).toMatch(/Email introuvable/);
  });
});
