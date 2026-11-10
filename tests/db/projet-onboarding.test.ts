// « Gagné » → projet créé une seule fois, préparé depuis les sources, complété, puis slides d'onboarding.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, login, portal, sha } from "./projets-helpers";

let db: Db;
let stage: string;

beforeEach(async () => {
  db = await createDb();
  await db.as("owner");
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  const p = await db.one<{ id: string }>(`insert into pipelines (name) values ('[TEST] Ventes') returning id`);
  stage = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Négociation', 0) returning id`, [p.id])).id;
});

async function fiche(name: string, people: { first_name: string; email: string }[] = [{ first_name: "Alice", email: "alice@test.fr" }]) {
  await db.as("owner");
  const id = (await db.rpc<{ id: string }>("create_company", { p_company: JSON.stringify({ name }), p_people: JSON.stringify(people), p_force: true })).id;
  await db.rpc("move_company", { p_company: id, p_stage: stage });
  return id;
}

async function file(company: string, name: string, category: string | null) {
  await db.exec(`reset role;`);
  const f = await db.one<{ id: string }>(
    `insert into company_files (company_id, storage_path, display_name, category, mime_type, size_bytes, status)
     values ($1, $2, $3, $4, 'application/pdf', 100, 'ready') returning id`, [company, `${company}/${crypto.randomUUID()}.pdf`, name, category]);
  await db.as("owner");
  return f.id;
}

async function call(company: string, summary: Record<string, unknown>) {
  await db.exec(`reset role;`);
  const c = await db.one<{ id: string }>(
    `insert into fireflies_calls (account_id, fireflies_id, title, occurred_at, summary, summary_state) values ('c', $1, '[TEST] Appel de vente', now(), $2, 'available') returning id`,
    [crypto.randomUUID(), JSON.stringify(summary)]);
  await db.query(`update fireflies_calls set link_state = 'linked', company_id = $1 where id = $2`, [company, c.id]);
  await db.as("owner");
  return c.id;
}

async function diagnostic(company: string) {
  await db.as("owner");
  const id = await db.rpc<string>("diagnostic_start", { p_company: company, p_key: `cle-${crypto.randomUUID()}` });
  await db.exec(`reset role;`);
  await db.query(`update diagnostics set summary = $2, status = 'version_ready' where id = $1`, [id, "Le site perd 40 % de trafic organique depuis la refonte.\n\nLes fiches produit n'ont pas de contenu unique."]);
  await db.query(`insert into diagnostic_versions (diagnostic_id, version, status, ready_at) values ($1, 1, 'ready', now())`, [id]);
  await db.as("owner");
  return id;
}

const win = (company: string) => db.rpc<{ project_id: string; closing_id: string; created: boolean }>("project_win_deal", { p_company: company });
const status = async (project: string) => (await db.one<{ status: string }>(`select status from project_onboarding_status where project_id = $1`, [project])).status;
const openItems = async (project: string) =>
  (await db.query<{ key: string; required: boolean }>(`select key, required from project_onboarding_items where project_id = $1 and status = 'open' order by priority`, [project])).rows;
const item = async (project: string, key: string) => db.one<{ id: string; status: string; answered_by: string | null; answer: string | null }>(
  `select id, status, answered_by, answer from project_onboarding_items where project_id = $1 and key = $2`, [project, key]);

