// Règles de la prospection v2 : versions de séquence, préparation, activation, exécution,
// annulation, résultats, pause et statistiques.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});

const LI_EMAIL_CALL = [
  { name: "Invitation", step_type: "linkedin_invite", delay_days: 0, message: "" },
  { name: "Message LinkedIn", step_type: "linkedin_message", delay_days: 2, message: "Bonjour {{prenom}}, j'ai vu {{entreprise}}." },
  { name: "Email", step_type: "email", delay_days: 3, subject: "{{entreprise}} x Cely", message: "Bonjour {{prenom}}" },
  { name: "Appel", step_type: "call", delay_days: 4, instructions: "Appeler le matin" },
];

async function company(name: string, people: Record<string, unknown>[] = [{ first_name: "Paul" }]) {
  const r = await db.rpc<{ id: string }>("create_company", { p_company: { name }, p_people: people, p_force: true });
  return r.id;
}
const one = <T = Record<string, unknown>>(sql: string, p?: unknown[]) => db.one<T>(sql, p);
const n = async (sql: string, p?: unknown[]) => (await db.one<{ n: number }>(sql, p)).n;

async function campaignWith(steps = LI_EMAIL_CALL) {
  const id = await db.rpc<string>("create_campaign_draft", { p_name: "Fondateurs" });
  await db.rpc("save_campaign_sequence", { p_campaign: id, p_steps: steps });
  return id;
}

describe("construction et versions", () => {
  test("une campagne naît en brouillon ; la séquence LinkedIn → email → appel est enregistrée avec ses types", async () => {
    const id = await campaignWith();
    const c = await one<{ status: string }>(`select status from campaigns where id = $1`, [id]);
    expect(c.status).toBe("draft");
    const steps = await db.query<{ step_type: string; channel: string }>(`select step_type, channel from campaign_steps where campaign_id = $1 order by position`, [id]);
    expect(steps.rows.map((s) => s.channel)).toEqual(["linkedin", "linkedin", "email", "phone"]);
  });

  test("changer la structure après démarrage crée une nouvelle version sans déplacer les participants démarrés", async () => {
    const id = await campaignWith();
    const a = await company("Acme");
    const b = await company("Beta");
    await db.rpc("enroll_in_campaign", { p_campaign: id, p_company_ids: [a, b] });
    const pa = await one<{ id: string }>(`select id from campaign_participants where company_id = $1`, [a]);
    await db.rpc("activate_participants", { p_campaign: id, p_ids: [pa.id] });
    await db.rpc("complete_step", { p_participant: pa.id, p_content: "" });

    const res = await db.rpc<{ new_version: boolean; version: number }>("save_campaign_sequence", {
      p_campaign: id,
      p_steps: [LI_EMAIL_CALL[0], LI_EMAIL_CALL[2]],
    });
    expect(res).toMatchObject({ new_version: true, version: 2 });
    const started = await one<{ sequence_version: number; current_step: number }>(`select sequence_version, current_step from campaign_participants where id = $1`, [pa.id]);
    expect(started).toEqual({ sequence_version: 1, current_step: 2 });
    const waiting = await one<{ sequence_version: number }>(`select sequence_version from campaign_participants where company_id = $1`, [b]);
    expect(waiting.sequence_version).toBe(2);
    // un simple changement de texte ne crée pas de version
    const text = await db.rpc<{ new_version: boolean }>("save_campaign_sequence", {
      p_campaign: id,
      p_steps: [LI_EMAIL_CALL[0], { ...LI_EMAIL_CALL[2], message: "Nouveau texte" }],
    });
    expect(text.new_version).toBe(false);
  });

  test("dupliquer reprend la séquence sans participants ni historique", async () => {
    const id = await campaignWith();
    const a = await company("Acme");
    await db.rpc("enroll_in_campaign", { p_campaign: id, p_company_ids: [a] });
    const copy = await db.rpc<string>("duplicate_campaign", { p_campaign: id });
    expect(await n(`select count(*)::int n from campaign_steps where campaign_id = $1`, [copy])).toBe(4);
    expect(await n(`select count(*)::int n from campaign_participants where campaign_id = $1`, [copy])).toBe(0);
  });
});

