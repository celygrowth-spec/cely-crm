// Générer l'onboarding : la version du générateur suit les slides d'onboarding EXISTANTES du projet (aucun circuit
// parallèle), et rien ne se partage au client avant ma validation.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, sha } from "./projets-helpers";

let db: Db;
let company: string;
let project: string;
let dossier: string;

async function file(name: string) {
  await db.exec(`reset role;`);
  const f = await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, category, mime_type, size_bytes, status) values ($1, $2, $3, 'Présentation', 'application/pdf', 100, 'ready') returning id`, [company, `${company}/${crypto.randomUUID()}.pptx`, name]);
  await db.as("owner");
  return f.id;
}
/** Projet prêt : les points bloquants sont levés par l'analyse, comme dans le parcours existant. */
async function ready() {
  await db.rpc("onboarding_save_analysis", {
    p_project: project,
    p_sections: JSON.stringify({ objectives: [{ text: "Doubler les demandes" }], scope: [{ text: "SEO" }], deliverables: [{ text: "Plan d'action" }] }),
    p_items: "[]", p_start_date: "2026-12-01",
  });
  for (const i of (await db.query<{ id: string }>(`select id from project_onboarding_items where project_id = $1 and status = 'open' and required`, [project])).rows)
    await db.rpc("onboarding_answer", { p_item: i.id, p_action: "not_applicable" });
}
async function deck() {
  await db.as("owner");
  const d = await db.rpc<{ id: string; version: number }>("onboarding_deck_request", { p_project: project });
  await db.as("claude");
  const open = await db.rpc<{ id: string; version: number }>("onboarding_deck_open", { p_project: project });
  const slides = await file(`Onboarding V${open.version}.pptx`);
  await db.as("claude");
  await db.rpc("onboarding_deck_attach", { p_deck: open.id, p_file: slides });
  return { ...d, deck: open.id, slides };
}
const version = () => db.one<{ id: string; slides_status: string; file_id: string | null; slides_error: string | null }>(`select id, slides_status, file_id, slides_error from generator_versions where dossier_id = $1 order by version desc limit 1`, [dossier]);
const share = (deckId: string) => db.rpc("onboarding_share_deck", { p_project: project, p_deck: deckId, p_share: true, p_internal_folder: null }).catch(async (e) => {
  if (!/Dossier interne/.test(String(e))) throw e;
  const folder = await db.one<{ id: string }>(`select id from project_folders where project_id = $1 and not visible_to_client limit 1`, [project]);
  return db.rpc("onboarding_share_deck", { p_project: project, p_deck: deckId, p_share: true, p_internal_folder: folder.id });
});

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  const p = await db.one<{ id: string }>(`insert into pipelines (name) values ('[TEST] Ventes') returning id`);
  const stage = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Négociation', 0) returning id`, [p.id])).id;
  company = (await db.rpc<{ id: string }>("create_company", { p_company: JSON.stringify({ name: "[TEST] Client Onboarding" }), p_people: JSON.stringify([{ first_name: "Alice", email: "alice@test.fr" }]), p_force: true })).id;
  await db.rpc("move_company", { p_company: company, p_stage: stage });
  project = (await db.rpc<{ project_id: string }>("sale_confirm", { p_company: company, p_data: JSON.stringify({ revenue: { mode: "plus_tard" } }), p_idempotency_key: null })).project_id;
  await db.rpc("onboarding_prepare", { p_project: project });
  dossier = (await db.rpc<{ id: string }>("generator_start", { p_kind: "onboarding", p_company: company, p_project: project, p_key: "cle-onboarding-1" })).id;
});

describe("onboarding généré", () => {
  test("le dossier se rattache au projet de la fiche, pas à celui d'une autre", async () => {
    const other = (await db.rpc<{ id: string }>("create_company", { p_company: JSON.stringify({ name: "[TEST] Autre" }), p_people: "[]", p_force: true })).id;
    await expect(db.rpc("generator_start", { p_kind: "onboarding", p_company: other, p_project: project, p_key: "cle-onboarding-2" })).rejects.toThrow(/n'appartient pas à cette fiche/);
  });

  test("la version suit les slides du projet : prête à leur réception, avec le même fichier", async () => {
    await ready();
    await db.as("owner");
    await db.rpc("generator_generate", { p_id: dossier, p_key: "gen-0000001", p_feedback: null });
    expect((await version()).slides_status).toBe("pending");
    const d = await deck();
    await db.rpc("onboarding_deck_ready", { p_project: project, p_version: d.version });
    await db.as("owner");
    expect(await version()).toMatchObject({ slides_status: "ready", file_id: d.slides });
    // une seule série de slides : celles du projet
    expect((await db.one<{ n: number }>(`select count(*)::int n from project_onboarding_decks where project_id = $1`, [project])).n).toBe(1);
  });

  test("slides en échec : la version le dit et reste relançable", async () => {
    await ready();
    await db.as("owner");
    await db.rpc("generator_generate", { p_id: dossier, p_key: "gen-0000001", p_feedback: null });
    await db.rpc("onboarding_deck_request", { p_project: project });
    await db.as("claude");
    await db.rpc("onboarding_deck_failed", { p_project: project, p_message: "Modèle Cely introuvable" });
    await db.as("owner");
    const v = await version();
    expect(v).toMatchObject({ slides_status: "failed", slides_error: "Modèle Cely introuvable" });
    expect(await db.rpc("generator_retry_slides", { p_version: v.id })).toBe(dossier);
  });

  test("rien n'est partagé au client avant ma validation ; après, le partage reste mon action", async () => {
    await ready();
    await db.as("owner");
    await db.rpc("generator_generate", { p_id: dossier, p_key: "gen-0000001", p_feedback: null });
    const d = await deck();
    await db.rpc("onboarding_deck_ready", { p_project: project, p_version: d.version });
    await db.as("owner");
    await expect(share(d.deck)).rejects.toThrow(/Validez l'onboarding avant de partager/);
    expect((await db.one<{ shared_at: string | null }>(`select shared_at from project_onboarding_decks where id = $1`, [d.deck])).shared_at).toBeNull();
    await db.rpc("generator_validate", { p_version: (await version()).id });
    // la validation seule ne partage rien
    expect((await db.one<{ shared_at: string | null }>(`select shared_at from project_onboarding_decks where id = $1`, [d.deck])).shared_at).toBeNull();
    await share(d.deck);
    expect((await db.one<{ shared: boolean }>(`select shared_at is not null shared from project_onboarding_decks where id = $1`, [d.deck])).shared).toBe(true);
  });

  test("un projet sans dossier de générateur partage ses slides comme avant", async () => {
    await db.exec(`reset role; delete from generator_dossiers;`);
    await db.as("owner");
    await ready();
    const d = await deck();
    await db.rpc("onboarding_deck_ready", { p_project: project, p_version: d.version });
    await db.as("owner");
    await share(d.deck);
    expect((await db.one<{ shared: boolean }>(`select shared_at is not null shared from project_onboarding_decks where id = $1`, [d.deck])).shared).toBe(true);
  });
});