describe("Gagné → projet", () => {
  test("crée la vente et le projet une seule fois, même après double clic, relance ou réouverture", async () => {
    const c = await fiche("[TEST] Client Alpha");
    const a = await win(c);
    expect(a.created).toBe(true);
    const b = await win(c);
    expect(b).toEqual({ ...a, created: false });
    expect(await db.one(`select deal_status, deal_closed_at is not null as date from companies where id = $1`, [c])).toEqual({ deal_status: "won", date: true });
    await db.rpc("set_deal_status", { p_company: c, p_status: "open" });
    const again = await win(c);
    expect(again.project_id).toBe(a.project_id);
    expect(again.closing_id).toBe(a.closing_id);
    expect(await db.one(`select count(*)::int n from projects where company_id = $1`, [c])).toEqual({ n: 1 });
    const p = await db.one<{ status: string; member_count: number; company_name: string }>(`select status, member_count, company_name from project_overview where id = $1`, [a.project_id]);
    expect(p).toEqual({ status: "a_preparer", member_count: 1, company_name: "[TEST] Client Alpha" });
    expect(await status(a.project_id)).toBe("preparing");
  });

  test("une nouvelle vente après un projet terminé crée un second projet distinct", async () => {
    const c = await fiche("[TEST] Client Beta");
    const a = await win(c);
    await db.query(`update projects set status = 'termine' where id = $1`, [a.project_id]);
    await db.rpc("set_deal_status", { p_company: c, p_status: "open" });
    const b = await win(c);
    expect(b.created).toBe(true);
    expect(b.project_id).not.toBe(a.project_id);
    expect(b.closing_id).not.toBe(a.closing_id);
    const names = (await db.query<{ name: string }>(`select name from projects where company_id = $1 order by created_at`, [c])).rows.map((r) => r.name);
    expect(names[0]).toBe("[TEST] Client Beta");
    expect(names[1]).toMatch(/^\[TEST\] Client Beta · \d\d\/\d{4}$/);
  });

  test("une fiche hors pipeline n'est ni gagnée ni dotée d'un projet", async () => {
    const id = (await db.rpc<{ id: string }>("create_company", { p_company: JSON.stringify({ name: "[TEST] Hors pipeline" }), p_people: "[]", p_force: true })).id;
    await expect(win(id)).rejects.toThrow(/pipeline/);
    expect(await db.one(`select count(*)::int n from projects where company_id = $1`, [id])).toEqual({ n: 0 });
  });

  test("un inconnu et le portail n'y ont pas accès", async () => {
    const c = await fiche("[TEST] Client Gamma");
    const a = await win(c);
    await db.as("stranger");
    await expect(win(c)).rejects.toThrow();
    expect((await db.query(`select * from project_onboarding`)).rows).toHaveLength(0);
    await db.as("anon");
    await expect(db.query(`select * from project_onboarding_items`)).rejects.toThrow(/permission/);
    await expect(db.rpc("onboarding_prepare", { p_project: a.project_id })).rejects.toThrow(/permission/);
  });
});

