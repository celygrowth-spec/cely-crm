// Règles métier vérifiées directement sur les migrations SQL (PGlite).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

type Created = { status: "created" | "duplicates"; id?: string; candidates?: { company_id: string; strength: string; reasons: string[] }[] };

let db: Db;

beforeEach(async () => {
  db = await createDb();
});

async function company(name: string, website: string | null, people: Record<string, unknown>[] = [], force = false) {
  return db.rpc<Created>("create_company", { p_company: { name, website }, p_people: people, p_force: force });
}

async function count(table: string, where = "true") {
  const r = await db.one<{ n: number }>(`select count(*)::int as n from public.${table} where ${where}`);
  return r.n;
}

async function pipelineWithStages(name: string, stages: string[]) {
  const p = await db.one<{ id: string }>(`insert into pipelines (name) values ($1) returning id`, [name]);
  const ids: string[] = [];
  for (const [i, s] of stages.entries()) {
    const st = await db.one<{ id: string }>(`insert into stages (pipeline_id, name, position) values ($1, $2, $3) returning id`, [p.id, s, i]);
    ids.push(st.id);
  }
  return { id: p.id, stages: ids };
}

describe("fiche unique", () => {
  test("une entreprise avec deux cofondateurs = une seule fiche", async () => {
    const r = await company("Acme", "acme.com", [
      { first_name: "Paul", last_name: "Martin", email: "paul@acme.com", title: "CEO" },
      { first_name: "Léa", last_name: "Durand", email: "lea@acme.com", title: "CTO" },
    ]);
    expect(r.status).toBe("created");
    expect(await count("companies")).toBe(1);
    expect(await count("people", `company_id = '${r.id}'`)).toBe(2);
    expect(await count("people", `company_id = '${r.id}' and is_primary`)).toBe(1);
  });

  test("ajout à deux listes puis campagne : une seule fiche, un seul participant", async () => {
    const r = await company("Acme", "acme.com", [{ first_name: "Paul", last_name: "Martin" }]);
    const l1 = await db.one<{ id: string }>(`insert into lists (name) values ('SaaS France') returning id`);
    const l2 = await db.one<{ id: string }>(`insert into lists (name) values ('Agences') returning id`);
    await db.query(`insert into list_members (list_id, company_id) values ($1, $3), ($2, $3)`, [l1.id, l2.id, r.id]);
    expect(await count("companies")).toBe(1);
    expect(await count("list_members")).toBe(2);

    const tpl = await db.one<{ id: string }>(`insert into templates (name) values ('LinkedIn 4 étapes') returning id`);
    await db.query(
      `insert into template_steps (template_id, position, name, channel, delay_days, message) values
       ($1, 1, 'Premier message', 'linkedin', 0, 'Bonjour {prénom}'),
       ($1, 2, 'Relance', 'linkedin', 3, 'Petite relance')`,
      [tpl.id],
    );
    const camp = await db.rpc<{ id: string; added: number; already_present: number }>("create_campaign", {
      p_name: "Q4",
      p_template: tpl.id,
      p_list_ids: [l1.id, l2.id],
    });
    expect(camp.added).toBe(1);
    expect(await count("campaign_participants")).toBe(1);

    // ajouter de nouveau une liste ne crée pas de doublon
    const again = await db.rpc<{ added: number }>("add_lists_to_campaign", { p_campaign: camp.id, p_list_ids: [l1.id] });
    expect(again.added).toBe(0);

    // supprimer une liste ne supprime pas la fiche
    await db.query(`delete from lists where id = $1`, [l1.id]);
    expect(await count("companies")).toBe(1);
  });
});

