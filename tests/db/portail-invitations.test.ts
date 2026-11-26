// Portail client : invitation par mail, création du mot de passe, connexion par email, mot de passe oublié.
// Adresses fictives uniquement. Les empreintes de mot de passe sont des valeurs de forme (le calcul scrypt
// est fait par le serveur Next et testé dans tests/unit).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";
import { SERVER_KEY, company, login, portal, project, sha } from "./projets-helpers";

let db: Db;
beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: sha(SERVER_KEY) });
});

const PW = "scrypt$16384$8$1$c2VsLWZpY3RpZg$aGFzaC1maWN0aWY";
const PW2 = "scrypt$16384$8$1$c2VsLWF1dHJl$aGFzaC1hdXRyZQ";

async function invite(personId: string, projectId: string | null, opts: { kind?: "invitation" | "reset"; request?: string; token?: string; expires?: string | null } = {}) {
  await db.as("owner");
  const token = opts.token ?? randomUUID();
  const r = await db.rpc<{ id: string; email: string; duplicate: boolean }>("portal_invite_create", {
    p_person: personId, p_project: projectId, p_kind: opts.kind ?? "invitation", p_token_hash: sha(token), p_request_id: opts.request ?? randomUUID(), p_expires_at: opts.expires ?? null,
  });
  return { ...r, token };
}
const mark = async (id: string, sent: boolean) => { await db.as("owner"); await db.rpc("portal_invite_mark", { p_id: id, p_sent: sent, p_mail_id: null }); };
async function check(token: string, ip = "1.1.1.1") {
  await db.as("anon");
  return db.rpc<{ status: string; email?: string; kind?: string }>("portal_invite_check", { p_server_key: SERVER_KEY, p_token_hash: sha(token), p_ip_hash: sha(ip) });
}
async function activate(token: string, pw = PW, ip = "1.1.1.1") {
  await db.as("anon");
  const session = sha(randomUUID());
  const r = await db.rpc<{ status: string }>("portal_invite_activate", { p_server_key: SERVER_KEY, p_token_hash: sha(token), p_password_hash: pw, p_ip_hash: sha(ip), p_session_hash: session, p_user_agent: "test" });
  return { ...r, session };
}
async function passwordLogin(email: string, ok: boolean, ip = "2.2.2.2") {
  await db.as("anon");
  const c = await db.rpc<{ status: string; access_id?: string; hash?: string }>("portal_password_challenge", { p_server_key: SERVER_KEY, p_email: email, p_email_hash: sha(email.trim().toLowerCase()), p_ip_hash: sha(ip) });
  if (c.status === "rate_limited") return { status: "rate_limited", session: "", challenge: c };
  const session = sha(randomUUID());
  const r = await db.rpc<{ status: string }>("portal_password_login", {
    p_server_key: SERVER_KEY, p_access: c.access_id ?? null, p_password_hash: c.hash ?? null, p_ok: ok && c.status === "ok",
    p_email_hash: sha(email.trim().toLowerCase()), p_ip_hash: sha(ip), p_session_hash: session, p_user_agent: null,
  });
  return { ...r, session, challenge: c };
}
const inv = async (id: string) => { await db.as("owner"); return db.one<{ sent_at: string | null; used_at: string | null; invalidated_reason: string | null }>(`select sent_at, used_at, invalidated_reason from portal_invitations where id = $1`, [id]); };

async function setup() {
  const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.exemple.test" }, { first_name: "Bob", email: "bob@acme.exemple.test" }]);
  const alice = acme.people["alice@acme.exemple.test"];
  const bob = acme.people["bob@acme.exemple.test"];
  const p1 = await project(db, acme.id, "Refonte", [alice, bob]);
  const p2 = await project(db, acme.id, "SEO", [bob]);
  return { acme, alice, bob, p1, p2 };
}