describe("inscription, préparation, activation", () => {
  test("listes qui se recoupent : une entreprise inscrite une seule fois ; « Ne plus contacter » bloqué", async () => {
    const id = await campaignWith();
    const a = await company("Acme");
    const b = await company("Beta");
    await db.rpc("set_do_not_contact", { p_company: b, p_value: true, p_reason: "Demande explicite" });
    const l1 = await one<{ id: string }>(`insert into lists (name) values ('L1') returning id`);
    const l2 = await one<{ id: string }>(`insert into lists (name) values ('L2') returning id`);
    await db.query(`insert into list_members (list_id, company_id) values ($1,$3),($2,$3),($2,$4)`, [l1.id, l2.id, a, b]);
    const res = await db.rpc<{ added: number; blocked: number }>("enroll_in_campaign", { p_campaign: id, p_list_ids: [l1.id, l2.id] });
    expect(res).toMatchObject({ added: 1, blocked: 1 });
    const again = await db.rpc<{ added: number; already_present: number }>("enroll_in_campaign", { p_campaign: id, p_company_ids: [a] });
    expect(again).toMatchObject({ added: 0, already_present: 1 });
    expect(await n(`select count(*)::int n from campaign_participants where status = 'a_preparer'`)).toBe(1);
  });

  test("activer calcule l'échéance, n'envoie rien, et passe la campagne en active", async () => {
    const id = await campaignWith();
    const a = await company("Acme");
    await db.rpc("enroll_in_campaign", { p_campaign: id, p_company_ids: [a] });
    const p = await one<{ id: string }>(`select id from campaign_participants`);
    const r = await db.rpc<{ activated: number }>("activate_participants", { p_campaign: id, p_ids: [p.id] });
    expect(r.activated).toBe(1);
    const row = await one<{ status: string; due: string; today: string }>(`select status, next_due_date::text due, public.today_paris()::text today from campaign_participants`);
    expect(row.status).toBe("a_contacter");
    expect(row.due).toBe(row.today);
    expect(await n(`select count(*)::int n from interactions where kind = 'message_out'`)).toBe(0);
    expect((await one<{ status: string }>(`select status from campaigns where id = $1`, [id])).status).toBe("active");
  });

  test("sollicitation simultanée : avertissement, puis confirmation explicite", async () => {
    const first = await campaignWith();
    const second = await campaignWith();
    const a = await company("Acme");
    await db.rpc("enroll_in_campaign", { p_campaign: first, p_company_ids: [a] });
    const p1 = await one<{ id: string }>(`select id from campaign_participants where campaign_id = $1`, [first]);
    await db.rpc("activate_participants", { p_campaign: first, p_ids: [p1.id] });
    await db.rpc("enroll_in_campaign", { p_campaign: second, p_company_ids: [a] });
    const p2 = await one<{ id: string }>(`select id from campaign_participants where campaign_id = $1`, [second]);
    const r = await db.rpc<{ status: string; conflicts: { other_campaign_name: string }[] }>("activate_participants", { p_campaign: second, p_ids: [p2.id] });
    expect(r.status).toBe("conflicts");
    expect(r.conflicts[0].other_campaign_name).toBe("Fondateurs");
    expect((await one<{ status: string }>(`select status from campaign_participants where id = $1`, [p2.id])).status).toBe("a_preparer");
    const ok = await db.rpc<{ activated: number }>("activate_participants", { p_campaign: second, p_ids: [p2.id], p_confirm_conflicts: true });
    expect(ok.activated).toBe(1);
  });

  test("le brouillon personnalisé est conservé et distinct du modèle", async () => {
    const id = await campaignWith();
    const a = await company("Acme");
    await db.rpc("enroll_in_campaign", { p_campaign: id, p_company_ids: [a] });
    const p = await one<{ id: string }>(`select id from campaign_participants`);
    await db.rpc("save_participant_draft", { p_participant: p.id, p_position: 2, p_subject: null, p_body: "Bonjour Paul, version perso" });
    const d = await one<{ body: string }>(`select body from participant_drafts where participant_id = $1`, [p.id]);
    expect(d.body).toBe("Bonjour Paul, version perso");
    const tpl = await one<{ message: string }>(`select message from campaign_steps where campaign_id = $1 and position = 2`, [id]);
    expect(tpl.message).toContain("{{prenom}}");
  });
});

