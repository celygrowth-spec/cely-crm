// Outils MCP ouverts par 20261129100000 (onboarding découverte, fiche, lectures de fiche), testés de bout en bout :
// les vrais outils (src/lib/mcp), le vrai client Supabase, un jeton Claude, et le faux Supabase du dépôt
// (scripts/test-env/server.mjs : vraies migrations, vraies politiques RLS). Pour chaque outil d'écriture :
// cas nominal, refus sans confirmation (ou sans overwrite), idempotence sur request_id.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OFFER_QUESTIONS } from "@/lib/discovery/content";
import { discoveryForMcp } from "@/lib/discovery/mcp";
import { registerTools } from "@/lib/mcp/tools";

const PORT = 54400 + Math.floor(Math.random() * 400);
const URL_ = `http://127.0.0.1:${PORT}`;
const OWNER = "00000000-0000-0000-0000-000000000001";
const jwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.x`;
const CLAUDE = jwt({ sub: OWNER, role: "authenticated", client_id: "claude-test-client" });

let server: ChildProcess;
let sb: SupabaseClient;
type Handler = { cfg: { inputSchema: { parse: (a: unknown) => unknown } }; h: (args: unknown, ctx: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> };
const tools = new Map<string, Handler>();

/** Appelle un outil comme le ferait le serveur MCP : arguments validés par son schéma, réponse texte décodée. */
async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown>): Promise<{ error: boolean; raw: string; data: T }> {
  const t = tools.get(name);
  if (!t) throw new Error(`outil inconnu : ${name}`);
  const r = await t.h(t.cfg.inputSchema.parse(args), {});
  const raw = r.content[0].text;
  let data: unknown = raw;
  for (const candidate of [raw, raw.slice(raw.indexOf("\n\n") + 2)]) {
    try { data = JSON.parse(candidate); break; } catch { /* texte simple */ }
  }
  return { error: !!r.isError, raw, data: data as T };
}
async function sql<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
  const r = await fetch(`${URL_}/debug/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: query, params }) });
  if (!r.ok) throw new Error(await r.text());
  return (await r.json()) as T[];
}
const rid = () => randomUUID();
const claudeLog = (table: string) => sql<{ operation: string; summary: string; data: Record<string, unknown> }>(`select operation, summary, data from activity_log where actor = 'claude' and table_name = $1 order by id`, [table]);

let company: string;
let alice: string;
let project: string;