describe("parcours 1 : proposition, Fireflies et diagnostic suffisent", () => {
  test("le projet est prérempli avec ses sources, puis prêt après l'analyse et les slides sont déposées", async () => {
    const c = await fiche("[TEST] Client Delta");
    const contrat = await file(c, "Contrat signé.pdf", "Contrat");
    const appel = await call(c, { short_summary: "Le client veut regagner son trafic SEO avant le printemps.", action_items: "- Envoyer l'accès Search Console\n- Lister les pages prioritaires" });
    const diag = await diagnostic(c);
    const { project_id: p } = await win(c);
    await db.rpc("onboarding_prepare", { p_project: p });

    const o = await db.one<{ proposal_file_id: string; diagnostic_id: string; sections: Record<string, { items: { text: string; refs: { kind: string; id: string }[]; suggested?: boolean }[] }> }>(
      `select proposal_file_id, diagnostic_id, sections from project_onboarding where project_id = $1`, [p]);
    expect(o.proposal_file_id).toBe(contrat);
    expect(o.diagnostic_id).toBe(diag);
    expect(o.sections.context.items[0]).toMatchObject({ text: expect.stringContaining("trafic SEO"), refs: [{ kind: "call", id: appel }] });
    expect(o.sections.findings.items).toHaveLength(2);
    expect(o.sections.first_actions.items.every((x) => x.suggested)).toBe(true);
    expect(o.sections.first_actions.items.map((x) => x.text)).toContain("Envoyer l'accès Search Console");
    // le CRM ne lit pas le contenu du contrat : il le dit, au lieu d'inventer le périmètre
    expect(await openItems(p)).toEqual([{ key: "objectives", required: true }, { key: "scope", required: true }, { key: "start_date", required: true }]);
    expect(await status(p)).toBe("to_complete");
    await expect(db.rpc("onboarding_deck_request", { p_project: p })).rejects.toThrow(/pas prêt/);

    // analyse des sources par Claude (contrat lu, appel, diagnostic)
    await db.as("claude");
    const ref = { kind: "file", id: contrat, label: "Contrat signé.pdf" };
    const saved = await db.rpc<{ status: string; sections_conservees_car_corrigees: string[] }>("onboarding_save_analysis", {
      p_project: p,
      p_sections: JSON.stringify({
        objectives: [{ text: "Retrouver le trafic organique d'avant la refonte", refs: [ref] }],
        scope: [{ text: "Audit technique et refonte des fiches produit", refs: [ref] }],
        deliverables: [{ text: "Audit SEO", refs: [ref] }, { text: "50 fiches produit réécrites", refs: [ref] }],
        phases: [{ text: "Audit", date: "2026-12-01", date_status: "confirmed", refs: [ref] }, { text: "Production", date: "2027-01-15", date_status: "provisional", refs: [ref] }],
      }),
      p_items: "[]",
      p_start_date: "2026-12-01",
    });
    expect(saved).toMatchObject({ status: "ready", sections_conservees_car_corrigees: [] });
    expect(await openItems(p)).toEqual([]);

    // slides : demandées depuis l'application, déposées par Claude dans un dossier interne
    await db.as("owner");
    const deck = await db.rpc<{ version: number; existing: boolean }>("onboarding_deck_request", { p_project: p });
    expect(deck).toMatchObject({ version: 1, existing: false });
    expect(await db.rpc("onboarding_deck_request", { p_project: p })).toMatchObject({ version: 1, existing: true });
    await db.as("claude");
    const open = await db.rpc<{ id: string; version: number }>("onboarding_deck_open", { p_project: p });
    const slides = await file(c, "Onboarding V1.pptx", "Présentation");
    await db.as("claude");
    await db.rpc("onboarding_deck_attach", { p_deck: open.id, p_file: slides });
    const ready = await db.rpc<{ folder_id: string }>("onboarding_deck_ready", { p_project: p, p_version: 1 });
    const placed = await db.one(`select pf.folder_id, f.visible_to_client from project_files pf join project_folders f on f.id = pf.folder_id where pf.file_id = $1`, [slides]);
    expect(placed).toEqual({ folder_id: ready.folder_id, visible_to_client: false });
    expect(await db.one(`select status from project_onboarding_decks where id = $1`, [open.id])).toEqual({ status: "ready" });
  });
});

