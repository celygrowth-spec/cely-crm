// Parcours complet demandé (12 étapes), exécuté sur les vraies migrations.
// Les écrans s'appuient exactement sur ces fonctions SQL.
import { expect, test } from "vitest";
import { renderTemplate, remainingTokens } from "@/lib/prospection/steps";
import { createDb } from "./harness";

test("parcours : campagne LinkedIn → email → appel, de la création au pipeline", async () => {
  const db = await createDb();
  const one = <T = Record<string, unknown>>(sql: string, p?: unknown[]) => db.one<T>(sql, p);

  // données : deux entreprises dans deux listes qui se recoupent ; une personne sans prénom
  const acme = (await db.rpc<{ id: string }>("create_company", {
    p_company: { name: "Acme", website: "acme.io" },
    p_people: [{ first_name: "Paul", last_name: "Martin", email: "paul@acme.io", linkedin_url: "linkedin.com/in/paul", phone: "0102" }, { first_name: "Léa", last_name: "Durand" }],
  })).id;
  const beta = (await db.rpc<{ id: string }>("create_company", {
    p_company: { name: "Beta" },
    p_people: [{ last_name: "Sans-Prénom", linkedin_url: "linkedin.com/in/sp", email: "x@beta.fr" }],
  })).id;
  const l1 = await one<{ id: string }>(`insert into lists (name) values ('SaaS') returning id`);
  const l2 = await one<{ id: string }>(`insert into lists (name) values ('Fondateurs') returning id`);
  await db.query(`insert into list_members (list_id, company_id) values ($1,$3),($2,$3),($2,$4)`, [l1.id, l2.id, acme, beta]);

  // 1. je crée une campagne (brouillon)
  const camp = await db.rpc<string>("create_campaign_draft", { p_name: "Fondateurs SaaS" });
  // 2. séquence LinkedIn → email → appel
  await db.rpc("save_campaign_sequence", {
    p_campaign: camp,
    p_steps: [
      { name: "Message LinkedIn", step_type: "linkedin_message", delay_days: 0, message: "Bonjour {{prenom}}, j'ai vu {{entreprise}}." },
      { name: "Email", step_type: "email", delay_days: 3, subject: "{{entreprise}}", message: "Bonjour {{prenom}}" },
      { name: "Appel", step_type: "call", delay_days: 4 },
    ],
  });
  // 3. j'ajoute les listes : sans doublon
  const enr = await db.rpc<{ added: number; already_present: number }>("enroll_in_campaign", { p_campaign: camp, p_list_ids: [l1.id, l2.id] });
  expect(enr.added).toBe(2);
  // 4. je choisis les personnes ciblées (Acme : Paul par défaut ; on vérifie)
  const pa = await one<{ id: string; person_id: string }>(`select id, person_id from campaign_participants where company_id = $1`, [acme]);
  const paul = await one<{ id: string }>(`select id from people where first_name = 'Paul'`);
  expect(pa.person_id).toBe(paul.id);
  const pb = await one<{ id: string }>(`select id from campaign_participants where company_id = $1`, [beta]);

  // 5. variables manquantes : Beta n'a pas de prénom
  const tpl = await one<{ message: string }>(`select message from campaign_steps where campaign_id = $1 and position = 1`, [camp]);
  const missing = renderTemplate(tpl.message, { first_name: null, company: "Beta" });
  expect(missing.missing).toEqual(["prenom"]);
  expect(missing.text).not.toContain("undefined");
  // 6. personnalisation pour un seul participant (corrige la variable de Beta)
  await db.rpc("save_participant_draft", { p_participant: pb.id, p_position: 1, p_subject: null, p_body: "Bonjour, j'ai vu Beta." });
  const acmeDrafts = await db.one<{ n: number }>(`select count(*)::int n from participant_drafts where participant_id = $1`, [pa.id]);
  expect(acmeDrafts.n).toBe(0);

  // 7. j'active les participants prêts
  const act = await db.rpc<{ activated: number }>("activate_participants", { p_campaign: camp, p_ids: [pa.id, pb.id] });
  expect(act.activated).toBe(2);
  expect(await db.one<{ n: number }>(`select count(*)::int n from interactions where kind = 'message_out'`)).toEqual({ n: 0 });

  // 8. file de travail : deux actions dues aujourd'hui
  const queue = await db.query<{ id: string }>(`select id from todo_items where item_type = 'followup' and due_date <= public.today_paris()`);
  expect(queue.rows).toHaveLength(2);

  // un message contenant encore une variable est refusé (Focus bloque aussi côté interface)
  expect(remainingTokens("Bonjour {{prenom}}")).toEqual(["prenom"]);
  await expect(db.rpc("complete_step", { p_participant: pb.id, p_content: "Bonjour {{prenom}}" })).rejects.toThrow(/Variable non remplacée/);

  // 9. je valide un envoi (double clic) : prochaine échéance calculée depuis la date réelle
  const k = { p_participant: pa.id, p_content: "Bonjour Paul, j'ai vu Acme.", p_done_at: "2026-10-30T10:00:00+01:00", p_idempotency_key: "focus-parcours-1" };
  const r1 = await db.rpc<{ next_due_date: string }>("complete_step", k);
  await db.rpc("complete_step", k);
  expect(r1.next_due_date).toBe("2026-11-02");
  expect(await db.one(`select count(*)::int n from interactions where kind = 'message_out'`)).toEqual({ n: 1 });

  // 10. j'enregistre une réponse : relances suspendues
  await db.rpc("record_reply", { p_participant: pa.id, p_content: "Intéressé, appelez-moi" });
  const after = await one<{ status: string; next_due_date: string | null }>(`select status, next_due_date from campaign_participants where id = $1`, [pa.id]);
  expect(after).toEqual({ status: "a_repondu", next_due_date: null });

  // 11. je transfère l'entreprise dans un pipeline sans recréer la fiche
  const pipe = await one<{ id: string }>(`insert into pipelines (name) values ('Ventes') returning id`);
  const stage = await one<{ id: string }>(`insert into stages (pipeline_id, name) values ($1, 'RDV prévu') returning id`, [pipe.id]);
  await db.rpc("set_participant_outcome", { p_participant: pa.id, p_outcome: "interested", p_stage: stage.id });
  expect(await db.one(`select count(*)::int n from companies`)).toEqual({ n: 2 });
  expect(await one(`select stage_id from companies where id = $1`, [acme])).toEqual({ stage_id: stage.id });

  // 12. « rechargement » : brouillons, progression, historique et vues persistés en base
  await db.query(`insert into saved_views (scope, name, config) values ('participants', 'Ma vue', '{"filters":{"due":"late"}}')`);
  expect(await db.one(`select count(*)::int n from participant_drafts where participant_id = $1`, [pb.id])).toEqual({ n: 1 });
  expect(await one(`select current_step from campaign_participants where id = $1`, [pa.id])).toEqual({ current_step: 2 });
  expect(await db.one(`select count(*)::int n from interactions where company_id = $1 and kind in ('message_out','message_in')`, [acme])).toEqual({ n: 2 });
  expect(await db.one(`select count(*)::int n from saved_views`)).toEqual({ n: 1 });
  const stats = await one<Record<string, number>>(`select enrolled, contacted, replied, interested, moved_to_pipeline from campaign_overview where id = $1`, [camp]);
  expect(stats).toEqual({ enrolled: 2, contacted: 1, replied: 1, interested: 1, moved_to_pipeline: 1 });
});
