// Socle commun des générateurs : dossier (double clic), réponses et provenance, sources décochables lues par Claude
// pour la seule fiche du dossier, versions figées une fois validées, états récupérables, droits imposés en base.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let acme: string;
let other: string;
let dossier: string;

const start = (company: string, key: string, kind = "proposal") => db.rpc<{ id: string; created: boolean }>("generator_start", { p_kind: kind, p_company: company, p_project: null, p_key: key });
const save = (answers: unknown[], origin: string, id = dossier) => db.rpc<number>("generator_save_answers", { p_id: id, p_answers: JSON.stringify(answers), p_origin: origin });
const answers = async () => Object.fromEntries((await db.query<{ question_key: string; value: unknown; origin: string; provenance: string | null }>(
  `select question_key, value, origin, provenance from generator_answers where dossier_id = $1`, [dossier])).rows.map((r) => [r.question_key, r]));
const sources = async (id = dossier) => db.rpc<{ cle: string; type: string; retenue: boolean }[]>("generator_sources", { p_id: id });
const generate = (key: string, id = dossier) => db.rpc<{ id: string; version: number; created: boolean }>("generator_generate", { p_id: id, p_key: key, p_feedback: null });

async function seedCall(company: string) {
  await db.exec(`reset role;`);
  const c = await db.one<{ id: string }>(`insert into fireflies_calls (account_id, fireflies_id, title) values ('c', $1, 'Appel découverte') returning id`, [crypto.randomUUID()]);
  await db.query(`update fireflies_calls set link_state = 'linked', company_id = $1 where id = $2`, [company, c.id]);
  await db.query(`insert into fireflies_call_transcripts (call_id, lines) values ($1, '[{"text":"un"},{"text":"deux"},{"text":"trois"}]')`, [c.id]);
  await db.as("owner");
  return c.id;
}
async function seedFile(company: string) {
  await db.exec(`reset role;`);
  const f = await db.one<{ id: string }>(
    `insert into company_files (company_id, display_name, mime_type, size_bytes, storage_path, status) values ($1, 'Proposition.pdf', 'application/pdf', 10, $2, 'ready') returning id`,
    [company, `${company}/${crypto.randomUUID()}.pdf`]);
  await db.as("owner");
  return f.id;
}
/** Dépôt complet des slides par la session Claude. */
async function deposit(id = dossier) {
  await db.as("claude");
  const v = await db.rpc<{ id: string; version: number }>("generator_version_open", { p_id: id });
  const company = await db.rpc<string>("generator_company", { p_id: id });
  const file = await seedFile(company);
  await db.as("claude");
  await db.rpc("generator_version_attach", { p_version: v.id, p_file: file });
  await db.rpc("generator_version_ready", { p_id: id, p_version: v.version });
  await db.as("owner");
  return v;
}

beforeEach(async () => {
  db = await createDb();
  acme = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Acme" }, p_people: [{ first_name: "Ada", last_name: "Martin", email: "ada@acme.example.test" }] })).id;
  other = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Autre" }, p_people: [] })).id;
  dossier = (await start(acme, "cle-acme-1")).id;
});

describe("dossier", () => {
  test("un double clic renvoie le même dossier ; la clé ne sert pas sur une autre fiche", async () => {
    expect(await start(acme, "cle-acme-1")).toEqual({ id: dossier, created: false });
    expect((await start(acme, "cle-acme-2")).created).toBe(true);
    await expect(start(other, "cle-acme-1")).rejects.toThrow(/Demande invalide/);
    await expect(start(acme, "cle-acme-3", "facture")).rejects.toThrow(/Générateur inconnu/);
  });

  test("Claude, un autre compte et un anonyme ne créent rien, ne valident rien, ne lancent rien", async () => {
    const v = await generate("gen-0000001");
    await deposit();
    for (const who of ["claude", "stranger", "anon"] as const) {
      await db.as(who);
      const refused = who === "anon" ? /permission denied/ : who === "claude" ? /impossible via Claude/ : /Accès refusé/;
      await expect(start(acme, `cle-${who}-00`)).rejects.toThrow(refused);
      await expect(generate(`gen-${who}-00`)).rejects.toThrow(refused);
      await expect(db.rpc("generator_validate", { p_version: v.id })).rejects.toThrow(refused);
      await expect(db.rpc("generator_mark_sent", { p_version: v.id, p_mail: null })).rejects.toThrow(refused);
      await expect(db.rpc("generator_claim_trigger", { p_id: dossier, p_ref: "prefill" })).rejects.toThrow(refused);
      await expect(db.rpc("generator_set_selection", { p_id: dossier, p_excluded: [], p_library: null })).rejects.toThrow(refused);
      await expect(db.rpc("generator_set_default_library", { p_kind: "proposal", p_items: [] })).rejects.toThrow(refused);
    }
    await db.as("stranger");
    expect((await db.query(`select 1 from generator_dossiers`)).rows).toEqual([]);
    expect((await db.query(`select 1 from generator_versions`)).rows).toEqual([]);
    await expect(db.rpc("generator_sources", { p_id: dossier })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("generator_read", { p_id: dossier, p_key: "fiche" })).rejects.toThrow(/Accès refusé/);
    await expect(db.query(`update generator_versions set validated_at = now()`)).rejects.toThrow(/permission denied/);
    await db.as("anon");
    await expect(db.query(`select 1 from generator_answers`)).rejects.toThrow(/permission denied/);
  });

  test("une fusion de fiches conserve le dossier", async () => {
    await db.exec(`reset role; update companies set merged_into_id = '${other}' where id = '${acme}';`);
    await db.as("owner");
    expect(await db.rpc("generator_company", { p_id: dossier })).toBe(other);
  });
});

