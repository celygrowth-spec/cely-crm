// Audit, lot 4 : Q01 (tâches de projet dans la file du jour), Q04 (une suite après « RDV obtenu » / « Intéressé »),
// K06 (réponse et résultat enregistrés une fois).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const n = async (sql: string, p?: unknown[]) => (await db.one<{ n: number }>(sql, p)).n;
const STEPS = [
  { name: "Invitation", step_type: "linkedin_invite", delay_days: 0, message: "" },
  { name: "Email", step_type: "email", delay_days: 3, subject: "Bonjour", message: "Bonjour" },
];

async function participant() {
  const co = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [{ first_name: "Paul" }], p_force: true })).id;
  const campaign = await db.rpc<string>("create_campaign_draft", { p_name: "Fondateurs" });
  await db.rpc("save_campaign_sequence", { p_campaign: campaign, p_steps: STEPS });
  await db.rpc("enroll_in_campaign", { p_campaign: campaign, p_company_ids: [co] });
  const p = (await db.one<{ id: string }>(`select id from campaign_participants`)).id;
  await db.rpc("activate_participants", { p_campaign: campaign, p_ids: [p] });
  return { co, p };
}

beforeEach(async () => {
  db = await createDb();
});

describe("Q01 — une tâche de projet attribuée à moi est dans la file du jour", () => {
  test("file, compteur et prochaine action de la fiche ; validée dans le projet, elle disparaît partout", async () => {
    const co = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Studio" }, p_people: [], p_force: true })).id;
    const pr = (await db.one<{ id: string }>(`insert into projects (company_id, name, status) values ($1, 'Refonte', 'en_cours') returning id`, [co])).id;
    const mine = (await db.one<{ id: string }>(`insert into project_tasks (project_id, title, due_date) values ($1, 'Maquettes', $2) returning id`, [pr, today()])).id;
    // attribuée au client : pas dans ma file ; sans échéance : seulement dans « Tout » (hors compteur)
    await db.query(`insert into project_tasks (project_id, title, assignee_kind, visible_to_client) values ($1, 'Envoyer le logo', 'client', true)`, [pr]);
    await db.query(`insert into project_tasks (project_id, title) values ($1, 'Idée sans date')`, [pr]);
    const rows = (await db.query<{ item_type: string; title: string; project_name: string }>(`select item_type, title, project_name from todo_items order by title`)).rows;
    expect(rows).toEqual([
      { item_type: "project_task", title: "Idée sans date", project_name: "Refonte" },
      { item_type: "project_task", title: "Maquettes", project_name: "Refonte" },
    ]);
    expect(await db.rpc("nav_counters", { p_today: today() })).toMatchObject({ todo: 1 });
    expect(await db.one(`select next_action_title, next_action_type from company_overview where id = $1`, [co])).toEqual({ next_action_title: "Maquettes", next_action_type: "project_task" });
    await db.query(`update project_tasks set status = 'termine' where id = $1`, [mine]);
    expect(await n(`select count(*)::int n from todo_items where id = $1`, [mine])).toBe(0);
    expect(await db.rpc("nav_counters", { p_today: today() })).toMatchObject({ todo: 0 });
    // projet terminé : ses tâches sortent de la file
    await db.query(`update projects set status = 'termine' where id = $1`, [pr]);
    expect(await n(`select count(*)::int n from todo_items`)).toBe(0);
  });
});

describe("Q04 — « RDV obtenu » et « Intéressé » laissent toujours une suite", () => {
  test("sans étape, rendez-vous ni tâche : refus explicite ; avec une tâche de suivi : la fiche reste dans la file", async () => {
    const { co, p } = await participant();
    await db.rpc("record_reply", { p_participant: p, p_content: "Oui, parlons-en" });
    await expect(db.rpc("set_participant_outcome", { p_participant: p, p_outcome: "meeting" })).rejects.toThrow(/Choisissez la suite/);
    expect(await db.one(`select outcome from campaign_participants where id = $1`, [p])).toEqual({ outcome: "replied" }); // inchangé : rien n'est enregistré sans suite
    await db.rpc("set_participant_outcome", { p_participant: p, p_outcome: "meeting", p_next: { task: { title: "Préparer le rendez-vous", due_date: today() } } });
    expect(await db.query(`select item_type, title from todo_items where company_id = $1`, [co]).then((r) => r.rows)).toEqual([{ item_type: "task", title: "Préparer le rendez-vous" }]);
  });

  test("intéressé avec une étape : placé dans le pipeline, aucune tâche imposée", async () => {
    const { co, p } = await participant();
    const pl = (await db.one<{ id: string }>(`insert into pipelines (name) values ('Vente') returning id`)).id;
    const st = (await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, 'Qualifié', 0) returning id`, [pl])).id;
    await db.rpc("set_participant_outcome", { p_participant: p, p_outcome: "interested", p_next: { stage_id: st } });
    expect(await db.one(`select stage_id from companies where id = $1`, [co])).toEqual({ stage_id: st });
    expect(await n(`select count(*)::int n from tasks`)).toBe(0);
  });
});

describe("K06 — réponse et résultat en une opération, sans doublon", () => {
  test("double clic ou reprise réseau : une seule réponse dans l'historique, une seule tâche", async () => {
    const { co, p } = await participant();
    const args = { p_participant: p, p_content: "Intéressé, rappelez-moi", p_outcome: "interested",
      p_next: { task: { title: "Rappeler Paul", due_date: today() } }, p_idempotency_key: "reponse-abcdef12" };
    const a = await db.rpc("record_reply", args);
    const b = await db.rpc("record_reply", args);
    expect(b).toEqual(a);
    expect(await n(`select count(*)::int n from interactions where company_id = $1 and kind = 'message_in'`, [co])).toBe(1);
    expect(await n(`select count(*)::int n from tasks where company_id = $1`, [co])).toBe(1);
    expect(await db.one(`select status, outcome from campaign_participants where id = $1`, [p])).toEqual({ status: "a_repondu", outcome: "interested" });
    // même clé, autre contenu : erreur explicite (jamais un résultat d'une autre saisie)
    await expect(db.rpc("record_reply", { ...args, p_content: "Autre" })).rejects.toThrow(/d'autres informations/);
    // le résultat échoue (pas de suite) : la réponse n'est pas enregistrée non plus (tout ou rien)
    const before = await n(`select count(*)::int n from interactions where kind = 'message_in'`);
    await expect(db.rpc("record_reply", { p_participant: p, p_content: "RDV ok", p_outcome: "meeting", p_next: {} })).resolves.toBeTruthy(); // tâche ouverte existante = suite
    await db.exec(`update tasks set done_at = now()`);
    await expect(db.rpc("record_reply", { p_participant: p, p_content: "RDV ok bis", p_outcome: "meeting" })).rejects.toThrow(/Choisissez la suite/);
    expect(await n(`select count(*)::int n from interactions where kind = 'message_in'`)).toBe(before + 1);
  });

  test("création de tâche avec clé : une seule tâche malgré deux envois", async () => {
    const co = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Beta" }, p_people: [], p_force: true })).id;
    const args = { p_company: co, p_title: "Relancer", p_due: today(), p_idempotency_key: "tache-abcdef12" };
    await db.rpc("create_task", args);
    await db.rpc("create_task", args);
    expect(await n(`select count(*)::int n from tasks where company_id = $1`, [co])).toBe(1);
  });
});
