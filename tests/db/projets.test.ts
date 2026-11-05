// Projets et portail client — phase 1 : projets liés au CRM, accès par code, sessions, cloisonnement.
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
});

describe("projets et accès", () => {
  test("projet lié à la fiche CRM, contacts de l'entreprise uniquement, historique de la fiche", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
    const other = await company(db, "Autre", [{ first_name: "Zoé", email: "zoe@autre.fr" }]);
    const p = await project(db, acme.id, "Refonte du site", [acme.people["alice@acme.fr"]], false);
    expect(await db.one(`select company_name, member_count, status from project_overview where id = $1`, [p])).toMatchObject({ company_name: "Acme", member_count: 1, status: "a_preparer" });
    await expect(db.rpc("project_create", { p_data: JSON.stringify({ company_id: acme.id, name: "X" }), p_person_ids: `{${other.people["zoe@autre.fr"]}}` })).rejects.toThrow(/n'appartient pas/);
    await expect(db.rpc("project_add_member", { p_project: p, p_person: other.people["zoe@autre.fr"] })).rejects.toThrow(/n'appartient pas/);
    expect((await db.one<{ content: string }>(`select content from interactions where company_id = $1 and meta ? 'project_id'`, [acme.id])).content).toBe("Projet créé : Refonte du site");
  });

  test("connexion : projet non publié invisible ; publié visible ; jamais les notes internes", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
    const p = await project(db, acme.id, "Refonte", [acme.people["alice@acme.fr"]], false);
    const first = await login(db, acme.people["alice@acme.fr"]);
    expect(first.status).toBe("invalid"); // aucun projet publié : pas d'accès
    await db.as("owner");
    await db.query(`update projects set portal_published = true, internal_note = 'NOTE-INTERNE-SECRETE', blocked_reason = 'BLOCAGE-INTERNE' where id = $1`, [p]);
    const { status, session } = await login(db, acme.people["alice@acme.fr"]);
    expect(status).toBe("ok");
    const me = await portal<{ projects: { id: string }[] }>(db, "portal_me", session);
    expect(me.projects.map((x) => x.id)).toEqual([p]);
    const view = await portal(db, "portal_project", session, { p_project: p });
    expect(JSON.stringify(view)).not.toMatch(/NOTE-INTERNE|BLOCAGE-INTERNE|internal_note|blocked_reason/);
  });

  test("client sur plusieurs projets ; projet d'un autre client inaccessible par identifiant", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
    const p1 = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
    const p2 = await project(db, acme.id, "Logo", [acme.people["alice@acme.fr"], acme.people["bob@acme.fr"]]);
    const p3 = await project(db, acme.id, "Secret", [acme.people["bob@acme.fr"]]);
    const alice = await login(db, acme.people["alice@acme.fr"]);
    const me = await portal<{ projects: { id: string }[] }>(db, "portal_me", alice.session);
    expect(me.projects.map((x) => x.id).sort()).toEqual([p1, p2].sort());
    await expect(portal(db, "portal_project", alice.session, { p_project: p3 })).rejects.toThrow(/Projet introuvable/);
    await expect(portal(db, "portal_project", alice.session, { p_project: randomUUID() })).rejects.toThrow(/Projet introuvable/);
  });

  test("déconnexion, révocation, régénération et expiration invalident les sessions", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
    const p = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"], acme.people["bob@acme.fr"]]);
    const alice = await login(db, acme.people["alice@acme.fr"]);
    const bob = await login(db, acme.people["bob@acme.fr"]);
    await portal(db, "portal_logout", alice.session);
    await expect(portal(db, "portal_project", alice.session, { p_project: p })).rejects.toThrow(/Session expirée/);

    const alice2 = await login(db, acme.people["alice@acme.fr"]);
    await db.as("owner");
    await db.rpc("portal_access_revoke", { p_person: acme.people["alice@acme.fr"] });
    await expect(portal(db, "portal_project", alice2.session, { p_project: p })).rejects.toThrow(/Session expirée/);
    // révoquer Alice ne bloque pas Bob
    expect(await portal(db, "portal_project", bob.session, { p_project: p })).toMatchObject({ id: p });
    // ancien code refusé après révocation
    await db.as("anon");
    expect((await db.rpc<{ status: string }>("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(alice2.code), p_ip_hash: sha("9.9.9.9"), p_session_hash: sha("x"), p_user_agent: null })).status).toBe("invalid");

    // régénération : l'ancien code et les sessions de Bob tombent, le nouveau fonctionne
    const bob2 = await login(db, acme.people["bob@acme.fr"]);
    await expect(portal(db, "portal_project", bob.session, { p_project: p })).rejects.toThrow(/Session expirée/);
    await db.as("anon");
    expect((await db.rpc<{ status: string }>("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(bob.code), p_ip_hash: sha("8.8.8.8"), p_session_hash: sha("y"), p_user_agent: null })).status).toBe("invalid");
    expect(await portal(db, "portal_project", bob2.session, { p_project: p })).toMatchObject({ id: p });

    // expiration
    await db.query("reset role");
    await db.query(`update portal_accesses set expires_at = now() - interval '1 minute' where person_id = $1`, [acme.people["bob@acme.fr"]]);
    await expect(portal(db, "portal_project", bob2.session, { p_project: p })).rejects.toThrow(/Session expirée/);
  });

  test("retrait du projet : plus d'accès à ce projet ; archivage en lecture seule ou fermé", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
    const p1 = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
    const p2 = await project(db, acme.id, "Logo", [acme.people["alice@acme.fr"]]);
    const a = await login(db, acme.people["alice@acme.fr"]);
    await db.as("owner");
    await db.rpc("project_remove_member", { p_project: p2, p_person: acme.people["alice@acme.fr"] });
    await expect(portal(db, "portal_project", a.session, { p_project: p2 })).rejects.toThrow(/Projet introuvable/);
    await db.as("owner");
    await db.query(`update projects set status = 'archive', archived_at = now() where id = $1`, [p1]);
    expect(await portal(db, "portal_project", a.session, { p_project: p1 })).toMatchObject({ read_only: true });
    await db.as("owner");
    await db.query(`update projects set archived_portal = 'closed' where id = $1`, [p1]);
    await expect(portal(db, "portal_project", a.session, { p_project: p1 })).rejects.toThrow(/Projet introuvable/);
  });

  test("limitation des tentatives par adresse IP", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
    await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
    const { code } = await login(db, acme.people["alice@acme.fr"]);
    await db.as("anon");
    const attempt = (c: string, ip: string) => db.rpc<{ status: string }>("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(c), p_ip_hash: sha(ip), p_session_hash: sha(randomUUID()), p_user_agent: null });
    for (let i = 0; i < 8; i++) expect((await attempt(`faux-${i}`, "6.6.6.6")).status).toBe("invalid");
    expect((await attempt(code, "6.6.6.6")).status).toBe("rate_limited"); // même le bon code est bloqué
    expect((await attempt(code, "7.7.7.7")).status).toBe("ok");
  });

  test("aucun accès direct : anon, autre compte, jeton Claude, clé serveur absente, empreintes illisibles", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }]);
    const p = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
    const a = await login(db, acme.people["alice@acme.fr"]);
    await db.as("anon");
    for (const t of ["projects", "project_members", "portal_accesses", "portal_sessions", "project_activity"]) {
      await expect(db.query(`select * from ${t}`)).rejects.toThrow(/permission denied/);
    }
    await expect(db.rpc("portal_project", { p_server_key: "faux".repeat(10), p_session_hash: a.session, p_project: p })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("project_create", { p_data: "{}", p_person_ids: "{}" })).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select * from projects`)).rows).toEqual([]);
    await expect(db.rpc("portal_access_revoke", { p_person: acme.people["alice@acme.fr"] })).rejects.toThrow(/Accès refusé/);
    await db.as("claude");
    await expect(db.rpc("portal_access_issue", { p_person: acme.people["alice@acme.fr"], p_code_hash: sha("x"), p_code_hint: "xxxx", p_expires_at: null })).rejects.toThrow(/réservée à l'application/);
    await db.as("owner");
    await expect(db.query(`select code_hash from portal_accesses`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select token_hash from portal_sessions`)).rejects.toThrow(/permission denied/);
    expect((await db.query(`select code_hint from portal_accesses`)).rows).toHaveLength(1);
  });

  test("prévisualisation administrateur : mêmes règles que le portail", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.fr" }, { first_name: "Bob", email: "bob@acme.fr" }]);
    const p = await project(db, acme.id, "Site", [acme.people["alice@acme.fr"]]);
    await db.as("owner");
    const v = await db.rpc("portal_preview_project", { p_project: p, p_person: acme.people["alice@acme.fr"] });
    expect(JSON.stringify(v)).not.toMatch(/NOTE-INTERNE/);
    await expect(db.rpc("portal_preview_project", { p_project: p, p_person: acme.people["bob@acme.fr"] })).rejects.toThrow(/pas membre/);
  });
});