describe("réponses", () => {
  test("le propriétaire a toujours le dernier mot ; Claude remplace le CRM, jamais l'inverse", async () => {
    await save([{ key: "offre", value: "audit", provenance: "repris de la fiche" }, { key: "prix", value: 1200, provenance: "repris de la fiche" }], "crm");
    await db.as("claude");
    // un appel venu de Claude est enregistré comme tel, quelle que soit l'origine annoncée
    await save([{ key: "offre", value: "growth_part_time", provenance: "repris de l'appel du 12/11" }, { key: "ton", value: "direct", provenance: "repris de l'appel du 12/11" }], "owner");
    await db.as("owner");
    await save([{ key: "prix", value: 1500 }], "owner");
    await save([{ key: "offre", value: "audit", provenance: "repris de la fiche" }, { key: "prix", value: 900, provenance: "repris de la fiche" }], "crm");
    await db.as("claude");
    await save([{ key: "prix", value: 1 }], "claude");
    await db.as("owner");
    const a = await answers();
    expect(a.offre).toMatchObject({ value: "growth_part_time", origin: "claude", provenance: "repris de l'appel du 12/11" });
    expect(a.prix).toMatchObject({ value: 1500, origin: "owner", provenance: null });
    expect(a.ton.origin).toBe("claude");
  });

  test("une réponse vidée par le propriétaire disparaît ; clés et volumes invalides refusés", async () => {
    await save([{ key: "ton", value: "direct" }], "owner");
    await save([{ key: "ton", value: "" }, { key: "Clé invalide", value: "x" }], "owner");
    expect(await answers()).toEqual({});
    await expect(save(Array.from({ length: 101 }, (_, i) => ({ key: `q_${i}`, value: "x" })), "owner")).rejects.toThrow(/Réponses invalides/);
    await expect(save([{ key: "ton", value: "x" }], "owner", crypto.randomUUID())).rejects.toThrow(/Dossier introuvable/);
  });
});

