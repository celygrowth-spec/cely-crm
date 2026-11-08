// Dossier de diagnostic : Claude ne lit emails et appels que pour la fiche d'un dossier, ne crée pas de dossier,
// et la génération attend l'envoi des réponses.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let acme: string;
let other: string;
let dossier: string;

const questions = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ question: `Question ${i + 1}`, why: "Parce que" })));

beforeEach(async () => {
  db = await createDb();
  await db.as("owner");
  acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [] })).id;
  other = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Autre" }, p_people: [] })).id;
  dossier = await db.rpc<string>("diagnostic_start", { p_company: acme, p_key: "cle-acme-1" });
});

async function seedMail(company: string, subject: string) {
  const id = crypto.randomUUID();
  await db.exec(`reset role;
    insert into mail_messages (id, company_id, status, subject, body_text, to_addrs, bcc_addrs, provider_thread_id)
    values ('${id}', '${company}', 'draft', '${subject}', 'corps ${subject}', '{a@b.fr}', '{cache@b.fr}', 'fil-${subject}');
    update mail_messages set status = 'sending' where id = '${id}';
    update mail_messages set status = 'accepted', sent_at = now() where id = '${id}';`);
  await db.as("claude");
  return id;
}

async function seedCall(company: string) {
  await db.exec(`reset role;`);
  const c = await db.one<{ id: string }>(`insert into fireflies_calls (account_id, fireflies_id, title) values ('c', $1, 'Appel') returning id`, [crypto.randomUUID()]);
  // à l'import, le rattachement automatique décide : ici, on impose la fiche
  await db.query(`update fireflies_calls set link_state = 'linked', company_id = $1 where id = $2`, [company, c.id]);
  await db.query(`insert into fireflies_call_transcripts (call_id, lines) values ($1, '[{"text":"un"},{"text":"deux"},{"text":"trois"}]')`, [c.id]);
  await db.as("claude");
  return c.id;
}

describe("dossier", () => {
  test("un double clic renvoie le même dossier", async () => {
    expect(await db.rpc("diagnostic_start", { p_company: acme, p_key: "cle-acme-1" })).toBe(dossier);
    expect(await db.one(`select count(*)::int n from diagnostics`)).toEqual({ n: 1 });
  });

  test("une clé déjà utilisée sur une autre fiche est refusée", async () => {
    await expect(db.rpc("diagnostic_start", { p_company: other, p_key: "cle-acme-1" })).rejects.toThrow(/invalide/);
  });

  test("Claude ne crée pas de dossier et ne modifie ni le prompt ni les réponses", async () => {
    await db.as("claude");
    await expect(db.rpc("diagnostic_start", { p_company: acme, p_key: "cle-claude-1" })).rejects.toThrow(/Claude/);
    await expect(db.rpc("diagnostic_set_instructions", { p_text: "x" })).rejects.toThrow(/Claude/);
    await expect(db.rpc("diagnostic_submit_answers", { p_id: dossier })).rejects.toThrow(/Claude/);
  });

  test("un inconnu n'a accès à rien", async () => {
    await db.as("stranger");
    await expect(db.rpc("diagnostic_company", { p_id: dossier })).rejects.toThrow(/refusé/);
    await expect(db.rpc("diagnostic_mail_list", { p_id: dossier, p_before: null, p_limit: 10 })).rejects.toThrow(/refusé/);
    expect((await db.query(`select id from diagnostics`)).rows).toEqual([]);
  });

  test("une fusion de fiches conserve le dossier", async () => {
    await db.query(`update companies set merged_into_id = $1 where id = $2`, [other, acme]);
    expect(await db.one(`select company_id from diagnostics where id = $1`, [dossier])).toEqual({ company_id: other });
  });
});

