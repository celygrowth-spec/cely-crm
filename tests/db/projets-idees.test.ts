// Projets — phase 5 : boîte à idées. Propositions et commentaires des membres, décision de l'administrateur,
// idée → tâche sans doublon, cloisonnement.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
let acme: Awaited<ReturnType<typeof company>>;
let pid: string;
let other: string;
let alice: string;
let bob: string;

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
  acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
  pid = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"], acme.people["bob@acme.fr"]]);
  other = await project(db, acme.id, "Autre", [acme.people["bob@acme.fr"]]);
  alice = (await login(db, acme.people["alice@acme.fr"])).session;
  bob = (await login(db, acme.people["bob@acme.fr"])).session;
});

type Idea = { id: string; title: string; status: string; mine: boolean; can_edit: boolean; author: string; has_task: boolean; comments: { author: string }[] };
const save = (s: string, project: string, idea: string | null, title: string, description: string | null = null) =>
  portal<Idea>(db, "portal_idea_save", s, { p_project: project, p_idea: idea, p_title: title, p_description: description });

describe("boîte à idées", () => {
  test("proposer, voir l'auteur, commenter ; modification réservée à l'auteur tant que rien n'est décidé", async () => {
    const i = await save(alice, pid, null, "Un blog", "Pour le référencement");
    expect(i).toMatchObject({ author: "Alice", mine: true, can_edit: true, status: "a_explorer" });
    const seenByBob = (await portal<Idea[]>(db, "portal_ideas", bob, { p_project: pid }))[0];
    expect(seenByBob).toMatchObject({ mine: false, can_edit: false });
    await expect(save(bob, pid, i.id, "Piraté")).rejects.toThrow(/Seul l'auteur/);
    await portal(db, "portal_idea_comment", bob, { p_project: pid, p_idea: i.id, p_body: "Bonne idée" });
    expect((await save(alice, pid, i.id, "Un blog mensuel")).title).toBe("Un blog mensuel");
    await db.as("owner");
    await db.query(`update project_ideas set status = 'plus_tard', decision_note = 'Après la mise en ligne' where id = $1`, [i.id]);
    await expect(save(alice, pid, i.id, "Autre")).rejects.toThrow(/plus modifiable/);
    const after = (await portal<(Idea & { decision_note: string })[]>(db, "portal_ideas", alice, { p_project: pid }))[0];
    expect(after).toMatchObject({ status: "plus_tard", decision_note: "Après la mise en ligne", can_edit: false });
    expect(after.comments.map((c) => c.author)).toEqual(["Bob"]);
  });

  test("le client ne décide pas du statut ; projet non autorisé ou archivé refusé", async () => {
    const i = await save(bob, other, null, "Idée confidentielle");
    await expect(portal(db, "portal_ideas", alice, { p_project: other })).rejects.toThrow(/Projet introuvable/);
    await expect(portal(db, "portal_idea_comment", alice, { p_project: other, p_idea: i.id, p_body: "x" })).rejects.toThrow(/Projet introuvable/);
    // idée d'un autre projet référencée via un projet autorisé : introuvable
    await expect(portal(db, "portal_idea_comment", bob, { p_project: pid, p_idea: i.id, p_body: "x" })).rejects.toThrow(/Idée introuvable/);
    await db.as("anon");
    await expect(db.query(`update project_ideas set status = 'retenue'`)).rejects.toThrow(/permission denied/);
    await db.as("owner");
    await db.query(`update projects set status = 'archive' where id = $1`, [pid]);
    await expect(save(alice, pid, null, "Trop tard")).rejects.toThrow(/archivé/);
    expect(await portal(db, "portal_ideas", alice, { p_project: pid })).toEqual([]);
  });

  test("idée → tâche : une seule tâche, lien d'origine, idée retenue", async () => {
    const i = await save(alice, pid, null, "Ajouter un chat en ligne", "Sur la page contact");
    await db.as("owner");
    const t1 = await db.rpc<string>("project_idea_to_task", { p_idea: i.id });
    const t2 = await db.rpc<string>("project_idea_to_task", { p_idea: i.id });
    expect(t2).toBe(t1);
    expect(await db.one(`select title, description, idea_id, visible_to_client from project_tasks where id = $1`, [t1])).toMatchObject({
      title: "Ajouter un chat en ligne", description: "Sur la page contact", idea_id: i.id, visible_to_client: true });
    expect((await db.one<{ n: number }>(`select count(*)::int n from project_tasks where idea_id = $1`, [i.id])).n).toBe(1);
    expect((await portal<Idea[]>(db, "portal_ideas", bob, { p_project: pid }))[0]).toMatchObject({ status: "retenue", has_task: true });
    await db.as("owner");
    await expect(db.query(`insert into project_tasks (project_id, title, idea_id) values ($1, 'doublon', $2)`, [pid, i.id])).rejects.toThrow(/project_tasks_idea_uniq/);
  });
});