describe("sources", () => {
  test("le CRM rassemble ce qu'il sait de la fiche du dossier, et rien d'une autre fiche", async () => {
    const call = await seedCall(acme);
    await seedCall(other);
    const file = await seedFile(acme);
    await db.rpc("log_interaction", { p: { company_id: acme, kind: "note", content: "Budget validé par la direction" } }).catch(() => db.query(`insert into interactions (company_id, kind, content) values ($1, 'note', 'Budget validé')`, [acme]));
    const list = await sources();
    expect(list.map((s) => s.cle)).toEqual(expect.arrayContaining(["fiche", "personnes", `appel:${call}`, `fichier:${file}`, "notes"]));
    expect(list.filter((s) => s.type === "appel")).toHaveLength(1);
    expect(list.every((s) => s.retenue)).toBe(true);
  });

  test("une source décochée n'est plus lisible, même par son identifiant ; la fiche ne se décoche pas", async () => {
    const call = await seedCall(acme);
    const foreign = await seedCall(other);
    await db.as("claude");
    expect(await db.rpc<{ total_lignes: number; lignes: unknown[] }>("generator_read", { p_id: dossier, p_key: `appel:${call}`, p_offset: 1, p_limit: 1 })).toMatchObject({ total_lignes: 3, lignes: [{ text: "deux" }] });
    await expect(db.rpc("generator_read", { p_id: dossier, p_key: `appel:${foreign}` })).rejects.toThrow(/introuvable ou écartée/);
    await db.as("owner");
    await db.rpc("generator_set_selection", { p_id: dossier, p_excluded: [`appel:${call}`, "personnes", "fiche", "n'importe quoi"], p_library: null });
    expect((await sources()).filter((s) => !s.retenue).map((s) => s.cle).sort()).toEqual([`appel:${call}`, "personnes"].sort());
    await db.as("claude");
    await expect(db.rpc("generator_read", { p_id: dossier, p_key: `appel:${call}` })).rejects.toThrow(/introuvable ou écartée/);
    await expect(db.rpc("generator_read", { p_id: dossier, p_key: "personnes" })).rejects.toThrow(/introuvable ou écartée/);
    expect(await db.rpc<{ nom: string }>("generator_read", { p_id: dossier, p_key: "fiche" })).toMatchObject({ nom: "Acme" });
    // Claude reste privé d'accès direct aux appels et aux emails
    expect((await db.query(`select 1 from fireflies_calls`)).rows).toEqual([]);
  });

  test("sélection de la bibliothèque : défaut par générateur, ajustable par dossier, éléments inconnus écartés", async () => {
    await db.exec(`reset role;`);
    const item = (await db.one<{ id: string }>(`insert into diagnostic_library_files (display_name, mime_type, size_bytes, storage_path, status, category) values ('Grille tarifaire', 'application/pdf', 10, 'lib/grille.pdf', 'ready', 'other') returning id`)).id;
    await db.as("owner");
    expect(await db.rpc("generator_set_default_library", { p_kind: "proposal", p_items: [item, crypto.randomUUID()] })).toEqual([item]);
    const d2 = (await start(acme, "cle-acme-lib")).id;
    expect((await db.one<{ library_item_ids: string[] }>(`select library_item_ids from generator_dossiers where id = $1`, [d2])).library_item_ids).toEqual([item]);
    await db.rpc("generator_set_selection", { p_id: d2, p_excluded: [], p_library: [] });
    expect((await db.one<{ library_item_ids: string[] }>(`select library_item_ids from generator_dossiers where id = $1`, [d2])).library_item_ids).toEqual([]);
    // le réglage par défaut n'a pas bougé
    expect((await db.one<{ library_item_ids: string[] }>(`select library_item_ids from generator_settings where kind = 'proposal'`)).library_item_ids).toEqual([item]);
  });
});