describe("campagnes manuelles", () => {
  async function setup() {
    const r = await company("Acme", "acme.com", [{ first_name: "Paul", last_name: "Martin" }]);
    const tpl = await db.one<{ id: string }>(`insert into templates (name) values ('Séquence') returning id`);
    await db.query(
      `insert into template_steps (template_id, position, name, channel, delay_days, message) values
       ($1, 1, 'Premier message', 'linkedin', 0, 'Modèle 1'),
       ($1, 2, 'Relance', 'linkedin', 3, 'Modèle 2'),
       ($1, 3, 'Email', 'email', 7, 'Modèle 3')`,
      [tpl.id],
    );
    const camp = await db.rpc<{ id: string }>("create_campaign", { p_name: "Test", p_template: tpl.id, p_list_ids: [] });
    await db.rpc("add_companies_to_campaign", { p_campaign: camp.id, p_company_ids: [r.id] });
    const cp = await db.one<{ id: string }>(`select id from campaign_participants`);
    return { companyId: r.id!, tplId: tpl.id, campaignId: camp.id, participantId: cp.id };
  }

  test("rien n'est envoyé tant que « Marquer comme envoyé » n'est pas utilisé", async () => {
    const { participantId } = await setup();
    expect(await count("interactions", "kind = 'message_out'")).toBe(0);
    const cp = await db.one<{ status: string; current_step: number }>(`select status, current_step from campaign_participants where id = $1`, [participantId]);
    expect(cp).toEqual({ status: "a_contacter", current_step: 1 });
  });

  test("marquer comme envoyé : contenu réel et date dans l'historique, échéance calculée depuis la date réelle", async () => {
    const { participantId } = await setup();
    await db.rpc("mark_step_sent", {
      p_participant: participantId,
      p_content: "Bonjour Paul, texte réellement envoyé",
      p_sent_at: "2026-10-20T10:00:00+02:00",
    });
    const msg = await db.one<{ content: string; occurred_at: Date; channel: string }>(
      `select content, occurred_at, channel from interactions where kind = 'message_out'`,
    );
    expect(msg.content).toBe("Bonjour Paul, texte réellement envoyé");
    expect(msg.channel).toBe("linkedin");
    expect(new Date(msg.occurred_at).toISOString()).toBe("2026-10-20T08:00:00.000Z");
    const cp = await db.one<{ status: string; current_step: number; due: string }>(
      `select status, current_step, next_due_date::text as due from campaign_participants where id = $1`,
      [participantId],
    );
    expect(cp).toEqual({ status: "en_cours", current_step: 2, due: "2026-10-23" });
    const c = await db.one<{ prospect_status: string; last: Date }>(`select prospect_status, last_interaction_at as last from companies`);
    expect(c.prospect_status).toBe("contacte");
    expect(new Date(c.last).toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });

  test("une réponse met les relances en pause", async () => {
    const { participantId } = await setup();
    await db.rpc("mark_step_sent", { p_participant: participantId, p_content: "Message 1" });
    await db.rpc("record_reply", { p_participant: participantId, p_content: "Intéressés, rappelez-moi" });
    const cp = await db.one<{ status: string; due: string | null }>(
      `select status, next_due_date::text as due from campaign_participants where id = $1`,
      [participantId],
    );
    expect(cp).toEqual({ status: "a_repondu", due: null });
    expect(await count("interactions", "kind = 'message_in' and campaign_participant_id is not null")).toBe(1);
    expect(await count("todo_items")).toBe(0);
  });

  test("modifier le modèle ne modifie pas une campagne déjà lancée", async () => {
    const { tplId, campaignId } = await setup();
    await db.query(`update template_steps set message = 'Nouveau texte' where template_id = $1`, [tplId]);
    await db.query(`delete from template_steps where template_id = $1 and position = 3`, [tplId]);
    expect(await count("campaign_steps", `campaign_id = '${campaignId}'`)).toBe(3);
    const s = await db.one<{ message: string }>(`select message from campaign_steps where campaign_id = $1 and position = 1`, [campaignId]);
    expect(s.message).toBe("Modèle 1");
  });

  test("entrer dans un pipeline arrête les relances actives, sans perdre l'historique", async () => {
    const { participantId, companyId } = await setup();
    await db.rpc("mark_step_sent", { p_participant: participantId, p_content: "Message 1" });
    const p = await pipelineWithStages("Prospects", ["Qualifié", "RDV prévu"]);
    const res = await db.rpc<{ stopped_followups: number }>("move_company", { p_company: companyId, p_stage: p.stages[0] });
    expect(res.stopped_followups).toBe(1);
    const cp = await db.one<{ status: string; stop_reason: string }>(`select status, stop_reason from campaign_participants`);
    expect(cp.status).toBe("arrete");
    expect(cp.stop_reason).toContain("Prospects");
    expect(await count("interactions", "kind = 'message_out'")).toBe(1);
  });
});

describe("pipelines", () => {
  test("transfert vers un autre pipeline sans duplication ni perte d'échanges", async () => {
    const r = await company("Acme", "acme.com", [{ first_name: "Paul", last_name: "Martin" }]);
    await db.rpc("add_interaction", { p_company: r.id, p_kind: "note", p_content: "Note interne" });
    await db.rpc("add_interaction", {
      p_company: r.id,
      p_kind: "message_in",
      p_content: "Réponse d'hier",
      p_occurred_at: new Date(Date.now() - 86400000).toISOString(),
    });
    const prospects = await pipelineWithStages("Prospects", ["Qualifié", "RDV prévu"]);
    const vente = await pipelineWithStages("Vente", ["Proposition", "Négociation"]);

    await db.rpc("move_company", { p_company: r.id, p_stage: prospects.stages[0] });
    await db.rpc("move_company", { p_company: r.id, p_stage: prospects.stages[1] });
    await db.rpc("move_company", { p_company: r.id, p_stage: vente.stages[0] });

    expect(await count("companies")).toBe(1);
    const c = await db.one<{ id: string; pipeline_id: string; stage_id: string }>(`select id, pipeline_id, stage_id from companies`);
    expect(c).toEqual({ id: r.id, pipeline_id: vente.id, stage_id: vente.stages[0] });
    expect(await count("interactions", "kind in ('note','message_in')")).toBe(2);
    expect(await count("interactions", "kind = 'stage_change'")).toBe(3);
    const last = await db.one<{ content: string }>(`select content from interactions where kind = 'stage_change' order by created_at desc, id limit 1 offset 0`);
    expect(last.content).toBeTruthy();
  });

  test("gagné / perdu conserve le dernier pipeline et la dernière étape", async () => {
    const r = await company("Acme", null);
    const p = await pipelineWithStages("Vente", ["Proposition"]);
    await db.rpc("move_company", { p_company: r.id, p_stage: p.stages[0] });
    await db.rpc("set_deal_status", { p_company: r.id, p_status: "lost", p_lost_reason: "Budget" });
    const c = await db.one<Record<string, unknown>>(`select deal_status, stage_id, pipeline_id, lost_reason from companies`);
    expect(c).toEqual({ deal_status: "lost", stage_id: p.stages[0], pipeline_id: p.id, lost_reason: "Budget" });
  });

  test("supprimer une étape non vide exige une destination ; aucune fiche supprimée", async () => {
    const r = await company("Acme", null);
    const p = await pipelineWithStages("Vente", ["A", "B"]);
    await db.rpc("move_company", { p_company: r.id, p_stage: p.stages[0] });
    await expect(db.rpc("delete_stage", { p_stage: p.stages[0] })).rejects.toThrow(/remplacement/);
    await db.rpc("delete_stage", { p_stage: p.stages[0], p_replacement: p.stages[1] });
    const c = await db.one<{ stage_id: string }>(`select stage_id from companies`);
    expect(c.stage_id).toBe(p.stages[1]);
    await expect(db.rpc("delete_pipeline", { p_pipeline: p.id })).rejects.toThrow(/destination/);
    expect(await count("companies")).toBe(1);
  });
});

describe("anti-doublons", () => {
  test("même domaine (avec protocole, www, chemin) → fiche existante signalée", async () => {
    const a = await company("Acme", "https://www.acme.com/");
    const b = await company("ACME Corp", "http://acme.com/contact?x=1");
    expect(b.status).toBe("duplicates");
    expect(b.candidates![0].company_id).toBe(a.id);
    expect(b.candidates![0].strength).toBe("exact");
    expect(b.candidates![0].reasons.join(" ")).toContain("Même domaine : acme.com");
    expect(await count("companies")).toBe(1);
  });

  test("même email (casse et espaces) → fiche existante signalée", async () => {
    await company("Acme", null, [{ first_name: "Paul", email: "paul@acme.io" }]);
    const b = await company("Autre nom", null, [{ first_name: "P", email: "  PAUL@acme.io " }]);
    expect(b.status).toBe("duplicates");
    expect(b.candidates![0].reasons.join(" ")).toContain("Même email");
  });

  test("même profil LinkedIn (variantes d'URL) → signalé", async () => {
    await company("Acme", null, [{ first_name: "Paul", linkedin_url: "https://fr.linkedin.com/in/paul-martin/" }]);
    const b = await company("Zeta", null, [{ first_name: "Paul", linkedin_url: "linkedin.com/in/paul-martin?utm=x" }]);
    expect(b.status).toBe("duplicates");
    expect(b.candidates![0].strength).toBe("exact");
  });

  test("deux entreprises avec des contacts Gmail différents ne sont pas regroupées", async () => {
    await company("Boulangerie Dupont", null, [{ first_name: "Jean", last_name: "Dupont", email: "jean.dupont@gmail.com" }]);
    const b = await company("Studio Graphik", null, [{ first_name: "Marie", last_name: "Leroy", email: "marie.leroy@gmail.com" }]);
    expect(b.status).toBe("created");
    const pairs = await db.query(`select * from list_duplicate_pairs()`);
    expect(pairs.rows).toHaveLength(0);
  });

  test("un sous-domaine différent n'est pas assimilé automatiquement", async () => {
    await company("Acme", "acme.com");
    const b = await company("Blog d'un tiers", "blog.acme.com");
    expect(b.candidates?.some((c) => c.strength === "exact") ?? false).toBe(false);
  });

  test("nom proche → à vérifier, jamais fusionné automatiquement ; création distincte possible après confirmation", async () => {
    await company("Acme SAS", null);
    const b = await company("ACME", null);
    expect(b.status).toBe("duplicates");
    expect(b.candidates![0].strength).toBe("similar");
    const forced = await company("ACME", null, [], true);
    expect(forced.status).toBe("created");
    expect(await count("companies")).toBe(2);
    const pairs = await db.query(`select * from list_duplicate_pairs()`);
    expect(pairs.rows).toHaveLength(1);
  });

  test("modification : un domaine déjà utilisé est signalé", async () => {
    await company("Acme", "acme.com");
    const b = await company("Beta", "beta.com");
    const res = await db.rpc<{ status: string }>("update_company", { p_id: b.id, p_patch: { website: "www.acme.com" } });
    expect(res.status).toBe("duplicates");
    const c = await db.one<{ website: string }>(`select website from companies where id = $1`, [b.id]);
    expect(c.website).toBe("beta.com");
  });

  test("ajout d'une personne dont l'email existe ailleurs → signalé", async () => {
    await company("Acme", null, [{ first_name: "Paul", email: "paul@acme.com" }]);
    const b = await company("Beta", null);
    const res = await db.rpc<{ status: string }>("upsert_person", { p_company: b.id, p_person: { first_name: "Paul", email: "paul@acme.com" } });
    expect(res.status).toBe("duplicates");
  });

  test("une même requête répétée (clé d'idempotence) ne crée qu'une fiche", async () => {
    const args = { p_company: { name: "Acme" }, p_people: [], p_force: false, p_idempotency_key: "req-123456789" };
    const a = await db.rpc<Created>("create_company", args);
    const b = await db.rpc<Created>("create_company", args);
    expect(b).toEqual(a);
    expect(await count("companies")).toBe(1);
  });
});

describe("import CSV", () => {
  const groups = [
    {
      key: "g1",
      action: "create",
      rows: [2, 3],
      row_hashes: ["h-row-2", "h-row-3"],
      company: { name: "Acme", website: "acme.com", source: "LinkedIn" },
      people: [
        { first_name: "Paul", last_name: "Martin", email: "paul@acme.com" },
        { first_name: "Léa", last_name: "Durand", email: "lea@acme.com" },
      ],
    },
    {
      key: "g2",
      action: "create",
      rows: [4],
      row_hashes: ["h-row-4"],
      company: { name: "Beta", website: "beta.io", source: "Salon Tech" },
      people: [{ first_name: "Zoé", email: "zoe@gmail.com" }],
    },
  ];

  test("un import répété ne crée pas de doublons", async () => {
    const first = await db.rpc<{ created: number; errors: unknown[] }>("import_commit", {
      p_idempotency_key: "import-aaaa-1",
      p_filename: "leads.csv",
      p_groups: groups,
    });
    expect(first.created).toBe(2);
    expect(first.errors).toEqual([]);
    expect(await count("people")).toBe(3);
    expect(await count("lead_sources", "name = 'Salon Tech'")).toBe(1);

    // rejouer exactement la même requête
    const replay = await db.rpc<{ replayed: boolean }>("import_commit", {
      p_idempotency_key: "import-aaaa-1",
      p_filename: "leads.csv",
      p_groups: groups,
    });
    expect(replay.replayed).toBe(true);
    expect(await count("companies")).toBe(2);

    // nouvel import du même fichier : la vérification reconnaît lignes et fiches
    const check = await db.rpc<{ key: string; candidates: { strength: string }[]; already_imported_company_ids: string[] }[]>(
      "import_check",
      {
        p_groups: groups.map((g) => ({
          key: g.key,
          name: g.company.name,
          website: g.company.website,
          emails: g.people.map((p) => p.email),
          linkedins: [],
          person_names: [],
          row_hashes: g.row_hashes,
        })),
      },
    );
    expect(check.every((g) => g.already_imported_company_ids.length === 1)).toBe(true);
    expect(check.every((g) => g.candidates.some((c) => c.strength === "exact"))).toBe(true);
  });

  test("le complément ne crée pas de fiche et n'écrase rien", async () => {
    const a = await company("Acme", "acme.com", [{ first_name: "Paul", last_name: "Martin", email: "paul@acme.com", phone: "0102030405" }]);
    await db.query(`update companies set description = 'Description existante' where id = $1`, [a.id]);
    const res = await db.rpc<{ completed: number; errors: unknown[] }>("import_commit", {
      p_idempotency_key: "import-bbbb-1",
      p_filename: "leads.csv",
      p_groups: [
        {
          key: "g1",
          action: "complete",
          target_company_id: a.id,
          rows: [2],
          row_hashes: ["x1"],
          company: { name: "Acme", website: "acme.com", description: "Nouvelle description" },
          people: [
            { first_name: "Paul", last_name: "Martin", email: "paul@acme.com", phone: "0999999999", title: "CEO" },
            { first_name: "Léa", last_name: "Durand", email: "lea@acme.com" },
          ],
        },
      ],
    });
    expect(res.completed).toBe(1);
    expect(await count("companies")).toBe(1);
    expect(await count("people")).toBe(2);
    const paul = await db.one<{ phone: string; title: string }>(`select phone, title from people where email_norm = 'paul@acme.com'`);
    expect(paul).toEqual({ phone: "0102030405", title: "CEO" });
    const c = await db.one<{ description: string }>(`select description from companies`);
    expect(c.description).toBe("Description existante");
  });

  test("une ligne en erreur est signalée sans bloquer les autres", async () => {
    const res = await db.rpc<{ created: number; errors: { rows: number[]; message: string }[] }>("import_commit", {
      p_idempotency_key: "import-cccc-1",
      p_filename: "leads.csv",
      p_groups: [
        { key: "ok", action: "create", rows: [2], row_hashes: ["r2"], company: { name: "Acme" }, people: [] },
        { key: "ko", action: "create", rows: [3], row_hashes: ["r3"], company: { name: "Bad" }, people: [{ first_name: "X", email: "pas-un-email" }] },
      ],
    });
    expect(res.created).toBe(1);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].rows).toEqual([3]);
    expect(res.errors[0].message).toContain("Email invalide");
    expect(await count("companies", "name = 'Bad'")).toBe(0);
  });
});