describe("lectures sensibles", () => {
  test("Claude reste privé d'accès direct aux emails et aux appels", async () => {
    await seedMail(acme, "direct");
    await seedCall(acme);
    expect((await db.query(`select id from mail_messages`)).rows).toEqual([]);
    expect((await db.query(`select call_id from fireflies_call_transcripts`)).rows).toEqual([]);
  });

  test("le dossier donne accès aux emails de sa fiche seulement, sans copie cachée", async () => {
    const mine = await seedMail(acme, "acme");
    const theirs = await seedMail(other, "autre");
    const list = await db.rpc<{ objet: string; bcc?: unknown; cache?: unknown }[]>("diagnostic_mail_list", { p_id: dossier, p_before: null, p_limit: 10 });
    expect(list.map((m) => m.objet)).toEqual(["acme"]);
    expect(JSON.stringify(list)).not.toContain("cache@b.fr");
    expect((await db.rpc<{ corps: string }[]>("diagnostic_mail_thread", { p_id: dossier, p_mail: mine, p_offset: 0, p_limit: 5 }))[0].corps).toBe("corps acme");
    await expect(db.rpc("diagnostic_mail_thread", { p_id: dossier, p_mail: theirs, p_offset: 0, p_limit: 5 })).rejects.toThrow(/introuvable/);
  });

  test("les brouillons ne sortent pas", async () => {
    await db.rpc("mail_save_draft", { p_id: "44444444-4444-4444-8444-444444444444", p: { company_id: acme, to: ["a@b.fr"], subject: "brouillon", body: "y" } });
    await db.as("claude");
    expect(await db.rpc("diagnostic_mail_list", { p_id: dossier, p_before: null, p_limit: 10 })).toEqual([]);
  });

  test("les transcriptions se lisent par page, pour la fiche du dossier seulement", async () => {
    const mine = await seedCall(acme);
    const theirs = await seedCall(other);
    expect(await db.rpc("fireflies_diagnostic_transcript", { p_id: dossier, p_call: mine, p_offset: 1, p_limit: 1 })).toEqual({ total: 3, lignes: [{ text: "deux" }] });
    await expect(db.rpc("fireflies_diagnostic_transcript", { p_id: dossier, p_call: theirs, p_offset: 0, p_limit: 10 })).rejects.toThrow(/introuvable/);
    expect(await db.rpc<unknown[]>("fireflies_diagnostic_calls", { p_id: dossier, p_before: null, p_limit: 10 })).toHaveLength(1);
  });
});

describe("parcours", () => {
  async function toAnswersSent() {
    await db.as("claude");
    await db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(10) });
    await db.as("owner");
    const rows = await db.query<{ id: string }>(`select id from diagnostic_questions where diagnostic_id = $1`, [dossier]);
    for (const r of rows.rows) await db.rpc("diagnostic_save_answer", { p_question: r.id, p_answer: "", p_dont_know: true });
    await db.rpc("diagnostic_submit_answers", { p_id: dossier });
    await db.as("claude");
  }

  test("ouvrir le dossier le passe en recherche, une seule fois", async () => {
    await db.as("claude");
    await db.rpc("diagnostic_open", { p_id: dossier });
    expect(await db.one(`select status from diagnostics`)).toEqual({ status: "researching" });
  });

  test("il faut entre 10 et 20 questions", async () => {
    await db.as("claude");
    await expect(db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(9) })).rejects.toThrow(/entre 10 et 20/);
    await expect(db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(21) })).rejects.toThrow(/entre 10 et 20/);
    expect(await db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(12) })).toBe(12);
    expect(await db.one(`select status from diagnostics`)).toEqual({ status: "questions_ready" });
  });

  test("une réponse saisie protège les questions, et une question sans réponse bloque l'envoi", async () => {
    await db.as("claude");
    await db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(10) });
    await db.as("owner");
    const q = await db.one<{ id: string }>(`select id from diagnostic_questions where position = 1`);
    await db.rpc("diagnostic_save_answer", { p_question: q.id, p_answer: "Oui", p_dont_know: false });
    await expect(db.rpc("diagnostic_submit_answers", { p_id: dossier })).rejects.toThrow(/9 question/);
    await db.as("claude");
    await expect(db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(10) })).rejects.toThrow(/déjà saisies/);
  });

  test("aucune version avant l'envoi des réponses", async () => {
    await db.as("claude");
    await expect(db.rpc("diagnostic_version_open", { p_id: dossier })).rejects.toThrow(/pas été envoyées/);
  });

  test("répéter l'envoi ne change rien et fige les réponses", async () => {
    await toAnswersSent();
    await db.as("owner");
    expect(await db.rpc("diagnostic_submit_answers", { p_id: dossier })).toBe("answers_sent");
    const q = await db.one<{ id: string }>(`select id from diagnostic_questions where position = 1`);
    await expect(db.rpc("diagnostic_save_answer", { p_question: q.id, p_answer: "tard", p_dont_know: false })).rejects.toThrow(/déjà été envoyées/);
  });

  test("une nouvelle tentative reprend la même version, puis la suivante après réception", async () => {
    await toAnswersSent();
    const a = await db.rpc<{ id: string; version: number }>("diagnostic_version_open", { p_id: dossier });
    const b = await db.rpc<{ id: string; version: number }>("diagnostic_version_open", { p_id: dossier });
    expect(b).toEqual(a);
    expect(a.version).toBe(1);
    await expect(db.rpc("diagnostic_version_ready", { p_id: dossier, p_version: 1 })).rejects.toThrow(/Aucun dépôt/);
    const f = await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes) values ($1, 'a/v1.pptx', 'v1', 'text/plain', 1) returning id`, [acme]);
    await db.rpc("diagnostic_version_attach", { p_version: a.id, p_file: f.id });
    await db.rpc("diagnostic_version_ready", { p_id: dossier, p_version: 1 });
    expect(await db.one(`select status from diagnostics`)).toEqual({ status: "version_ready" });
    expect((await db.rpc<{ version: number }>("diagnostic_version_open", { p_id: dossier })).version).toBe(2);
  });

  test("un fichier d'une autre fiche ne peut pas devenir une version", async () => {
    await toAnswersSent();
    const v = await db.rpc<{ id: string }>("diagnostic_version_open", { p_id: dossier });
    const f = await db.one<{ id: string }>(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes) values ($1, 'b/x.pptx', 'x', 'text/plain', 1) returning id`, [other]);
    await expect(db.rpc("diagnostic_version_attach", { p_version: v.id, p_file: f.id })).rejects.toThrow(/invalide/);
  });

  test("les écritures de Claude sont journalisées", async () => {
    await db.as("claude");
    await db.rpc("diagnostic_save_research", { p_id: dossier, p_summary: "Synthèse", p_sources: "[]" });
    expect(await db.one(`select count(*)::int n from activity_log where table_name = 'diagnostics' and actor = 'claude'`)).toEqual({ n: 1 });
  });
});

