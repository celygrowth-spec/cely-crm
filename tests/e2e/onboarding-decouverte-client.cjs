// Recette navigateur de l'onboarding de l'offre découverte, données fictives uniquement ([TEST], example.test).
// Prérequis : environnement de test lancé avec APPOINTMENTS_SECRET connu (voir docs/onboarding-offre-decouverte.md).
// Usage : APPOINTMENTS_SECRET=… SHOTS=dossier node tests/e2e/onboarding-decouverte-client.cjs
// Parcours : cocher l'offre, préparer les cibles, onboarding complet sur ordinateur (interruption et reprise,
// coupure réseau pendant l'envoi d'une archive), double clic sur l'envoi, puis mobile, modification après envoi,
// conflit entre deux contacts, résultat dans le projet, la fiche et Aujourd'hui, case décochée.
const { chromium, devices } = require("playwright");
const { createHash, createHmac, randomBytes } = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { context, sql } = require("../../scripts/test-env/browser.cjs");

const APP = "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
const SECRET = process.env.APPOINTMENTS_SECRET;
if (!SECRET) throw new Error("APPOINTMENTS_SECRET (celui de l'application de test) est requis");
const derive = (label) => createHmac("sha256", SECRET).update(`cely-appointments:${label}`).digest();
const hmac = (label, v) => createHmac("sha256", derive(label)).update(v).digest("hex");
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
const shot = (p, name) => p.screenshot({ path: join(SHOTS, name), fullPage: false });

