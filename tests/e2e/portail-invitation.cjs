// Recette navigateur : invitation au portail par mail, création du mot de passe, connexion, mot de passe oublié,
// renvoi, ancien code. Environnement de TEST local uniquement, contacts et adresses fictifs ; Gmail est simulé
// (tests/e2e/fake-gmail.cjs), tout le reste est réel (CRM, sendMail, base, portail).
// Usage : voir l'en-tête de la pull request (lancement de la base de test et de Next avec les variables de recette).
const { chromium } = require("playwright");
const { createHmac } = require("node:crypto");
const { readdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { context, sql } = require("../../scripts/test-env/browser.cjs");

const APP = "http://localhost:3000";
const OUT = process.env.FAKE_GMAIL_DIR;
const SECRET = process.env.APPOINTMENTS_SECRET;
const SHOTS = process.env.SHOTS ?? "/tmp";
if (!OUT || !SECRET) throw new Error("FAKE_GMAIL_DIR et APPOINTMENTS_SECRET (ceux du serveur de test) sont requis.");
const derive = (label) => createHmac("sha256", SECRET).update(`cely-appointments:${label}`).digest();
const hmac = (label, v) => createHmac("sha256", derive(label)).update(v).digest("hex");
const one = async (q, p) => (await sql(q, p))[0];
const log = (...a) => console.log(...a);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); log(`${ok ? "OK " : "KO "} ${name}${detail ? ` — ${detail}` : ""}`); };