describe("parcours 2 : pièces et décisions manquantes", () => {
  test("le CRM ne demande que le nécessaire, accepte réponses et fichiers, et le client répond via le portail", async () => {
    const c = await fiche("[TEST] Client Epsilon", [{ first_name: "Bruno", email: "bruno@test.fr" }]);
    const v1 = await file(c, "Proposition V1.pdf", "Proposition");
    const v2 = await file(c, "Proposition V2.pdf", "Proposition");
    const { project_id: p } = await win(c);
    await db.rpc("onboarding_prepare", { p_project: p });

    expect(await openItems(p)).toEqual([
      { key: "proposal", required: true }, { key: "objectives", required: true }, { key: "scope", required: true },
      { key: "start_date", required: true }, { key: "calls", required: false }, { key: "diagnostic", required: false },
    ]);
    const prop = await db.one<{ options: { label: string; file_id: string }[] }>(`select options from project_onboarding_items where project_id = $1 and key = 'proposal'`, [p]);
    expect(prop.options.map((o) => o.file_id).sort()).toEqual([v1, v2].sort());

    // je choisis la proposition, la date, j'écris l'objectif, et le reste ne s'applique pas
    await db.rpc("onboarding_answer", { p_item: (await item(p, "proposal")).id, p_action: "file", p_value: null, p_file: v2 });
    await db.rpc("onboarding_answer", { p_item: (await item(p, "start_date")).id, p_action: "date", p_value: "2026-12-15", p_file: null });
    await db.rpc("onboarding_answer", { p_item: (await item(p, "objectives")).id, p_action: "text", p_value: "Doubler les demandes de devis", p_file: null });
    await db.rpc("onboarding_answer", { p_item: (await item(p, "calls")).id, p_action: "not_applicable", p_value: null, p_file: null });
    expect(await db.one(`select proposal_file_id, proposal_choice from project_onboarding where project_id = $1`, [p])).toEqual({ proposal_file_id: v2, proposal_choice: "owner" });
    expect(await db.one(`select start_date::text from projects where id = $1`, [p])).toEqual({ start_date: "2026-12-15" });
    expect((await openItems(p)).map((i) => i.key)).toEqual(["scope", "diagnostic"]);
    expect(await status(p)).toBe("to_complete");

    // le périmètre doit venir du client : refusé tant que le projet n'est pas publié
    const scope = await item(p, "scope");
    await expect(db.rpc("onboarding_share_request", { p_item: scope.id, p_text: "Pouvez-vous confirmer les pages concernées ?", p_person: null })).rejects.toThrow(/publié/);
    await db.query(`update projects set portal_published = true where id = $1`, [p]);
    const bruno = (await db.one<{ id: string }>(`select id from people where company_id = $1`, [c])).id;
    const shared = await db.rpc<{ task_id: string }>("onboarding_share_request", { p_item: scope.id, p_text: "Pouvez-vous confirmer les pages concernées ?", p_person: bruno });

    // le client voit la demande, rien d'autre de la préparation
    const s = await login(db, bruno);
    const tasks = await portal<{ id: string; title: string }[]>(db, "portal_tasks", s.session);
    expect(tasks.map((t) => t.id)).toEqual([shared.task_id]);
    expect(JSON.stringify(tasks)).not.toContain("Doubler les demandes");
    await portal(db, "portal_task_comment", s.session, { p_task: shared.task_id, p_body: "Les pages services et la page d'accueil." });
    await db.as("owner");
    expect(await item(p, "scope")).toMatchObject({ status: "answered", answered_by: "client", answer: "Les pages services et la page d'accueil." });
    expect(await status(p)).toBe("ready");
  });

  test("un fichier déposé par le client sur la demande met à jour le point", async () => {
    const c = await fiche("[TEST] Client Zeta", [{ first_name: "Chloé", email: "chloe@test.fr" }]);
    const { project_id: p } = await win(c);
    await db.rpc("onboarding_prepare", { p_project: p });
    await db.query(`update projects set portal_published = true where id = $1`, [p]);
    const chloe = (await db.one<{ id: string }>(`select id from people where company_id = $1`, [c])).id;
    const prop = await item(p, "proposal");
    const shared = await db.rpc<{ task_id: string }>("onboarding_share_request", { p_item: prop.id, p_text: "Pouvez-vous déposer le devis signé ?", p_person: chloe });
    const s = await login(db, chloe);
    const start = await portal<{ file_id: string }>(db, "portal_file_start", s.session, {
      p_project: p, p_folder: null, p_task: shared.task_id, p_name: "Devis signé.pdf", p_type: "application/pdf", p_size: 1000, p_ext: "pdf",
    });
    await db.exec(`reset role;`);
    await db.query(`update company_files set status = 'ready' where id = $1`, [start.file_id]);
    await db.as("owner");
    expect(await db.one(`select status, answered_by, answer_file_id from project_onboarding_items where id = $1`, [prop.id])).toEqual({ status: "answered", answered_by: "client", answer_file_id: start.file_id });
  });
});