beforeAll(async () => {
  server = spawn(process.execPath, [join(__dirname, "..", "..", "scripts", "test-env", "server.mjs"), String(PORT)], { env: { ...process.env, TEST_ENV_EMPTY: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    server.stdout!.on("data", (d: Buffer) => d.toString().includes("mock supabase") && resolve());
    server.on("exit", (c) => reject(new Error(`serveur de test arrêté (${c})`)));
  });
  sb = createClient(URL_, "anon-key-local", { global: { headers: { Authorization: `Bearer ${CLAUDE}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  registerTools({ registerTool: (name: string, cfg: Handler["cfg"], h: Handler["h"]) => tools.set(name, { cfg, h }) } as never, () => sb);

  const c = await call<{ id: string }>("create_company", { name: "[TEST] Garage Martin", description: "Réseau de garages", people: [{ first_name: "Alice", last_name: "Martin", email: "alice@garage-martin.example.test", title: "Gérante" }], request_id: rid() });
  company = c.data.id;
  alice = (await sql<{ id: string }>(`select id from people where company_id = $1`, [company]))[0].id;
  const p = await call<{ id: string }>("create_project", { company_id: company, name: "[TEST] Offre découverte", person_ids: [alice], request_id: rid() });
  project = p.data.id;
}, 120_000);

afterAll(() => {
  server?.kill();
});

describe("onboarding de l'offre découverte", () => {
  test("set_discovery_enabled : active l'offre ; rejouée avec le même request_id, rend le même résultat", async () => {
    const request_id = rid();
    const a = await call("set_discovery_enabled", { project_id: project, enabled: true, request_id });
    expect(a.data.resultat).toBe("offre découverte activée");
    const b = await call("set_discovery_enabled", { project_id: project, enabled: true, request_id });
    expect(b.data).toEqual(a.data);
    expect((await sql(`select enabled from discovery_onboardings where project_id = $1`, [project]))[0].enabled).toBe(true);
    expect((await claudeLog("discovery_onboardings")).length).toBe(1);
  });

  test("save_discovery_answers : enregistre avec l'origine, « je ne sais pas » et le site ; idempotent", async () => {
    const request_id = rid();
    const args = {
      project_id: project, content_origin: "claude_suggestion", request_id, website_url: "garage-martin.example.fr",
      answers: [{ key: "offer_pitch", value: "On entretient les flottes des PME." }, { key: "main_objection", unknown: true }],
    };
    args.answers[1].key = OFFER_QUESTIONS.map((q) => q.key).find((k) => k !== "offer_pitch")!;
    const a = await call<{ resultat: string; enregistrees: { key: string; fiche?: string }[] }>("save_discovery_answers", args);
    expect(a.data.resultat).toBe("réponses enregistrées");
    expect(a.data.enregistrees.map((e) => e.key).sort()).toEqual(["offer_pitch", args.answers[1].key, "website_url"].sort());
    expect(a.data.enregistrees.find((e) => e.key === "website_url")!.fiche).toBe("site recopié sur la fiche");
    const rows = await sql<{ key: string; value: string; unknown: boolean; origin: string; rev: number }>(`select key, value, unknown, origin, rev from discovery_answers where project_id = $1 order by key`, [project]);
    expect(rows.every((r) => r.origin === "claude")).toBe(true);
    expect(rows.find((r) => r.key === args.answers[1].key)).toMatchObject({ value: "", unknown: true });
    expect(rows.find((r) => r.key === "website_url")!.value).toBe("https://garage-martin.example.fr");
    expect((await sql(`select website from companies where id = $1`, [company]))[0].website).toBe("https://garage-martin.example.fr");
    // rejeu : même réponse, aucune nouvelle révision
    const b = await call("save_discovery_answers", args);
    expect(b.data).toEqual(a.data);
    expect((await sql<{ rev: number }>(`select rev from discovery_answers where project_id = $1 and key = 'offer_pitch'`, [project]))[0].rev).toBe(1);
    // journal : une ligne par écriture, avec l'origine
    const log = await claudeLog("discovery_answers");
    expect(log.length).toBe(3);
    expect(log[0].summary).toBe("origine : claude");
    // get_project montre l'origine
    const g = (await discoveryForMcp(sb, project)) as { reponses: { key: string; origine: string | null }[]; site_web_origine: string };
    expect(g.reponses.find((r) => r.key === "offer_pitch")!.origine).toBe("proposée par Claude");
    expect(g.site_web_origine).toBe("proposée par Claude");
  });

  test("save_discovery_answers : une réponse du client est conservée et signalée, remplacée seulement avec overwrite", async () => {
    // le client a répondu depuis son espace (origine « client » posée par la base)
    await sql(`update discovery_answers set value = 'Notre offre, par le client', updated_at = now() where project_id = $1 and key = 'offer_pitch'`, [project]);
    expect((await sql(`select origin from discovery_answers where project_id = $1 and key = 'offer_pitch'`, [project]))[0].origin).toBe("client");
    const kept = await call<{ resultat: string; conservees: { key: string; valeur_en_place: string; saisie_par: string }[] }>("save_discovery_answers", { project_id: project, content_origin: "claude_suggestion", request_id: rid(), answers: [{ key: "offer_pitch", value: "Version de Claude" }] });
    expect(kept.data.resultat).toBe("rien n'a été écrit");
    expect(kept.data.conservees[0]).toMatchObject({ key: "offer_pitch", valeur_en_place: "Notre offre, par le client", saisie_par: "client (portail)" });
    expect((await sql(`select value from discovery_answers where project_id = $1 and key = 'offer_pitch'`, [project]))[0].value).toBe("Notre offre, par le client");
    const over = await call<{ enregistrees: { key: string; valeur_remplacee: string; saisie_par: string }[] }>("save_discovery_answers", { project_id: project, content_origin: "user", overwrite: true, request_id: rid(), answers: [{ key: "offer_pitch", value: "Version dictée par l'utilisateur" }] });
    expect(over.data.enregistrees[0]).toMatchObject({ valeur_remplacee: "Notre offre, par le client", saisie_par: "client (portail)" });
    expect((await sql(`select value, origin from discovery_answers where project_id = $1 and key = 'offer_pitch'`, [project]))[0]).toEqual({ value: "Version dictée par l'utilisateur", origin: "owner" });
  });

  test("save_discovery_targets : enregistre, marque les champs de Claude, conserve ceux de l'utilisateur ; idempotent", async () => {
    const request_id = rid();
    const args = { project_id: project, content_origin: "claude_suggestion", request_id, targets: [{ position: 1, name: "Flottes PME", sector: "Transport", roles: "Responsable de parc" }] };
    const a = await call<{ resultat: string }>("save_discovery_targets", args);
    expect(a.data.resultat).toBe("cibles enregistrées");
    const t1 = (await sql<{ name: string; claude_filled: string[]; rev: number }>(`select name, claude_filled, rev from discovery_targets where project_id = $1 and position = 1`, [project]))[0];
    expect(t1.name).toBe("Flottes PME");
    expect([...t1.claude_filled].sort()).toEqual(["name", "roles", "sector"]);
    expect((await call("save_discovery_targets", args)).data).toEqual(a.data);
    expect((await sql<{ rev: number }>(`select rev from discovery_targets where project_id = $1 and position = 1`, [project]))[0].rev).toBe(t1.rev);
    // l'utilisateur corrige le secteur dans l'application : ce champ n'est plus « proposé par Claude »
    await sql(`update discovery_targets set sector = 'Transport routier' where project_id = $1 and position = 1`, [project]);
    expect((await sql<{ claude_filled: string[] }>(`select claude_filled from discovery_targets where project_id = $1 and position = 1`, [project]))[0].claude_filled).not.toContain("sector");
    const kept = await call<{ resultat: string; cibles: { etat: string; champs_conserves: { champ: string; valeur_en_place: string }[] }[] }>("save_discovery_targets", { project_id: project, content_origin: "claude_suggestion", request_id: rid(), targets: [{ position: 1, sector: "Logistique", notes: "À creuser" }] });
    expect(kept.data.resultat).toBe("rien n'a été écrit");
    expect(kept.data.cibles[0].champs_conserves[0]).toMatchObject({ champ: "secteur", valeur_en_place: "Transport routier" });
    const over = await call<{ cibles: { valeurs_remplacees: { champ: string; avant: string }[] }[] }>("save_discovery_targets", { project_id: project, content_origin: "claude_suggestion", overwrite: true, request_id: rid(), targets: [{ position: 1, sector: "Logistique" }] });
    expect(over.data.cibles[0].valeurs_remplacees[0]).toMatchObject({ champ: "secteur", avant: "Transport routier" });
    expect((await claudeLog("discovery_targets")).length).toBeGreaterThanOrEqual(2);
  });

  test("set_discovery_steps : enregistre les étapes ; recap exige toujours l'accord ; idempotent", async () => {
    const request_id = rid();
    const args = { project_id: project, content_origin: "user", request_id, steps: [{ step: "lemlist", status: "done" }, { step: "blacklist", status: "none" }] };
    const a = await call<{ resultat: string }>("set_discovery_steps", args);
    expect(a.data.resultat).toBe("étapes enregistrées");
    expect(await sql(`select step, status, origin from discovery_steps where project_id = $1 order by step`, [project])).toEqual([{ step: "blacklist", status: "none", origin: "owner" }, { step: "lemlist", status: "done", origin: "owner" }]);
    expect((await call("set_discovery_steps", args)).data).toEqual(a.data);
    // recap sans accord : rien
    const wait = await call<{ resultat: string }>("set_discovery_steps", { project_id: project, content_origin: "user", request_id: rid(), steps: [{ step: "recap", status: "done" }] });
    expect(wait.data.resultat).toBe("rien n'a été fait");
    expect((await sql(`select sent_at from discovery_onboardings where project_id = $1`, [project]))[0].sent_at).toBeNull();
    const sent = await call<{ etapes: { etape: string; etat: string }[] }>("set_discovery_steps", { project_id: project, content_origin: "user", confirmed_by_user: true, request_id: rid(), steps: [{ step: "recap", status: "done" }] });
    expect(sent.data.etapes[0]).toMatchObject({ etape: "recap", etat: "enregistrée" });
    expect((await sql(`select sent_origin from discovery_onboardings where project_id = $1`, [project]))[0].sent_origin).toBe("owner");
    // annulation de mon propre envoi
    await call("set_discovery_steps", { project_id: project, content_origin: "user", confirmed_by_user: true, request_id: rid(), steps: [{ step: "recap", status: null }] });
    expect((await sql(`select sent_at from discovery_onboardings where project_id = $1`, [project]))[0].sent_at).toBeNull();
  });

  let discoveryFile: string;
  test("fichier : dépôt, rattachement à l'étape avec son origine ; idempotent", async () => {
    const body = "email\nclient@exemple.test\n";
    const s = await call<{ file_id: string; adresse_depot: string; content_type: string }>("start_discovery_file_upload", { project_id: project, step: "blacklist", name: "blacklist.csv", size_bytes: body.length });
    expect(s.data.content_type).toBe("text/csv");
    expect((await fetch(s.data.adresse_depot, { method: "PUT", headers: { "content-type": s.data.content_type }, body })).ok).toBe(true);
    const request_id = rid();
    const args = { project_id: project, file_id: s.data.file_id, step: "blacklist", content_origin: "user", request_id };
    const a = await call<{ resultat: string; id: string }>("confirm_discovery_file_upload", args);
    expect(a.data.resultat).toBe("fichier rattaché à l'onboarding");
    discoveryFile = a.data.id;
    expect((await call("confirm_discovery_file_upload", args)).data).toEqual(a.data);
    expect(await sql(`select step, origin from discovery_files where project_id = $1`, [project])).toEqual([{ step: "blacklist", origin: "owner" }]);
    // rangé dans le dossier interne, jamais visible du client
    expect((await sql(`select f.visible_to_client from project_files pf join project_folders f on f.id = pf.folder_id where pf.file_id = $1`, [s.data.file_id]))[0].visible_to_client).toBe(false);
    // un format refusé pour l'étape
    const bad = await call("start_discovery_file_upload", { project_id: project, step: "linkedin", name: "archive.pdf", size_bytes: 10 });
    expect(bad.error).toBe(true);
  });

  test("projet publié : sans confirmed_by_user rien n'est écrit et l'effet est décrit", async () => {
    await call("update_project", { project_id: project, portal_published: true, confirmed_by_user: true });
    const before = await sql(`select key, value, rev from discovery_answers where project_id = $1 order by key`, [project]);
    const w = await call<{ resultat: string; effets: { key: string; effet: string }[] }>("save_discovery_answers", { project_id: project, content_origin: "claude_suggestion", request_id: rid(), answers: [{ key: "offer_pitch", value: "Nouvelle version" }] });
    expect(w.data.resultat).toBe("rien n'a été fait");
    expect(w.data.effets[0].effet).toMatch(/^conservée : valeur déjà saisie par utilisateur/);
    expect(await sql(`select key, value, rev from discovery_answers where project_id = $1 order by key`, [project])).toEqual(before);

    const t = await call<{ resultat: string }>("save_discovery_targets", { project_id: project, content_origin: "claude_suggestion", request_id: rid(), targets: [{ position: 2, name: "Concessions" }] });
    expect(t.data.resultat).toBe("rien n'a été fait");
    expect((await sql(`select name from discovery_targets where project_id = $1 and position = 2`, [project]))[0].name).toBe("");

    const st = await call<{ resultat: string }>("set_discovery_steps", { project_id: project, content_origin: "user", request_id: rid(), steps: [{ step: "linkedin", status: "later" }] });
    expect(st.data.resultat).toBe("rien n'a été fait");
    expect(await sql(`select 1 from discovery_steps where project_id = $1 and step = 'linkedin'`, [project])).toEqual([]);

    const off = await call<{ resultat: string }>("set_discovery_enabled", { project_id: project, enabled: false, request_id: rid() });
    expect(off.data.resultat).toBe("rien n'a été fait");
    expect((await sql(`select enabled from discovery_onboardings where project_id = $1`, [project]))[0].enabled).toBe(true);

    const s = await call<{ file_id: string; adresse_depot: string }>("start_discovery_file_upload", { project_id: project, step: "documents", name: "plaquette.pdf", size_bytes: 4 });
    await fetch(s.data.adresse_depot, { method: "PUT", headers: { "content-type": "application/pdf" }, body: "%PDF" });
    const f = await call<{ resultat: string }>("confirm_discovery_file_upload", { project_id: project, file_id: s.data.file_id, step: "documents", content_origin: "user", request_id: rid() });
    expect(f.data.resultat).toBe("rien n'a été fait");
    expect((await sql(`select count(*)::int n from discovery_files where project_id = $1`, [project]))[0].n).toBe(1);

    // avec l'accord : écrit
    const ok = await call<{ resultat: string }>("save_discovery_targets", { project_id: project, content_origin: "claude_suggestion", confirmed_by_user: true, request_id: rid(), targets: [{ position: 2, name: "Concessions" }] });
    expect(ok.data.resultat).toBe("cibles enregistrées");
  });

  test("remove_discovery_file : accord exigé, document conservé sur la fiche ; idempotent", async () => {
    const w = await call<{ resultat: string }>("remove_discovery_file", { project_id: project, discovery_file_id: discoveryFile, request_id: rid() });
    expect(w.data.resultat).toBe("rien n'a été fait");
    const request_id = rid();
    const a = await call<{ resultat: string; nom: string }>("remove_discovery_file", { project_id: project, discovery_file_id: discoveryFile, confirmed_by_user: true, request_id });
    expect(a.data.nom).toBe("blacklist.csv");
    expect((await call("remove_discovery_file", { project_id: project, discovery_file_id: discoveryFile, confirmed_by_user: true, request_id })).data).toEqual(a.data);
    expect(await sql(`select 1 from discovery_files where id = $1`, [discoveryFile])).toEqual([]);
    expect((await sql(`select count(*)::int n from company_files where company_id = $1 and display_name = 'blacklist.csv'`, [company]))[0].n).toBe(1);
  });

  test("un fichier déposé par le client ne se retire pas par le connecteur", async () => {
    const id = randomUUID();
    await sql(`insert into company_files (id, company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1, $2, $3, 'archive-client.zip', 'application/zip', 10, 'ready')`, [id, company, `${company}/${id}.zip`]);
    const df = (await sql<{ id: string }>(`insert into discovery_files (project_id, step, file_id, account_name, person_id) values ($1, 'linkedin', $2, 'Alice Martin', $3) returning id`, [project, id, alice]))[0].id;
    expect((await sql(`select origin from discovery_files where id = $1`, [df]))[0].origin).toBe("client");
    const r = await call("remove_discovery_file", { project_id: project, discovery_file_id: df, confirmed_by_user: true, request_id: rid() });
    expect(r.error).toBe(true);
    expect(r.raw).toMatch(/déposé par le client/);
  });

  test("save_discovery_settings : accord exigé ; idempotent", async () => {
    const w = await call<{ resultat: string }>("save_discovery_settings", { lemlist_invite_email: "equipe@exemple.test", request_id: rid() });
    expect(w.data.resultat).toBe("rien n'a été fait");
    const request_id = rid();
    const a = await call("save_discovery_settings", { lemlist_invite_email: "equipe@exemple.test", confirmed_by_user: true, request_id });
    expect((await call("save_discovery_settings", { lemlist_invite_email: "equipe@exemple.test", confirmed_by_user: true, request_id })).data).toEqual(a.data);
    expect((await sql(`select lemlist_invite_email from discovery_settings`))[0].lemlist_invite_email).toBe("equipe@exemple.test");
  });

  test("projet sans onboarding : les outils d'écriture le disent", async () => {
    const p = await call<{ id: string }>("create_project", { company_id: company, name: "[TEST] Sans offre", request_id: rid() });
    const r = await call("save_discovery_answers", { project_id: p.data.id, content_origin: "user", request_id: rid(), answers: [{ key: "offer_pitch", value: "x" }] });
    expect(r.error).toBe(true);
    expect(r.raw).toMatch(/set_discovery_enabled/);
  });
});

describe("fiche entreprise", () => {
  test("update_company : complète la fiche, note l'historique ; idempotent", async () => {
    const request_id = rid();
    const args = { company_id: company, tags: ["garage", "flotte"], amount_eur: 500, content_origin: "user", request_id };
    const a = await call<{ resultat: string; changements: { champ: string }[] }>("update_company", args);
    expect(a.data.resultat).toBe("fiche modifiée");
    expect(a.data.changements.map((c) => c.champ)).toEqual(["tags", "montant (€)"]);
    expect((await call("update_company", args)).data).toEqual(a.data);
    const c = (await sql<{ tags: string[]; amount: string }>(`select tags, amount from companies where id = $1`, [company]))[0];
    expect([...c.tags].sort()).toEqual(["flotte", "garage"]);
    expect(Number(c.amount)).toBe(500);
    const h = await sql<{ content: string; source: string }>(`select content, source from interactions where company_id = $1 and content like 'Fiche modifiée via Claude%'`, [company]);
    expect(h.length).toBe(1);
    expect(h[0].source).toBe("claude");
    expect((await claudeLog("companies")).length).toBeGreaterThan(0);
  });

  test("update_company : une valeur en place n'est pas remplacée sans overwrite", async () => {
    const kept = await call<{ resultat: string; valeurs_en_place: { champ: string; valeur_en_place: string }[] }>("update_company", { company_id: company, description: "Nouvelle description", content_origin: "claude_suggestion", request_id: rid() });
    expect(kept.data.resultat).toBe("rien n'a été fait");
    expect(kept.data.valeurs_en_place[0]).toMatchObject({ champ: "description", valeur_en_place: "Réseau de garages" });
    expect((await sql(`select description from companies where id = $1`, [company]))[0].description).toBe("Réseau de garages");
    const over = await call<{ changements: { champ: string; avant: string; apres: string }[] }>("update_company", { company_id: company, description: "Nouvelle description", content_origin: "claude_suggestion", overwrite: true, request_id: rid() });
    expect(over.data.changements[0]).toEqual({ champ: "description", avant: "Réseau de garages", apres: "Nouvelle description" });
    // la valeur d'avant reste lisible dans l'historique
    expect((await sql<{ content: string }>(`select content from interactions where company_id = $1 and content like '%proposées par Claude%'`, [company]))[0].content).toContain("Réseau de garages");
  });

  test("update_person : complète sans écraser ; overwrite pour remplacer ; idempotent", async () => {
    const request_id = rid();
    const args = { company_id: company, person_id: alice, phone: "+33 6 00 00 00 00", linkedin_url: "https://www.linkedin.com/in/alice-martin-test", content_origin: "user", request_id };
    const a = await call<{ resultat: string }>("update_person", args);
    expect(a.data.resultat).toBe("personne modifiée");
    expect((await call("update_person", args)).data).toEqual(a.data);
    const p = (await sql<{ phone: string; title: string; email: string }>(`select phone, title, email from people where id = $1`, [alice]))[0];
    expect(p).toEqual({ phone: "+33 6 00 00 00 00", title: "Gérante", email: "alice@garage-martin.example.test" });
    const kept = await call<{ resultat: string }>("update_person", { company_id: company, person_id: alice, title: "Directrice", content_origin: "claude_suggestion", request_id: rid() });
    expect(kept.data.resultat).toBe("rien n'a été fait");
    expect((await sql(`select title from people where id = $1`, [alice]))[0].title).toBe("Gérante");
    await call("update_person", { company_id: company, person_id: alice, title: "Directrice", content_origin: "user", overwrite: true, request_id: rid() });
    expect((await sql(`select title from people where id = $1`, [alice]))[0].title).toBe("Directrice");
    expect((await sql(`select count(*)::int n from interactions where company_id = $1 and content like 'Personne modifiée via Claude%'`, [company]))[0].n).toBe(2);
  });

  test("set_company_archived et add_company_to_list ; idempotents", async () => {
    const r1 = rid();
    expect((await call("set_company_archived", { company_id: company, archived: true, request_id: r1 })).data.resultat).toBe("fiche archivée");
    expect((await call("set_company_archived", { company_id: company, archived: true, request_id: r1 })).data.resultat).toBe("fiche archivée");
    expect((await sql(`select archived_at from companies where id = $1`, [company]))[0].archived_at).not.toBeNull();
    await call("set_company_archived", { company_id: company, archived: false, request_id: rid() });
    expect((await sql(`select archived_at from companies where id = $1`, [company]))[0].archived_at).toBeNull();

    const list = (await sql<{ id: string }>(`insert into lists (name) values ('[TEST] Garages') returning id`))[0].id;
    expect((await call<{ id: string }[]>("list_lists", {})).data.map((l) => l.id)).toContain(list);
    const r2 = rid();
    expect((await call("add_company_to_list", { company_id: company, list_id: list, request_id: r2 })).data).toEqual({ resultat: "fiche ajoutée à la liste", liste: "[TEST] Garages" });
    expect((await call("add_company_to_list", { company_id: company, list_id: list, request_id: r2 })).data).toEqual({ resultat: "fiche ajoutée à la liste", liste: "[TEST] Garages" });
    expect((await call("add_company_to_list", { company_id: company, list_id: list, request_id: rid() })).data.resultat).toBe("la fiche était déjà dans cette liste");
    expect((await sql(`select count(*)::int n from list_members where list_id = $1 and company_id = $2`, [list, company]))[0].n).toBe(1);
  });

  test("fichier de fiche : dépôt, confirmation idempotente, liste, lecture, renommage", async () => {
    const body = "Compte rendu du rendez-vous de cadrage.";
    const s = await call<{ file_id: string; adresse_depot: string }>("start_company_file_upload", { company_id: company, name: "cadrage.txt", mime_type: "text/plain", size_bytes: body.length, category: "Brief" });
    await fetch(s.data.adresse_depot, { method: "PUT", headers: { "content-type": "text/plain" }, body });
    const request_id = rid();
    const a = await call<{ resultat: string; nom: string }>("confirm_company_file_upload", { company_id: company, file_id: s.data.file_id, content_origin: "claude_suggestion", request_id });
    expect(a.data).toEqual({ resultat: "fichier reçu, visible sur la fiche", nom: "cadrage.txt" });
    expect((await call("confirm_company_file_upload", { company_id: company, file_id: s.data.file_id, content_origin: "claude_suggestion", request_id })).data).toEqual(a.data);
    expect((await sql(`select count(*)::int n from interactions where company_id = $1 and content like 'Fichier « cadrage.txt » déposé via Claude%'`, [company]))[0].n).toBe(1);
    const files = await call<{ id: string; display_name: string }[]>("list_company_files", { company_id: company });
    expect(files.data.map((f) => f.display_name)).toContain("cadrage.txt");
    const r2 = rid();
    const u = await call("update_company_file", { company_id: company, file_id: s.data.file_id, name: "Cadrage du projet.txt", category: "Autre", request_id: r2 });
    expect(u.data).toEqual({ resultat: "fichier modifié", nom: "Cadrage du projet.txt", categorie: "Autre" });
    expect((await call("update_company_file", { company_id: company, file_id: s.data.file_id, name: "Cadrage du projet.txt", category: "Autre", request_id: r2 })).data).toEqual(u.data);
    // un fichier d'une autre fiche est refusé
    const other = await call<{ id: string }>("create_company", { name: "[TEST] Autre société", request_id: rid() });
    expect((await call("get_company_file_url", { company_id: other.data.id, file_id: s.data.file_id })).error).toBe(true);
  });

  test("appels et emails d'une fiche, sans dossier de diagnostic", async () => {
    const callId = (await sql<{ id: string }>(`insert into fireflies_calls (account_id, fireflies_id, title) values ('c', $1, '[TEST] Appel de cadrage') returning id`, [randomUUID()]))[0].id;
    await sql(`update fireflies_calls set link_state = 'linked', company_id = $1, occurred_at = now() where id = $2`, [company, callId]);
    await sql(`insert into fireflies_call_transcripts (call_id, lines) values ($1, '[{"text":"un"},{"text":"deux"},{"text":"trois"}]')`, [callId]);
    const calls = await call<{ id: string; titre: string }[]>("list_company_calls", { company_id: company });
    expect(calls.data).toHaveLength(1);
    expect(calls.data[0]).toMatchObject({ id: callId, titre: "[TEST] Appel de cadrage" });
    const tr = await call<{ total: number; lignes: { text: string }[] }>("get_company_call_transcript", { company_id: company, call_id: callId, offset: 1, limit: 2 });
    expect(tr.data.total).toBe(3);
    expect(tr.data.lignes.map((l) => l.text)).toEqual(["deux", "trois"]);

    const mail = randomUUID();
    await sql(`insert into mail_messages (id, company_id, status, subject, body_text, to_addrs, provider_thread_id) values ($1, $2, 'draft', 'Proposition', 'Bonjour Alice, voici la proposition.', '{alice@garage-martin.example.test}', 'fil-1')`, [mail, company]);
    await sql(`update mail_messages set status = 'sending' where id = $1`, [mail]);
    await sql(`update mail_messages set status = 'accepted', sent_at = now() where id = $1`, [mail]);
    const mails = await call<{ id: string; sens: string; objet: string }[]>("list_company_emails", { company_id: company });
    expect(mails.data).toEqual([expect.objectContaining({ id: mail, sens: "envoyé", objet: "Proposition" })]);
    const thread = await call<{ corps: string }[]>("get_company_email_thread", { company_id: company, mail_id: mail });
    expect(thread.data[0].corps).toBe("Bonjour Alice, voici la proposition.");

    // cloisonnement : l'appel et l'email d'une fiche ne se lisent pas depuis une autre
    const other = await call<{ id: string }>("create_company", { name: "[TEST] Société voisine", request_id: rid() });
    expect((await call<unknown[]>("list_company_calls", { company_id: other.data.id })).data).toEqual([]);
    expect((await call("get_company_call_transcript", { company_id: other.data.id, call_id: callId })).error).toBe(true);
    expect((await call("get_company_email_thread", { company_id: other.data.id, mail_id: mail })).error).toBe(true);

    const hist = await call<{ content: string }[]>("list_company_history", { company_id: company, limit: 5 });
    expect(hist.data.length).toBeGreaterThan(0);
    expect(typeof (await call("list_company_appointments", { company_id: company })).raw).toBe("string");
  });
});