/** Dernier message « envoyé » : destinataire et lien d'activation (parties base64 décodées). */
function lastMail() {
  const files = readdirSync(OUT).filter((f) => f.endsWith(".eml")).sort();
  const raw = readFileSync(join(OUT, files.at(-1)), "utf8");
  const decoded = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+)/g)].map((m) => Buffer.from(m[1].replace(/\s/g, ""), "base64").toString("utf8")).join("\n");
  return { count: files.length, to: /^To: (.*)$/m.exec(raw)?.[1]?.trim(), link: /https?:\/\/[^\s"<>]+\/portail\/activer#[A-Za-z0-9_-]+/.exec(decoded)?.[0], text: decoded };
}
const outbox = () => readdirSync(OUT).filter((f) => f.endsWith(".eml")).length;

async function sendFromPreview(p, buttonName, { dbl = false } = {}) {
  await p.getByRole("button", { name: buttonName }).first().click();
  await p.locator("[data-invitation-preview]").waitFor();
  const send = p.getByRole("button", { name: "Envoyer", exact: true });
  if (dbl) await send.dblclick(); else await send.click();
}

(async () => {
  // --- données fictives -------------------------------------------------------------------------
  await sql(`update appt_settings set server_key_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`, [derive("rpc").toString("base64url")]);
  const acct = (await one(`insert into mail_accounts (email, display_name, is_default, scopes, signature) values ('test-owner@example.test', 'Cely Test', true, '{https://www.googleapis.com/auth/gmail.send}', 'Équipe Cely (test)') on conflict do nothing returning id`))?.id
    ?? (await one(`select id from mail_accounts where email = 'test-owner@example.test'`)).id;
  const { createCipheriv, randomBytes } = require("node:crypto");
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", Buffer.from(process.env.MAIL_TOKEN_KEY, "base64"), iv);
  const data = Buffer.concat([c.update("rafraichissement-simule", "utf8"), c.final()]);
  await sql(`insert into mail_account_secrets (account_id, refresh_token_enc) values ($1, $2) on conflict (account_id) do update set refresh_token_enc = excluded.refresh_token_enc, access_token_enc = null`,
    [acct, `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${data.toString("base64url")}`]);
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const claire = (await one(`select id from people where email = 'claire@studio.example.test'`)).id;
  const marc = (await one(`select id from people where email = 'marc@studio.example.test'`)).id;
  const sansMail = (await one(`insert into people (company_id, first_name, last_name) values ($1, 'Sans', 'Email') returning id`, [studio])).id;
  const pid = (await one(`insert into projects (company_id, name, status, portal_published) values ($1, '[TEST] Portail invitation', 'en_cours', true) returning id`, [studio])).id;
  await sql(`insert into project_members (project_id, person_id) values ($1, $2), ($1, $3), ($1, $4)`, [pid, claire, marc, sansMail]);
  // Marc : ancien code d'accès (contact existant avant l'invitation)
  const MARC_CODE = "ABCD0EFGH1JKMN2PQRS3";
  await sql(`insert into portal_accesses (person_id, code_hash, code_hint) values ($1, $2, 'RS3')`, [marc, hmac("portal-code", MARC_CODE)]);
  for (const f of readdirSync(OUT)) rmSync(join(OUT, f));

  const b = await chromium.launch();
  const errors = [];
  const owner = await (await context(b, "owner")).newPage();
  owner.on("pageerror", (e) => errors.push(e.message)); owner.on("dialog", (d) => d.accept());
  const row = (name) => owner.locator("li", { hasText: name });

  // --- 1. Créer un accès → Prévisualisation → Envoyer -------------------------------------------------
  await owner.goto(`${APP}/projets/${pid}/acces`, { waitUntil: "networkidle" });
  check("aucun code affiché à l'écran", !(await owner.locator("body").innerText()).match(/Générer|Régénérer|Copier un message/));
  const noMail = row("Sans Email").getByRole("button", { name: /Prévisualisation du mail/ });
  check("contact sans email : bouton désactivé avec la raison", (await noMail.isDisabled()) && (await row("Sans Email").innerText()).includes("Pas d'email"));
  await row("Claire").getByRole("button", { name: /Prévisualisation du mail/ }).click();
  await owner.locator("[data-invitation-preview]").waitFor();
  const head = (await owner.locator("dl").innerText()).replace(/\s+/g, " ");
  check("aperçu : destinataire, expéditeur, objet", head.includes("claire@studio.example.test") && head.includes("Cely Test <test-owner@example.test>") && head.includes("[TEST] Portail invitation"), head);
  const frame = await owner.frameLocator("[data-invitation-preview]").locator("body").innerText();
  check("aperçu : bouton d'activation, lien factice", frame.includes("Créer mon accès") && (await owner.frameLocator("[data-invitation-preview]").locator("a").getAttribute("href")).includes("exemple-de-lien"));
  await owner.screenshot({ path: `${SHOTS}/portail-invitation-apercu.png` });
  // échec d'envoi : rien n'est présenté comme envoyé, invitation invalidée, nouvel essai possible
  writeFileSync(join(OUT, "fail"), "");
  await owner.getByRole("button", { name: "Envoyer", exact: true }).click();
  await owner.locator("p[role=alert]").waitFor();
  const alert = await owner.locator("p[role=alert]").innerText();
  const failed = await one(`select invalidated_reason r from portal_invitations where person_id = $1 order by created_at desc limit 1`, [claire]);
  check("échec d'envoi : message clair, invitation invalidée", alert.includes("n'a pas pu être envoyée") && failed.r === "send_failed", alert.slice(0, 120));
  rmSync(join(OUT, "fail"));
  // nouvel essai, double clic : une seule invitation, un seul mail
  const before = outbox();
  await owner.getByRole("button", { name: "Envoyer", exact: true }).dblclick();
  await owner.locator("[data-sonner-toast]").first().waitFor();
  await owner.waitForTimeout(800);
  const live = await one(`select count(*)::int n from portal_invitations where person_id = $1 and invalidated_at is null`, [claire]);
  check("double clic sur Envoyer : un seul mail, une seule invitation", outbox() - before === 1 && live.n === 1, `mails ${outbox() - before}, invitations ${live.n}`);
  await owner.reload({ waitUntil: "networkidle" });
  check("état « Invitation envoyée le … » + Renvoyer", /Invitation envoyée le/.test(await row("Claire").innerText()) && (await row("Claire").getByRole("button", { name: /Renvoyer l'invitation/ }).count()) === 1);
  const mail = lastMail();
  check("mail : destinataire autorisé, lien réel, aucun mot de passe ni code", mail.to === "claire@studio.example.test" && !!mail.link && !/code d'accès|mot de passe :/i.test(mail.text));

  // --- 2. Lien → identifiant verrouillé → mot de passe → portail (avec une autre session ouverte) ----------
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: "fr-FR" });
  const c1 = await ctx.newPage(); c1.on("pageerror", (e) => errors.push(e.message));
  // Marc est déjà connecté dans ce navigateur avec son ancien code
  await c1.goto(`${APP}/portail`, { waitUntil: "networkidle" });
  await c1.getByRole("button", { name: /J'ai reçu un code d'accès/ }).click();
  await c1.getByLabel("Code d'accès").fill(MARC_CODE);
  await c1.getByRole("button", { name: "Accéder à mon espace" }).click();
  await c1.waitForURL(/\/portail\/p\//);
  check("ancien code : toujours valable avant activation", true);
  await c1.goto(mail.link, { waitUntil: "networkidle" });
  const id = c1.getByLabel("Identifiant");
  await id.waitFor();
  check("identifiant prérempli et verrouillé, lien effacé de la barre d'adresse",
    (await id.inputValue()) === "claire@studio.example.test" && (await id.getAttribute("readonly")) !== null && !c1.url().includes("#"));
  check("règles affichées avant la saisie", (await c1.locator("#regles").innerText()).includes("12 caractères"));
  await c1.screenshot({ path: `${SHOTS}/portail-invitation-creer.png` });
  await c1.getByLabel("Mot de passe", { exact: true }).fill("court");
  await c1.getByLabel("Confirmer le mot de passe").fill("court");
  await c1.getByRole("button", { name: "Créer mon accès" }).click();
  check("mot de passe trop faible refusé", (await c1.locator("p[role=alert]").innerText()).includes("12 caractères"));
  const PW = "Mot-de-passe fictif 2026";
  await c1.getByLabel("Mot de passe", { exact: true }).fill(PW);
  await c1.getByLabel("Confirmer le mot de passe").fill(PW);
  await c1.getByRole("button", { name: "Créer mon accès" }).dblclick();
  await c1.waitForURL(/\/portail\/p\//); // un seul projet : le portail ouvre directement le projet
  await c1.waitForLoadState("networkidle");
  const me = await c1.locator("body").innerText();
  check("arrivée sur le portail de Claire, pas de mélange avec Marc", me.includes("[TEST] Portail invitation") && !me.includes("Marc"));
  const marcSessions = await one(`select count(*)::int n from portal_sessions s join portal_accesses a on a.id = s.access_id where a.person_id = $1 and s.revoked_at is null`, [marc]);
  check("la session de Marc dans ce navigateur est fermée", marcSessions.n === 0);
  const acc = await one(`select (activated_at is not null) a, (select count(*)::int from portal_sessions s where s.access_id = portal_accesses.id and s.revoked_at is null) s from portal_accesses where person_id = $1`, [claire]);
  check("double soumission : un compte, une session", acc.a && acc.s === 1, JSON.stringify(acc));
  await c1.goto(mail.link, { waitUntil: "networkidle" });
  check("lien déjà utilisé : message clair", (await c1.locator("main").innerText()).includes("Contactez votre interlocuteur"));

  // --- 3. Déconnexion, reconnexion, mot de passe oublié ---------------------------------------------
  await c1.goto(`${APP}/portail`, { waitUntil: "networkidle" });
  await c1.getByRole("button", { name: /Déconnexion/ }).click();
  await c1.getByLabel("Email").waitFor();
  await c1.getByLabel("Email").fill(" Claire@Studio.example.test ");
  await c1.getByLabel("Mot de passe").fill("mauvais mot de passe 1");
  await c1.getByRole("button", { name: "Accéder à mon espace" }).click();
  check("mauvais mot de passe refusé", (await c1.locator("p[role=alert]").innerText()).includes("incorrect"));
  await c1.getByLabel("Mot de passe").fill(PW);
  await c1.getByRole("button", { name: "Accéder à mon espace" }).click();
  await c1.waitForURL(/\/portail\/p\//);
  check("reconnexion email (casse et espaces ignorés) + mot de passe", true);
  await c1.getByRole("button", { name: /Déconnexion/ }).click();
  await c1.getByRole("button", { name: /Mot de passe oublié/ }).click();
  await c1.getByLabel("Email").fill("inconnu@exemple.test");
  await c1.getByRole("button", { name: "Envoyer la demande" }).click();
  const unknownMsg = await c1.locator("p[role=status]").innerText();
  await c1.getByLabel("Email").fill("claire@studio.example.test");
  await c1.getByRole("button", { name: "Envoyer la demande" }).click();
  await c1.waitForTimeout(500);
  const knownMsg = await c1.locator("p[role=status]").innerText();
  check("mot de passe oublié : message identique", unknownMsg === knownMsg, knownMsg.slice(0, 80));
  await owner.reload({ waitUntil: "networkidle" });
  check("CRM : demande visible", (await row("Claire").innerText()).includes("Mot de passe oublié demandé"));
  await sendFromPreview(owner, /Envoyer le lien de réinitialisation/);
  await owner.locator("[data-sonner-toast]").first().waitFor();
  const reset = lastMail();
  await c1.goto(reset.link, { waitUntil: "networkidle" });
  await c1.getByLabel("Identifiant").waitFor();
  const PW2 = "Nouveau mot fictif 2027";
  await c1.getByLabel("Mot de passe", { exact: true }).fill(PW2);
  await c1.getByLabel("Confirmer le mot de passe").fill(PW2);
  await c1.getByRole("button", { name: /Enregistrer mon mot de passe/ }).click();
  await c1.waitForURL(/\/portail(\/p\/.*)?$/);
  check("réinitialisation : nouveau mot de passe, connecté", !(await c1.locator("body").innerText()).includes("Lien non valable"));

  // --- 4. Renvoi : l'ancien lien est refusé ; 5. Ancien code : cesse après activation --------------------
  await owner.reload({ waitUntil: "networkidle" });
  check("Marc : « Ancien code d'accès » + Envoyer l'invitation", (await row("Marc").innerText()).includes("Ancien code") && (await row("Marc").getByRole("button", { name: /Envoyer l'invitation/ }).count()) === 1);
  await sendFromPreview(owner, /Envoyer l'invitation/);
  await owner.locator("[data-sonner-toast]").first().waitFor();
  const first = lastMail();
  await owner.reload({ waitUntil: "networkidle" });
  await row("Marc").getByRole("button", { name: /Renvoyer l'invitation/ }).click();
  await owner.locator("[data-invitation-preview]").waitFor();
  await owner.getByRole("button", { name: "Envoyer", exact: true }).click();
  await owner.locator("[data-sonner-toast]").nth(0).waitFor();
  await owner.waitForTimeout(500);
  const second = lastMail();
  const ctx2 = await b.newContext({ locale: "fr-FR" });
  const m1 = await ctx2.newPage();
  await m1.goto(first.link, { waitUntil: "networkidle" });
  check("renvoi : l'ancien lien est refusé", second.link !== first.link && (await m1.locator("main").innerText()).includes("Lien non valable"));
  await m1.screenshot({ path: `${SHOTS}/portail-invitation-lien-refuse.png` });
  await m1.goto(`${APP}/portail`, { waitUntil: "networkidle" });
  await m1.getByRole("button", { name: /J'ai reçu un code d'accès/ }).click();
  await m1.getByLabel("Code d'accès").fill(MARC_CODE);
  await m1.getByRole("button", { name: "Accéder à mon espace" }).click();
  await m1.waitForURL(/\/portail\/p\//);
  check("Marc : code encore valable tant que le compte n'est pas activé", true);
  await m1.goto(second.link, { waitUntil: "networkidle" });
  await m1.getByLabel("Identifiant").waitFor();
  await m1.getByLabel("Mot de passe", { exact: true }).fill("Marc fictif mot 2026");
  await m1.getByLabel("Confirmer le mot de passe").fill("Marc fictif mot 2026");
  await m1.getByRole("button", { name: "Créer mon accès" }).click();
  await m1.waitForURL(/\/portail(\/p\/.*)?$/);
  await m1.getByRole("button", { name: /Déconnexion/ }).click();
  await m1.getByRole("button", { name: /J'ai reçu un code d'accès/ }).click();
  await m1.getByLabel("Code d'accès").fill(MARC_CODE);
  await m1.getByRole("button", { name: "Accéder à mon espace" }).click();
  check("Marc : code refusé après activation", (await m1.locator("p[role=alert]").innerText()).length > 0);
  await owner.reload({ waitUntil: "networkidle" });
  check("CRM : « Compte activé le … » pour Marc", /Compte activé le/.test(await row("Marc").innerText()));
  await owner.screenshot({ path: `${SHOTS}/portail-invitation-etats.png`, fullPage: true });

  // révocation : invitation en attente invalidée (nouvelle invitation pour un contact révoqué)
  await row("Marc").getByRole("button", { name: /Révoquer/ }).click();
  await owner.waitForTimeout(800);
  await owner.reload({ waitUntil: "networkidle" });
  check("révocation : état « Révoqué »", (await row("Marc").innerText()).includes("Révoqué"));
  check("erreurs console", errors.length === 0, errors.join(" | ").slice(0, 200));
  await b.close();
  const ko = results.filter((r) => !r.ok);
  log(`\n${results.length - ko.length}/${results.length} vérifications réussies`);
  if (ko.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