describe("fusion", () => {
  test("la fusion conserve contacts, historique, tâches, listes et trace l'ancien identifiant", async () => {
    const keep = await company("Acme", "acme.com", [{ first_name: "Paul", last_name: "Martin", email: "paul@acme.com" }]);
    const dup = await company("Acme France", null, [{ first_name: "Léa", last_name: "Durand", email: "lea@acme.com" }], true);
    await db.rpc("add_interaction", { p_company: dup.id, p_kind: "note", p_content: "Note sur le doublon" });
    await db.query(`insert into tasks (company_id, title, due_date) values ($1, 'Relancer Léa', current_date)`, [dup.id]);
    const list = await db.one<{ id: string }>(`insert into lists (name) values ('Agences') returning id`);
    await db.query(`insert into list_members (list_id, company_id) values ($1, $2)`, [list.id, dup.id]);

    const res = await db.rpc<{ status: string; people_moved: number }>("merge_companies", {
      p_keep: keep.id,
      p_merge: dup.id,
      p_fields: { name: "keep" },
    });
    expect(res.status).toBe("merged");
    expect(await count("people", `company_id = '${keep.id}'`)).toBe(2);
    expect(await count("people", `company_id = '${keep.id}' and is_primary`)).toBe(1);
    expect(await count("interactions", `company_id = '${keep.id}' and kind = 'note'`)).toBe(1);
    expect(await count("tasks", `company_id = '${keep.id}'`)).toBe(1);
    expect(await count("list_members", `company_id = '${keep.id}'`)).toBe(1);
    const tomb = await db.one<{ merged_into_id: string }>(`select merged_into_id from companies where id = $1`, [dup.id]);
    expect(tomb.merged_into_id).toBe(keep.id);
    expect(await count("merges", `merged_company_id = '${dup.id}'`)).toBe(1);
    expect(await count("company_overview")).toBe(1);
  });

  test("conflit de campagne : aucun suivi perdu silencieusement", async () => {
    const keep = await company("Acme", "acme.com");
    const dup = await company("Acme bis", null, [], true);
    const tpl = await db.one<{ id: string }>(`insert into templates (name) values ('T') returning id`);
    await db.query(`insert into template_steps (template_id, position, name, channel) values ($1, 1, 'Msg', 'email')`, [tpl.id]);
    const camp = await db.rpc<{ id: string }>("create_campaign", { p_name: "C", p_template: tpl.id, p_list_ids: [] });
    await db.rpc("add_companies_to_campaign", { p_campaign: camp.id, p_company_ids: [keep.id, dup.id] });
    const res = await db.rpc<{ campaign_conflicts: number }>("merge_companies", { p_keep: keep.id, p_merge: dup.id });
    expect(res.campaign_conflicts).toBe(1);
    expect(await count("interactions", `company_id = '${keep.id}' and kind = 'merge' and content like 'Campagne%'`)).toBe(1);
  });
});