async function portalLogin(ctx, code) {
  const p = await ctx.newPage();
  await p.goto(`${APP}/portail`, { waitUntil: "domcontentloaded" });
  const r = await p.evaluate(async (c) => (await fetch("/api/portail/connexion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) })).status, code);
  if (r !== 200) throw new Error(`connexion portail : ${r}`);
  return p;
}
const screenId = (p) => p.locator("[data-discovery-flow]").getAttribute("data-screen");

(async () => {
  const dir = join(SHOTS, "fichiers-fictifs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "blacklist-test.csv"), "email,entreprise\nclient1@example.test,[TEST] Client 1\nprospect2@example.test,[TEST] Prospect 2\n");
  writeFileSync(join(dir, "Basic_LinkedInDataExport_TEST.zip"), randomBytes(20 * 1024 * 1024)); // 20 Mo : 4 morceaux TUS

  // --- données : clé serveur du portail, projet, contacts et codes d'accès ---
  await sql(`update appt_settings set server_key_hash = $1`, [createHash("sha256").update(derive("rpc").toString("base64url")).digest("hex")]);
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const claire = (await one(`select id from people where email = 'claire@studio.example.test'`)).id;
  const marc = (await one(`select id from people where email = 'marc@studio.example.test'`)).id;
  const pid = (await one(`insert into projects (company_id, name, status, portal_published) values ($1, '[TEST] Test 28 jours', 'en_cours', true) returning id`, [studio])).id;
  await sql(`insert into project_members (project_id, person_id) values ($1, $2), ($1, $3)`, [pid, claire, marc]);
  const codes = { claire: "CLA1RE00000000000001", marc: "MARC0000000000000002" };
  await sql(`delete from portal_accesses where person_id in ($1, $2)`, [claire, marc]);
  await sql(`insert into portal_accesses (person_id, code_hash, code_hint) values ($1, $2, '0001'), ($3, $4, '0002')`, [claire, hmac("portal-code", codes.claire.replace(/O/g, "0").replace(/[IL]/g, "1")), marc, hmac("portal-code", codes.marc)]);
  log("projet :", pid);

  const b = await chromium.launch(); const errors = [];
  const watch = (p, who) => { p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); p.on("dialog", (d) => d.accept()); return p; };

  // 1. Propriétaire : cocher l'offre, préparer deux cibles (la troisième reste vide)
  const owner = await context(b, "owner");
  const op = watch(await owner.newPage(), "owner");
  await op.goto(`${APP}/projets/${pid}`, { waitUntil: "networkidle" });
  await op.locator("[data-discovery-checkbox]").click();
  await op.locator("[data-discovery-button]").waitFor({ timeout: 15000 });
  await op.goto(`${APP}/projets/${pid}/onboarding-decouverte`, { waitUntil: "networkidle" });
  const t1 = op.locator('[data-target="1"]');
  await t1.getByPlaceholder("Ex. : DAF d'ETI industrielles").fill("[TEST] DAF d'ETI industrielles");
  await t1.getByPlaceholder("Ex. : industrie, agroalimentaire").fill("Industrie");
  await t1.getByPlaceholder("Ex. : DAF, contrôleur de gestion").fill("DAF, RAF");
  await t1.locator("[data-target-save]").click(); await op.waitForTimeout(700);
  const t2 = op.locator('[data-target="2"]');
  await t2.getByPlaceholder("Ex. : DAF d'ETI industrielles").fill("[TEST] Cabinets comptables");
  await t2.getByPlaceholder("Ex. : France, Belgique").fill("Île-de-France");
  await t2.locator("[data-target-save]").click(); await op.waitForTimeout(700);
  await op.locator("#lemlist-invite").fill("celien@example.test");
  const saveSetting = op.locator("[data-discovery-settings]").getByRole("button", { name: "Enregistrer" });
  if (await saveSetting.isEnabled()) { await saveSetting.click(); await op.waitForTimeout(600); }
  log("1. offre cochée, cibles :", JSON.stringify(await sql(`select position, name from discovery_targets where project_id = $1 order by position`, [pid])));

  // 2. Claire, ordinateur : onglet Onboarding, accueil
  const cctx = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: "fr-FR", timezoneId: "Europe/Paris" });
  let cp = watch(await portalLogin(cctx, codes.claire), "claire");
  await cp.goto(`${APP}/portail/p/${pid}`, { waitUntil: "networkidle" });
  log("2. onglet Onboarding visible :", await cp.getByRole("link", { name: "Onboarding" }).count() > 0);
  await cp.getByRole("link", { name: "Onboarding" }).first().click();
  await cp.locator("[data-discovery-flow]").waitFor();
  await cp.waitForTimeout(500);
  await shot(cp, "client-1-accueil.png");
  await cp.keyboard.press("Enter"); // « C'est parti » avec Entrée
  await cp.locator('[data-question="offer_pitch"]').waitFor();
  const answers = [
    "[TEST] On aide les PME industrielles à réduire leurs arrêts machine.",
    "[TEST] Des pannes imprévues qui bloquent la production.",
    "[TEST] -30 % d'arrêts en 6 mois.",
  ];
  for (const a of answers) {
    await cp.locator("[data-question] input, [data-question] textarea").first().fill(a);
    await cp.keyboard.press("Enter");
    await cp.waitForTimeout(350);
  }
  await shot(cp, "client-2-question.png");
  await cp.waitForTimeout(700); // la position est enregistrée 300 ms après l'affichage
  log("   écran avant interruption :", await screenId(cp), "· réponses en base :", (await one(`select count(*)::int n from discovery_answers where project_id = $1`, [pid])).n);

  // 3. Interruption : on ferme l'onglet au milieu d'une saisie (brouillon local), puis reprise
  await cp.locator("[data-question] textarea").fill("[TEST] Brouillon tapé juste avant la coupure");
  await cp.close();
  cp = watch(await cctx.newPage(), "claire");
  await cp.goto(`${APP}/portail/p/${pid}/onboarding`, { waitUntil: "networkidle" });
  log("3. reprise sur :", await screenId(cp), "· brouillon retrouvé :", await cp.locator("[data-question] textarea").inputValue());
  for (const a of ["[TEST] Un DAF d'ETI agroalimentaire, choisi pour notre réactivité.", "[TEST] Concurrent X ; nous, on s'engage sur les résultats.", "", "[TEST] Ne jamais promettre de délai ; pas de tutoiement."]) {
    await cp.locator("[data-question] input, [data-question] textarea").first().fill(a);
    await cp.keyboard.press("Enter");
    await cp.waitForTimeout(400);
  }
  log("   après les questions :", await screenId(cp), "· réponses :", (await one(`select count(*)::int n from discovery_answers where project_id = $1`, [pid])).n);

  // 4. lemlist
  await shot(cp, "client-3-lemlist.png");
  log("4. adresse affichée :", await cp.locator("[data-invite-email]").innerText().catch(() => "(réglage vide)"));
  await cp.locator("[data-lemlist-done]").click(); await cp.waitForTimeout(500);

  // 5. Blacklist (CSV fictif)
  await cp.locator('[data-upload="blacklist"] [data-upload-input]').setInputFiles(join(dir, "blacklist-test.csv"));
  await cp.locator('[data-upload="blacklist"] [data-upload-files] li').first().waitFor({ timeout: 20000 });
  await cp.locator("[data-continue]").click(); await cp.waitForTimeout(500);
  log("5. blacklist reçue ; écran :", await screenId(cp));

  // 6. LinkedIn : 20 Mo en envoi reprenable, avec une coupure simulée sur le 2e morceau
  await cp.locator("#li-0").fill("[TEST] Claire Test");
  await fetch("http://127.0.0.1:54321/debug/tus-fail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patches: 0 }) });
  const upload = cp.locator('[data-linkedin-account="0"] [data-upload-input]').setInputFiles(join(dir, "Basic_LinkedInDataExport_TEST.zip"));
  await upload;
  await cp.waitForFunction(() => { const b = document.querySelector('[role="progressbar"][aria-label^="Envoi"]'); return b && Number(b.getAttribute("aria-valuenow")) >= 25; }, null, { timeout: 30000 });
  await fetch("http://127.0.0.1:54321/debug/tus-fail", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patches: 2 }) });
  await cp.locator('[data-upload-job="retrying"]').waitFor({ timeout: 20000 });
  await shot(cp, "client-4-coupure.png");
  log("6. coupure visible :", (await cp.locator('[data-upload-job="retrying"]').innerText()).replace(/\s+/g, " "));
  await cp.locator("[data-upload-files] li").first().waitFor({ timeout: 90000 });
  log("   archive reçue après reprise :", JSON.stringify(await one(`select f.status, f.size_bytes::int as size from discovery_files d join company_files f on f.id = d.file_id where d.project_id = $1 and d.step = 'linkedin'`, [pid])));
  await cp.locator("[data-continue]").click(); await cp.waitForTimeout(500);

  // 7. Autres documents : rien à ajouter
  await cp.locator("[data-none]").click(); await cp.waitForTimeout(500);

  // 8. Cibles : valider la 1, commenter la 2, compléter puis valider la 3
  await shot(cp, "client-5-cible.png");
  await cp.locator("[data-validate]").click(); await cp.waitForTimeout(400);
  await cp.locator("[data-next-target]").click(); await cp.waitForTimeout(400);
  await cp.locator("[data-comment]").click();
  await cp.locator("textarea#c-2").fill("[TEST] Plutôt les cabinets de plus de 20 personnes.");
  await cp.locator("[data-comment-send]").click(); await cp.waitForTimeout(500);
  await cp.locator("[data-next-target]").click(); await cp.waitForTimeout(400);
  await cp.locator("#t-3-name").fill("[TEST] Agences de recrutement");
  await cp.locator("#t-3-name").press("Enter"); await cp.waitForTimeout(500);
  await cp.locator("[data-validate]").click(); await cp.waitForTimeout(400);
  await cp.locator("[data-next-target]").click(); await cp.waitForTimeout(500);
  log("8. écran :", await screenId(cp), "· cibles :", JSON.stringify(await sql(`select position, name, validated_at is not null as validee, client_filled from discovery_targets where project_id = $1 order by position`, [pid])));

  // 9. Récapitulatif et double clic sur « Envoyer à Célien »
  await shot(cp, "client-6-recap.png");
  await cp.locator("[data-send]").dblclick();
  if (await cp.locator("[data-missing]").count()) await cp.locator("[data-send]").dblclick();
  await cp.locator("[data-sent]").waitFor({ timeout: 15000 });
  await cp.waitForTimeout(600);
  await shot(cp, "client-7-envoye.png");
  log("9. envoyé ; actions « reçu » :", (await one(`select count(*)::int n from project_tasks where project_id = $1 and title = 'Onboarding reçu, à traiter'`, [pid])).n);

  // 10. Marc, mobile : arrive sur l'écran « envoyé », modifie une réponse ; conflit avec Claire
  const mctx = await b.newContext({ ...devices["iPhone 13"], locale: "fr-FR", timezoneId: "Europe/Paris" });
  const mp = watch(await portalLogin(mctx, codes.marc), "marc");
  await mp.goto(`${APP}/portail/p/${pid}/onboarding`, { waitUntil: "networkidle" });
  log("10. Marc (mobile) arrive sur :", await screenId(mp));
  await shot(mp, "mobile-1-envoye.png");
  // Claire ouvre la question 1 (révision lue), Marc la modifie avant elle
  await cp.goto(`${APP}/portail/p/${pid}/onboarding`, { waitUntil: "networkidle" });
  await cp.locator("[data-review]").click(); await cp.waitForTimeout(300);
  await cp.locator('[data-recap="offer:0"] button', { hasText: "Corriger" }).click();
  await cp.locator('[data-question="offer_pitch"]').waitFor();
  await mp.locator("[data-review]").click(); await mp.waitForTimeout(300);
  await mp.locator('[data-recap="offer:0"] button', { hasText: "Corriger" }).click();
  await mp.locator('[data-question="offer_pitch"] input').fill("[TEST] Version de Marc : maintenance prédictive pour PME.");
  await mp.locator("[data-ok]").click(); await mp.waitForTimeout(600);
  await shot(mp, "mobile-2-question.png");
  await cp.locator('[data-question="offer_pitch"] input').fill("[TEST] Version de Claire, écrite en même temps.");
  await cp.keyboard.press("Enter");
  await cp.locator("[data-conflict]").waitFor({ timeout: 10000 });
  await shot(cp, "client-8-conflit.png");
  log("    conflit montré à Claire :", (await cp.locator("[data-conflict]").innerText()).replace(/\s+/g, " ").slice(0, 160));
  await cp.locator("[data-keep-mine]").click(); await cp.waitForTimeout(600);
  log("    réponse finale :", (await one(`select value, rev from discovery_answers where project_id = $1 and key = 'offer_pitch'`, [pid])).value);

  // 11. Mobile : accueil et une cible, via l'aperçu propriétaire (même rendu)
  const omob = await context(b, "owner", { ...devices["iPhone 13"] });
  const opm = watch(await omob.newPage(), "owner-mobile");
  await opm.goto(`${APP}/projets/${pid}/onboarding-decouverte/apercu`, { waitUntil: "networkidle" });
  await opm.waitForTimeout(500);
  await shot(opm, "mobile-3-accueil-apercu.png");

  // 12. Résultat côté CRM : panneau, fiche, Aujourd'hui
  await op.goto(`${APP}/projets/${pid}/onboarding-decouverte`, { waitUntil: "networkidle" });
  log("12. panneau : état", await op.locator("[data-discovery-state]").innerText(), "· modifié après envoi :", await op.locator("[data-discovery-changed]").count() > 0,
    "· changements :", await op.locator("[data-discovery-changes] li").count());
  await op.screenshot({ path: join(SHOTS, "crm-3-panneau-recu.png"), fullPage: true });
  await op.goto(`${APP}/`, { waitUntil: "networkidle" });
  log("    Aujourd'hui :", (await op.locator("[data-home-tasks]").innerText()).replace(/\s+/g, " ").slice(0, 400));
  await op.locator("[data-home-tasks]").screenshot({ path: join(SHOTS, "crm-4-aujourdhui.png") }).catch(() => undefined);
  log("    fiche (documents) :", JSON.stringify(await sql(`select display_name, status from company_files where company_id = $1 and uploaded_by_kind = 'client' order by created_at`, [studio])));
  log("    historique de la fiche :", JSON.stringify(await sql(`select content from interactions where company_id = $1 and content like 'Onboarding%'`, [studio])));

  // 13. Décocher : l'onglet disparaît, la page répond « introuvable », les données restent
  await op.goto(`${APP}/projets/${pid}`, { waitUntil: "networkidle" });
  await op.locator("[data-discovery-checkbox]").click(); await op.waitForTimeout(1200);
  await cp.goto(`${APP}/portail/p/${pid}`, { waitUntil: "networkidle" });
  const r404 = await cp.goto(`${APP}/portail/p/${pid}/onboarding`);
  log("13. décochée : onglet", await cp.getByRole("link", { name: "Onboarding" }).count(), "· page", r404.status(), "· réponses conservées :", (await one(`select count(*)::int n from discovery_answers where project_id = $1`, [pid])).n);
  await op.locator("[data-discovery-checkbox]").click(); await op.waitForTimeout(800);

  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