describe("exécution", () => {
  async function activeParticipant() {
    const id = await campaignWith();
    const a = await company("Acme", [{ first_name: "Paul", last_name: "Martin" }, { first_name: "Léa", last_name: "Durand" }]);
    await db.rpc("enroll_in_campaign", { p_campaign: id, p_company_ids: [a] });
    const p = await one<{ id: string }>(`select id from campaign_participants`);
    await db.rpc("activate_participants", { p_campaign: id, p_ids: [p.id] });
    return { campaign: id, company: a, participant: p.id };
  }

  test("une variable non remplacée bloque la validation", async () => {
    const { participant } = await activeParticipant();
    await expect(db.rpc("complete_step", { p_participant: participant, p_content: "Bonjour {{prenom}}" })).rejects.toThrow(/Variable non remplacée : \{\{prenom\}\}/);
    expect(await n(`select count(*)::int n from interactions where campaign_participant_id = $1`, [participant])).toBe(0);
  });

  test("valider : interaction, étape suivante et échéance depuis la date réelle, en une fois ; double clic sans doublon", async () => {
    const { participant } = await activeParticipant();
    const args = { p_participant: participant, p_content: "Invitation envoyée", p_done_at: "2026-10-20T09:00:00+02:00", p_idempotency_key: "focus-abcdef12" };
    const a = await db.rpc<{ next_due_date: string }>("complete_step", args);
    const b = await db.rpc<{ next_due_date: string }>("complete_step", args);
    expect(b).toEqual(a);
    expect(a.next_due_date).toBe("2026-10-22");
    expect(await n(`select count(*)::int n from interactions where campaign_participant_id = $1`, [participant])).toBe(1);
    const row = await one<{ current_step: number; status: string }>(`select current_step, status from campaign_participants`);
    expect(row).toEqual({ current_step: 2, status: "en_cours" });
  });

  test("aucune cascade : une étape en retard reste due tant qu'elle n'est pas validée", async () => {
    const { participant } = await activeParticipant();
    await db.query(`update campaign_participants set next_due_date = current_date - 20 where id = $1`, [participant]);
    expect(await n(`select count(*)::int n from todo_items where item_type = 'followup'`)).toBe(1);
    const row = await one<{ current_step: number }>(`select current_step from campaign_participants`);
    expect(row.current_step).toBe(1);
  });

  test("ignorer une étape ≠ arrêter le suivi ; annuler rétablit l'état", async () => {
    const { participant } = await activeParticipant();
    const s = await db.rpc<{ action_id: string }>("skip_step", { p_participant: participant });
    let row = await one<{ current_step: number; status: string }>(`select current_step, status from campaign_participants`);
    expect(row).toEqual({ current_step: 2, status: "a_contacter" });
    await db.rpc("undo_participant_action", { p_action: s.action_id });
    row = await one(`select current_step, status from campaign_participants`);
    expect(row).toEqual({ current_step: 1, status: "a_contacter" });

    const d = await db.rpc<{ action_id: string }>("complete_step", { p_participant: participant, p_content: "ok" });
    await db.rpc("undo_participant_action", { p_action: d.action_id });
    expect(await n(`select count(*)::int n from interactions where kind = 'message_out'`)).toBe(0);
    row = await one(`select current_step, status from campaign_participants`);
    expect(row).toEqual({ current_step: 1, status: "a_contacter" });
  });

  test("annulation refusée si une action ultérieure a modifié le suivi", async () => {
    const { participant } = await activeParticipant();
    const d = await db.rpc<{ action_id: string }>("complete_step", { p_participant: participant, p_content: "ok" });
    await db.rpc("update_participant", { p_participant: participant, p_action: "postpone", p_due: "2027-01-10" });
    await expect(db.rpc("undo_participant_action", { p_action: d.action_id })).rejects.toThrow(/modifié depuis/);
  });

  test("réponse d'un cofondateur : relances de l'entreprise suspendues dans toutes les campagnes", async () => {
    const { campaign, company: a, participant } = await activeParticipant();
    const other = await campaignWith();
    await db.rpc("enroll_in_campaign", { p_campaign: other, p_company_ids: [a] });
    const p2 = await one<{ id: string }>(`select id from campaign_participants where campaign_id = $1`, [other]);
    await db.rpc("activate_participants", { p_campaign: other, p_ids: [p2.id], p_confirm_conflicts: true });
    const lea = await one<{ id: string }>(`select id from people where first_name = 'Léa'`);
    await db.rpc("record_reply", { p_participant: participant, p_content: "Intéressée", p_person: lea.id });
    const rows = await db.query<{ status: string; outcome: string }>(`select status, outcome from campaign_participants order by created_at`);
    expect(rows.rows).toEqual([{ status: "a_repondu", outcome: "replied" }, { status: "a_repondu", outcome: "replied" }]);
    expect(campaign).toBeTruthy();
  });

  test("intéressé → pipeline sans recréer la fiche ; pas intéressé arrête ; ne plus contacter bloque", async () => {
    const { participant, company: a } = await activeParticipant();
    const p = await one<{ id: string }>(`insert into pipelines (name) values ('Ventes') returning id`);
    const s = await one<{ id: string }>(`insert into stages (pipeline_id, name) values ($1, 'RDV') returning id`, [p.id]);
    await db.rpc("set_participant_outcome", { p_participant: participant, p_outcome: "interested", p_stage: s.id });
    const c = await one<{ stage_id: string }>(`select stage_id from companies where id = $1`, [a]);
    expect(c.stage_id).toBe(s.id);
    expect(await n(`select count(*)::int n from companies`)).toBe(1);
    const row = await one<{ outcome: string; moved: boolean; status: string }>(`select outcome, moved_to_pipeline_at is not null moved, status from campaign_participants`);
    expect(row).toEqual({ outcome: "interested", moved: true, status: "arrete" });

    const b = await company("Beta");
    const camp = await campaignWith();
    await db.rpc("enroll_in_campaign", { p_campaign: camp, p_company_ids: [b] });
    const pb = await one<{ id: string }>(`select id from campaign_participants where company_id = $1`, [b]);
    await db.rpc("activate_participants", { p_campaign: camp, p_ids: [pb.id] });
    await db.rpc("set_participant_outcome", { p_participant: pb.id, p_outcome: "do_not_contact", p_note: "RGPD" });
    const cb = await one<{ do_not_contact: boolean }>(`select do_not_contact from companies where id = $1`, [b]);
    expect(cb.do_not_contact).toBe(true);
    const camp2 = await campaignWith();
    const r = await db.rpc<{ added: number; blocked: number }>("enroll_in_campaign", { p_campaign: camp2, p_company_ids: [b] });
    expect(r).toMatchObject({ added: 0, blocked: 1 });
  });

  test("campagne en pause : actions retirées de la file, validation refusée, historique conservé", async () => {
    const { campaign, participant } = await activeParticipant();
    await db.rpc("complete_step", { p_participant: participant, p_content: "ok" });
    await db.query(`update campaign_participants set next_due_date = current_date`);
    await db.rpc("set_campaign_status", { p_campaign: campaign, p_status: "paused" });
    expect(await n(`select count(*)::int n from todo_items where item_type = 'followup'`)).toBe(0);
    await expect(db.rpc("complete_step", { p_participant: participant, p_content: "x" })).rejects.toThrow(/en pause/);
    await db.rpc("set_campaign_status", { p_campaign: campaign, p_status: "active" });
    expect(await n(`select count(*)::int n from todo_items where item_type = 'followup'`)).toBe(1);
    expect(await n(`select count(*)::int n from interactions where kind = 'message_out'`)).toBe(1);
  });

  test("statistiques fondées sur les événements, une entreprise comptée une fois", async () => {
    const { campaign, participant } = await activeParticipant();
    await db.rpc("complete_step", { p_participant: participant, p_content: "inv" });
    await db.rpc("complete_step", { p_participant: participant, p_content: "msg" });
    await db.rpc("record_reply", { p_participant: participant, p_content: "Oui" });
    await db.rpc("set_participant_outcome", { p_participant: participant, p_outcome: "meeting" });
    const s = await one<Record<string, number>>(`select enrolled, contacted, replied, interested, meetings from campaign_overview where id = $1`, [campaign]);
    expect(s).toEqual({ enrolled: 1, contacted: 1, replied: 1, interested: 1, meetings: 1 });
  });
});