describe("contrôle d'accès", () => {
  test("une personne non authentifiée ne peut ni lire ni modifier", async () => {
    await company("Acme", "acme.com");
    await db.as("anon");
    await expect(db.query(`select * from companies`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`insert into companies (name) values ('Pirate')`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("create_company", { p_company: { name: "Pirate" } })).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from search_companies('acme')`)).rejects.toThrow(/permission denied/);
  });

  test("un autre compte authentifié ne voit rien et ne peut rien écrire", async () => {
    await company("Acme", "acme.com");
    await db.as("stranger");
    const r = await db.query(`select * from companies`);
    expect(r.rows).toHaveLength(0);
    await expect(db.query(`insert into companies (name) values ('Pirate')`)).rejects.toThrow(/row-level security/);
    await expect(db.rpc("create_company", { p_company: { name: "Pirate" } })).rejects.toThrow(/Accès refusé/);
    const upd = await db.query(`update companies set name = 'Pirate'`);
    expect(upd.affectedRows).toBe(0);
    await db.as("owner");
    expect(await count("companies", "name = 'Acme'")).toBe(1);
  });

  test("Claude : écritures journalisées, fusion et suppression refusées", async () => {
    const a = await company("Acme", "acme.com");
    const b = await company("Beta", "beta.com");
    await db.as("claude");
    await db.rpc("add_interaction", { p_company: a.id, p_kind: "note", p_content: "Ajouté depuis Claude" });
    await expect(db.rpc("merge_companies", { p_keep: a.id, p_merge: b.id })).rejects.toThrow(/impossible via Claude/);
    const del = await db.query(`delete from interactions`);
    expect(del.affectedRows).toBe(0);
    await expect(db.rpc("set_archived", { p_ids: [a.id, b.id], p_archived: true })).rejects.toThrow(/impossible via Claude/);
    await db.as("owner");
    const note = await db.one<{ source: string }>(`select source from interactions where kind = 'note'`);
    expect(note.source).toBe("claude");
    expect(await count("activity_log", `actor = 'claude' and table_name = 'interactions'`)).toBeGreaterThan(0);
  });
});

describe("modèles, tâches et À faire", () => {
  test("enregistrer et dupliquer un modèle", async () => {
    const id = await db.rpc<string>("save_template", {
      p_id: null,
      p_name: "Séquence",
      p_steps: [
        { name: "Premier message", channel: "linkedin", delay_days: 0, message: "Bonjour {prénom}" },
        { name: "Relance", channel: "email", delay_days: 3 },
      ],
    });
    const copy = await db.rpc<string>("duplicate_template", { p_id: id });
    expect(await count("template_steps", `template_id = '${copy}'`)).toBe(2);
    await expect(db.rpc("save_template", { p_id: id, p_name: "X", p_steps: [] })).rejects.toThrow(/au moins une étape/);
  });

  test("création de tâche idempotente et vue À faire sans doublon", async () => {
    const r = await company("Acme", null);
    const args = { p_company: r.id, p_title: "Relancer Paul", p_due: "2026-11-06", p_person: null, p_idempotency_key: "mcp:task-12345678" };
    await db.rpc("create_task", args);
    await db.rpc("create_task", args);
    expect(await count("tasks")).toBe(1);
    const tpl = await db.rpc<string>("save_template", { p_id: null, p_name: "T", p_steps: [{ name: "Msg", channel: "email", delay_days: 0 }] });
    const camp = await db.rpc<{ id: string }>("create_campaign", { p_name: "C", p_template: tpl, p_list_ids: [] });
    await db.rpc("add_companies_to_campaign", { p_campaign: camp.id, p_company_ids: [r.id] });
    const items = await db.query<{ item_type: string }>(`select item_type from todo_items`);
    expect(items.rows.map((i) => i.item_type).sort()).toEqual(["followup", "task"]);
    await db.query(`update tasks set done_at = now()`);
    expect(await count("interactions", "kind = 'task_done'")).toBe(1);
    expect(await count("todo_items")).toBe(1);
  });
});