describe("versions", () => {
  test("chaque génération crée une version avec les réponses qui l'ont produite ; un double clic n'en crée qu'une", async () => {
    await save([{ key: "offre", value: "audit" }], "owner");
    const v1 = await generate("gen-0000001");
    expect(v1).toMatchObject({ version: 1, created: true });
    expect(await generate("gen-0000001")).toEqual({ ...v1, created: false });
    // autre clé pendant que la génération est en cours (second onglet) : la même version
    expect(await generate("gen-0000002")).toEqual({ ...v1, created: false });
    await deposit();
    await save([{ key: "offre", value: "growth_part_time" }], "owner");
    const v2 = await generate("gen-0000003");
    expect(v2).toMatchObject({ version: 2, created: true });
    const rows = (await db.query<{ version: number; offre: string; slides_status: string }>(
      `select version, answers -> 'offre' ->> 'value' as offre, slides_status from generator_versions where dossier_id = $1 order by version`, [dossier])).rows;
    expect(rows).toEqual([{ version: 1, offre: "audit", slides_status: "ready" }, { version: 2, offre: "growth_part_time", slides_status: "pending" }]);
  });

  test("une version validée ne se modifie plus : ni réponses, ni fichier, ni par Claude ; valider deux fois ne change rien", async () => {
    await save([{ key: "offre", value: "audit" }], "owner");
    const v = await generate("gen-0000001");
    await expect(db.rpc("generator_validate", { p_version: v.id })).rejects.toThrow(/pas encore reçues/);
    await deposit();
    const at = await db.rpc<string>("generator_validate", { p_version: v.id });
    expect(await db.rpc("generator_validate", { p_version: v.id })).toEqual(at);
    await db.exec(`reset role;`);
    await expect(db.query(`update generator_versions set answers = '{}' where id = $1`, [v.id])).rejects.toThrow(/validée : elle ne se modifie plus/);
    await expect(db.query(`update generator_versions set slides_status = 'pending' where id = $1`, [v.id])).rejects.toThrow(/ne se modifie plus/);
    await db.as("claude");
    await expect(db.rpc("generator_version_open", { p_id: dossier })).rejects.toThrow(/Aucune version à produire/);
    await db.as("owner");
    // les réponses de travail restent modifiables : elles serviront à la version suivante
    await save([{ key: "offre", value: "decouverte" }], "owner");
    expect((await db.one<{ o: string }>(`select answers -> 'offre' ->> 'value' as o from generator_versions where id = $1`, [v.id])).o).toBe("audit");
    expect((await generate("gen-0000002")).version).toBe(2);
  });

  test("envoi : seulement une version validée, noté une seule fois", async () => {
    const v = await generate("gen-0000001");
    await deposit();
    await expect(db.rpc("generator_mark_sent", { p_version: v.id, p_mail: null })).rejects.toThrow(/Validez la version/);
    await db.rpc("generator_validate", { p_version: v.id });
    const at = await db.rpc<string>("generator_mark_sent", { p_version: v.id, p_mail: null });
    expect(await db.rpc("generator_mark_sent", { p_version: v.id, p_mail: null })).toEqual(at);
  });

  test("échec signalé : la version devient relançable, les réponses sont conservées, la relance reprend la même version", async () => {
    await save([{ key: "offre", value: "audit" }], "owner");
    const v = await generate("gen-0000001");
    await db.as("claude");
    await db.rpc("generator_report_failure", { p_id: dossier, p_message: "Modèle de slides illisible" });
    await db.as("owner");
    expect(await db.one(`select slides_status, slides_error from generator_versions where id = $1`, [v.id])).toEqual({ slides_status: "failed", slides_error: "Modèle de slides illisible" });
    expect((await answers()).offre.value).toBe("audit");
    expect(await db.rpc("generator_retry_slides", { p_version: v.id })).toBe(dossier);
    expect((await deposit()).version).toBe(1);
    await expect(db.rpc("generator_retry_slides", { p_version: v.id })).rejects.toThrow(/pas à relancer/);
  });

  test("un fichier d'une autre fiche ne peut pas devenir une version", async () => {
    await generate("gen-0000001");
    const foreign = await seedFile(other);
    await db.as("claude");
    const v = await db.rpc<{ id: string }>("generator_version_open", { p_id: dossier });
    await expect(db.rpc("generator_version_attach", { p_version: v.id, p_file: foreign })).rejects.toThrow(/Fichier ou version invalide/);
  });
});

describe("lancement de la tâche Claude", () => {
  const claim = (ref: string) => db.rpc<boolean>("generator_claim_trigger", { p_id: dossier, p_ref: ref });

  test("une étape ne se réserve qu'une fois ; un échec ou dix minutes sans résultat la rendent relançable", async () => {
    expect(await claim("prefill")).toBe(true);
    expect(await claim("prefill")).toBe(false);
    expect((await db.one<{ prefill_state: string }>(`select prefill_state from generator_dossiers where id = $1`, [dossier])).prefill_state).toBe("requested");
    await db.rpc("generator_trigger_result", { p_id: dossier, p_session_url: null, p_error: "Claude n'a pas pu être joint." });
    expect((await db.one<{ prefill_state: string }>(`select prefill_state from generator_dossiers where id = $1`, [dossier])).prefill_state).toBe("failed");
    expect(await claim("prefill")).toBe(true);
    await db.rpc("generator_trigger_result", { p_id: dossier, p_session_url: "https://claude.ai/code/session_01X", p_error: null });
    expect(await claim("prefill")).toBe(false);
    // session fermée sans rien signaler
    await db.exec(`reset role; update generator_dossiers set triggered_at = now() - interval '11 minutes' where id = '${dossier}';`);
    await db.as("owner");
    expect(await claim("prefill")).toBe(true);
    expect(await claim("slides:1")).toBe(true);
    expect(await claim("slides:1")).toBe(false);
  });

  test("le pré-remplissage de Claude clôt l'étape", async () => {
    await claim("prefill");
    await db.as("claude");
    await save([{ key: "ton", value: "direct", provenance: "repris de l'appel du 12/11" }], "claude");
    await db.as("owner");
    expect((await db.one<{ prefill_state: string }>(`select prefill_state from generator_dossiers where id = $1`, [dossier])).prefill_state).toBe("done");
  });
});