describe("bibliothèque", () => {
  test("le prompt par défaut existe, Claude le lit sans pouvoir toucher aux fichiers", async () => {
    await db.query(`insert into diagnostic_library_files (display_name, mime_type, size_bytes, storage_path, status) values ('Exemple.pdf', 'application/pdf', 1, 'e.pdf', 'ready')`);
    await db.as("claude");
    expect((await db.one<{ instructions: string }>(`select instructions from diagnostic_settings`)).instructions).toContain("10 à 20 questions");
    expect(await db.one(`select count(*)::int n from diagnostic_library_files`)).toEqual({ n: 1 });
    await expect(db.query(`insert into diagnostic_library_files (display_name, mime_type, size_bytes, storage_path) values ('x', 'application/pdf', 1, 'x.pdf')`)).rejects.toThrow();
    expect((await db.query(`update diagnostic_library_files set display_name = 'y' returning id`)).rows).toEqual([]);
  });
});

describe("déclenchement", () => {
  test("une étape ne se réserve qu'une fois, un échec la rend relançable", async () => {
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "start" })).toBe(true);
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "start" })).toBe(false);
    await db.rpc("diagnostic_trigger_result", { p_id: dossier, p_session_url: null, p_error: "refusé" });
    expect(await db.one(`select trigger_stage, trigger_error from diagnostics`)).toEqual({ trigger_stage: null, trigger_error: "refusé" });
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "start" })).toBe(true);
    await db.rpc("diagnostic_trigger_result", { p_id: dossier, p_session_url: "https://claude.ai/code/session_1", p_error: null });
    expect(await db.one(`select chat_url from diagnostics`)).toEqual({ chat_url: "https://claude.ai/code/session_1" });
  });

  test("pas de lancement des slides avant l'envoi des réponses, ni par Claude", async () => {
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "answers" })).toBe(false);
    await db.as("claude");
    await expect(db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "start" })).rejects.toThrow(/Claude/);
  });

  test("un échec après l'envoi des réponses se relance à l'étape des slides", async () => {
    await db.as("claude");
    await db.rpc("diagnostic_save_questions", { p_id: dossier, p_questions: questions(10) });
    await db.as("owner");
    for (const r of (await db.query<{ id: string }>(`select id from diagnostic_questions`)).rows) await db.rpc("diagnostic_save_answer", { p_question: r.id, p_answer: "", p_dont_know: true });
    await db.rpc("diagnostic_submit_answers", { p_id: dossier });
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "answers" })).toBe(true);
    await db.as("claude");
    await db.rpc("diagnostic_report_failure", { p_id: dossier, p_message: "dépôt refusé" });
    await db.as("owner");
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "start" })).toBe(false);
    expect(await db.rpc("diagnostic_claim_trigger", { p_id: dossier, p_stage: "answers" })).toBe(true);
  });
});