describe("relancer la préparation", () => {
  test("conserve mes corrections et mes réponses, même face à une nouvelle analyse", async () => {
    const c = await fiche("[TEST] Client Eta");
    const { project_id: p } = await win(c);
    await db.rpc("onboarding_prepare", { p_project: p });
    await db.rpc("onboarding_save_section", { p_project: p, p_key: "objectives", p_items: JSON.stringify([{ text: "Mon objectif corrigé", refs: [] }]) });
    await db.rpc("onboarding_answer", { p_item: (await item(p, "start_date")).id, p_action: "date", p_value: "2027-01-05", p_file: null });

    await db.rpc("onboarding_prepare", { p_project: p });
    await db.as("claude");
    const r = await db.rpc<{ sections_conservees_car_corrigees: string[] }>("onboarding_save_analysis", {
      p_project: p, p_sections: JSON.stringify({ objectives: [{ text: "Objectif de Claude" }], scope: [{ text: "Périmètre de Claude" }] }), p_items: "[]", p_start_date: "2026-11-20",
    });
    expect(r.sections_conservees_car_corrigees).toEqual(["objectives"]);
    await db.as("owner");
    await db.rpc("onboarding_prepare", { p_project: p });
    const o = await db.one<{ sections: Record<string, { items: { text: string }[]; origin: string }> }>(`select sections from project_onboarding where project_id = $1`, [p]);
    expect(o.sections.objectives).toMatchObject({ origin: "owner", items: [{ text: "Mon objectif corrigé" }] });
    expect(o.sections.scope).toMatchObject({ origin: "claude", items: [{ text: "Périmètre de Claude" }] });
    expect(await item(p, "start_date")).toMatchObject({ status: "answered", answer: "05/01/2027" });
    expect(await db.one(`select start_date::text from projects where id = $1`, [p])).toEqual({ start_date: "2027-01-05" });
  });

  test("une contradiction signalée par Claude reste à arbitrer, avec ses deux références", async () => {
    const c = await fiche("[TEST] Client Theta");
    const { project_id: p } = await win(c);
    await db.as("claude");
    await db.rpc("onboarding_save_analysis", {
      p_project: p, p_sections: "{}", p_start_date: null,
      p_items: JSON.stringify([{
        key: "duree", kind: "conflict", required: true, target_section: "phases", label: "Durée de la mission : 3 ou 6 mois ?",
        options: [{ label: "3 mois (proposition)", text: "Mission de 3 mois", refs: [{ kind: "file", label: "Proposition" }] },
                  { label: "6 mois (appel du 12/10)", text: "Mission de 6 mois", refs: [{ kind: "call", label: "Appel" }] }],
      }]),
    });
    await db.as("owner");
    const conflict = await item(p, "claude:duree");
    expect(conflict.status).toBe("open");
    await db.rpc("onboarding_answer", { p_item: conflict.id, p_action: "choice", p_value: "6 mois (appel du 12/10)", p_file: null });
    const o = await db.one<{ sections: Record<string, { items: { text: string }[] }> }>(`select sections from project_onboarding where project_id = $1`, [p]);
    expect(o.sections.phases.items.map((x) => x.text)).toContain("Mission de 6 mois");
  });
});

describe("sources lues par Claude", () => {
  test("limitées à la fiche du projet", async () => {
    const a = await fiche("[TEST] Client Iota");
    const b = await fiche("[TEST] Client Kappa");
    await call(a, { short_summary: "Résumé A" });
    const autre = await call(b, { short_summary: "Résumé B" });
    const { project_id: p } = await win(a);
    await db.as("claude");
    const s = await db.rpc<{ appels: { resume: { short_summary: string } }[] }>("onboarding_sources", { p_project: p });
    expect(s.appels.map((x) => x.resume.short_summary)).toEqual(["Résumé A"]);
    await expect(db.rpc("onboarding_call_transcript", { p_project: p, p_call: autre, p_offset: 0, p_limit: 10 })).rejects.toThrow(/introuvable/);
  });
});