describe("invitations", () => {
  test("création → lien → mot de passe → session sur les projets du contact ; usage unique", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    expect(i.email).toBe("alice@acme.exemple.test");
    await mark(i.id, true);
    expect((await inv(i.id)).sent_at).not.toBeNull();
    expect(await check(i.token)).toMatchObject({ status: "ok", email: "alice@acme.exemple.test", kind: "invitation" });
    const a = await activate(i.token);
    expect(a.status).toBe("ok");
    const me = await portal<{ projects: { id: string }[] }>(db, "portal_me", a.session);
    expect(me.projects.map((x) => x.id)).toEqual([p1]);
    expect((await inv(i.id)).used_at).not.toBeNull();
    // usage unique
    expect((await check(i.token)).status).toBe("invalid");
    expect((await activate(i.token, PW2)).status).toBe("invalid");
    await db.as("owner");
    expect(await db.one(`select activated_at is not null as on, code_hint from portal_accesses where person_id = $1`, [alice])).toEqual({ on: true, code_hint: null });
    // un compte activé ne reçoit pas de nouvelle invitation
    await expect(invite(alice, p1)).rejects.toThrow(/déjà un compte/);
  });

  test("le jeton ne se lit pas : seule son empreinte est stockée, illisible par l'API", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    await db.as("owner");
    await expect(db.query(`select token_hash from portal_invitations`)).rejects.toThrow(/permission/);
    await expect(db.query(`select password_hash from portal_accesses`)).rejects.toThrow(/permission/);
    await db.as("anon");
    await expect(db.query(`select * from portal_invitations`)).rejects.toThrow(/permission/);
    expect(i.token).not.toBe("");
  });

  test("double clic : même demande → une seule invitation", async () => {
    const { alice, p1 } = await setup();
    const request = randomUUID();
    const a = await invite(alice, p1, { request });
    const b = await invite(alice, p1, { request });
    expect(b).toMatchObject({ id: a.id, duplicate: true });
    await db.as("owner");
    expect((await db.one<{ n: number }>(`select count(*)::int n from portal_invitations where person_id = $1`, [alice])).n).toBe(1);
  });

  test("renvoi : l'ancien lien est refusé, le nouveau fonctionne", async () => {
    const { alice, p1 } = await setup();
    const first = await invite(alice, p1);
    const second = await invite(alice, p1);
    expect((await inv(first.id)).invalidated_reason).toBe("resent");
    expect((await check(first.token)).status).toBe("invalid");
    expect((await activate(second.token)).status).toBe("ok");
  });

  test("échec d'envoi : l'invitation est invalidée, un nouvel essai est possible", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    await mark(i.id, false);
    expect((await inv(i.id)).invalidated_reason).toBe("send_failed");
    expect((await check(i.token)).status).toBe("invalid");
    const again = await invite(alice, p1);
    await mark(again.id, true);
    expect((await check(again.token)).status).toBe("ok");
  });

  test("expiration après 7 jours", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    await db.exec("reset role;");
    expect((await db.one<{ d: number }>(`select extract(epoch from expires_at - created_at)::int / 86400 d from portal_invitations where id = $1`, [i.id])).d).toBe(7);
    await db.query(`update portal_invitations set expires_at = now() - interval '1 minute' where id = $1`, [i.id]);
    expect((await check(i.token)).status).toBe("invalid");
    expect((await activate(i.token)).status).toBe("invalid");
  });

  test("révocation entre l'envoi et le clic : lien refusé ; accès expiré : lien refusé", async () => {
    const { alice, bob, p1 } = await setup();
    const i = await invite(alice, p1);
    await db.as("owner");
    await db.rpc("portal_access_revoke", { p_person: alice });
    expect((await inv(i.id)).invalidated_reason).toBe("revoked");
    expect((await activate(i.token)).status).toBe("invalid");
    const j = await invite(bob, p1);
    await db.exec("reset role;");
    await db.query(`update portal_accesses set expires_at = now() - interval '1 minute' where person_id = $1`, [bob]);
    expect((await activate(j.token)).status).toBe("invalid");
  });

  test("email modifié sur la fiche après l'envoi : invitation invalidée ; casse et espaces ignorés", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    await db.as("owner");
    await db.query(`update people set email = '  ALICE@acme.exemple.test ' where id = $1`, [alice]);
    expect((await inv(i.id)).invalidated_reason).toBeNull();
    await db.query(`update people set email = 'alice.nouvelle@acme.exemple.test' where id = $1`, [alice]);
    expect((await inv(i.id)).invalidated_reason).toBe("email_changed");
    expect((await activate(i.token)).status).toBe("invalid");
    const again = await invite(alice, p1);
    expect(again.email).toBe("alice.nouvelle@acme.exemple.test");
  });

  test("contact sans email ou avec un email invalide : refus", async () => {
    const acme = await company(db, "Acme", [{ first_name: "Alice", email: "alice@acme.exemple.test" }]);
    const alice = acme.people["alice@acme.exemple.test"];
    const p = await project(db, acme.id, "Refonte", [alice]);
    await db.query(`update people set email = null where id = $1`, [alice]);
    await expect(invite(alice, p)).rejects.toThrow(/pas d'email/);
    // la fiche refuse déjà un email mal formé ; une donnée ancienne mal formée est refusée à l'invitation
    await db.exec("reset role; alter table people disable trigger user;");
    await db.query(`update people set email = 'pas-un-email' where id = $1`, [alice]);
    await db.exec("alter table people enable trigger user;");
    await expect(invite(alice, p)).rejects.toThrow(/n'est pas valide/);
  });

  test("double soumission de « Créer mon accès » : un seul compte, une seule session", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    const [a, b] = [await activate(i.token, PW), await activate(i.token, PW2)];
    expect([a.status, b.status]).toEqual(["ok", "invalid"]);
    await db.exec("reset role;");
    expect((await db.one<{ h: string }>(`select password_hash h from portal_accesses where person_id = $1`, [alice])).h).toBe(PW);
    expect((await db.one<{ n: number }>(`select count(*)::int n from portal_sessions s join portal_accesses a on a.id = s.access_id where a.person_id = $1`, [alice])).n).toBe(1);
  });

  test("jeton manipulé ou d'un autre contact : chacun n'obtient que son propre compte", async () => {
    const { alice, bob, p1, p2 } = await setup();
    const ia = await invite(alice, p1);
    const ib = await invite(bob, p1);
    expect((await check(ia.token + "x")).status).toBe("invalid");
    expect((await activate("jeton-invente")).status).toBe("invalid");
    // le jeton de Bob ouvre le compte de Bob, jamais celui d'Alice, quel que soit l'appelant
    const b = await activate(ib.token);
    const meB = await portal<{ person: { id: string }; projects: { id: string }[] }>(db, "portal_me", b.session);
    expect(meB.person.id).toBe(bob);
    expect(meB.projects.map((x) => x.id).sort()).toEqual([p1, p2].sort());
    const a = await activate(ia.token);
    const meA = await portal<{ person: { id: string }; projects: { id: string }[] }>(db, "portal_me", a.session);
    expect(meA.projects.map((x) => x.id)).toEqual([p1]);
    await expect(portal(db, "portal_project", a.session, { p_project: p2 })).rejects.toThrow();
  });

  test("même email sur deux fiches : pas de second compte", async () => {
    const { alice, p1 } = await setup();
    const other = await company(db, "Autre", [{ first_name: "Alice", email: "Alice@ACME.exemple.test" }]);
    const alice2 = other.people["Alice@ACME.exemple.test"] ?? Object.values(other.people)[0];
    const p3 = await project(db, other.id, "Autre projet", [alice2]);
    const i = await invite(alice, p1);
    expect((await activate(i.token)).status).toBe("ok");
    await expect(invite(alice2, p3)).rejects.toThrow(/déjà l'identifiant/);
  });

  test("rien n'est possible pour Claude ni pour un visiteur sans clé serveur", async () => {
    const { alice, p1 } = await setup();
    await db.as("claude");
    await expect(db.rpc("portal_invite_create", { p_person: alice, p_project: p1, p_kind: "invitation", p_token_hash: sha("t"), p_request_id: randomUUID(), p_expires_at: null })).rejects.toThrow(/réservée à l'application/);
    await db.as("anon");
    await expect(db.rpc("portal_invite_create", { p_person: alice, p_project: p1, p_kind: "invitation", p_token_hash: sha("t"), p_request_id: randomUUID(), p_expires_at: null })).rejects.toThrow(/permission/);
    await expect(db.rpc("portal_invite_check", { p_server_key: "mauvaise-cle", p_token_hash: sha("t"), p_ip_hash: sha("ip") })).rejects.toThrow();
  });
});

describe("connexion par email et mot de passe", () => {
  test("email normalisé, mauvais mot de passe refusé, compte inconnu refusé de la même façon", async () => {
    const { alice, p1 } = await setup();
    const i = await invite(alice, p1);
    await activate(i.token);
    const ok = await passwordLogin("  Alice@ACME.exemple.test ", true);
    expect(ok.status).toBe("ok");
    expect((await portal<{ person: { id: string } }>(db, "portal_me", ok.session)).person.id).toBe(alice);
    expect((await passwordLogin("alice@acme.exemple.test", false)).status).toBe("invalid");
    const unknown = await passwordLogin("personne@exemple.test", true);
    expect(unknown.status).toBe("invalid");
    expect(unknown.challenge).toEqual({ status: "unknown" });
  });

  test("limitation : 8 échecs par compte en 15 minutes, même depuis plusieurs adresses", async () => {
    const { alice, p1 } = await setup();
    await activate((await invite(alice, p1)).token);
    for (let k = 0; k < 8; k++) expect((await passwordLogin("alice@acme.exemple.test", false, `10.0.0.${k}`)).status).toBe("invalid");
    expect((await passwordLogin("alice@acme.exemple.test", true, "10.0.1.1")).status).toBe("rate_limited");
  });

  test("révocation : connexion refusée et sessions fermées", async () => {
    const { alice, p1 } = await setup();
    const a = await activate((await invite(alice, p1)).token);
    await db.as("owner");
    await db.rpc("portal_access_revoke", { p_person: alice });
    await expect(portal(db, "portal_me", a.session)).rejects.toThrow(/Session expirée/);
    expect((await passwordLogin("alice@acme.exemple.test", true)).status).toBe("invalid");
  });

  test("mot de passe oublié : réponse identique, demande notée seulement pour un email autorisé, lien de réinitialisation", async () => {
    const { alice, p1 } = await setup();
    const first = await activate((await invite(alice, p1)).token);
    await db.as("anon");
    const r1 = await db.rpc("portal_reset_request", { p_server_key: SERVER_KEY, p_email: "ALICE@acme.exemple.test", p_ip_hash: sha("3.3.3.3") });
    const r2 = await db.rpc("portal_reset_request", { p_server_key: SERVER_KEY, p_email: "inconnu@exemple.test", p_ip_hash: sha("3.3.3.3") });
    expect(r1).toEqual(r2);
    await db.as("owner");
    expect((await db.one<{ r: string | null }>(`select reset_requested_at r from portal_accesses where person_id = $1`, [alice])).r).not.toBeNull();
    const reset = await invite(alice, p1, { kind: "reset" });
    expect(await check(reset.token)).toMatchObject({ status: "ok", kind: "reset" });
    const after = await activate(reset.token, PW2);
    expect(after.status).toBe("ok");
    // l'ancienne session est fermée, la demande est soldée
    await expect(portal(db, "portal_me", first.session)).rejects.toThrow(/Session expirée/);
    await db.as("owner");
    expect((await db.one<{ r: string | null }>(`select reset_requested_at r from portal_accesses where person_id = $1`, [alice])).r).toBeNull();
    // un lien d'invitation ne sert pas de réinitialisation, et inversement
    await expect(invite(alice, p1, { kind: "invitation" })).rejects.toThrow(/déjà un compte/);
  });

  test("mot de passe oublié : 5 demandes par heure et par adresse", async () => {
    await db.as("anon");
    for (let k = 0; k < 5; k++) expect(await db.rpc("portal_reset_request", { p_server_key: SERVER_KEY, p_email: "x@exemple.test", p_ip_hash: sha("4.4.4.4") })).toEqual({ status: "ok" });
    expect(await db.rpc("portal_reset_request", { p_server_key: SERVER_KEY, p_email: "x@exemple.test", p_ip_hash: sha("4.4.4.4") })).toEqual({ status: "rate_limited" });
  });
});

describe("anciens codes d'accès", () => {
  test("le code reste valable jusqu'à l'activation par invitation, puis cesse", async () => {
    const { alice, p1 } = await setup();
    const legacy = await login(db, alice);
    expect(legacy.status).toBe("ok");
    const i = await invite(alice, p1);
    // l'invitation ne touche pas au code tant qu'elle n'est pas utilisée
    expect((await portal<{ person: { id: string } }>(db, "portal_me", legacy.session)).person.id).toBe(alice);
    await activate(i.token);
    await expect(portal(db, "portal_me", legacy.session)).rejects.toThrow(/Session expirée/);
    await db.as("anon");
    expect((await db.rpc<{ status: string }>("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(legacy.code), p_ip_hash: sha("5.5.5.5"), p_session_hash: sha(randomUUID()), p_user_agent: null })).status).toBe("invalid");
  });

  test("après révocation, une nouvelle invitation ne ranime ni l'ancien code ni l'ancien mot de passe", async () => {
    const { alice, p1 } = await setup();
    const legacy = await login(db, alice);
    await db.as("owner");
    await db.rpc("portal_access_revoke", { p_person: alice });
    await invite(alice, p1);
    await db.as("anon");
    expect((await db.rpc<{ status: string }>("portal_login", { p_server_key: SERVER_KEY, p_code_hash: sha(legacy.code), p_ip_hash: sha("6.6.6.6"), p_session_hash: sha(randomUUID()), p_user_agent: null })).status).toBe("invalid");
  });
});
