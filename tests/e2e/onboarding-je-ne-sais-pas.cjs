// Recette navigateur : « Je ne sais pas », lien du site (question 4), captures lemlist, double clic, rendu mobile,
// et ce que je vois ensuite côté CRM. Données fictives uniquement ([TEST], example.test).
// Prérequis : environnement de test lancé avec APPOINTMENTS_SECRET connu (voir docs/onboarding-offre-decouverte.md).
// Usage : APPOINTMENTS_SECRET=… SHOTS=dossier node tests/e2e/onboarding-je-ne-sais-pas.cjs
const { chromium, devices } = require("playwright");
const { createHash, createHmac } = require("node:crypto");
const { join } = require("node:path");
const { context, sql } = require("../../scripts/test-env/browser.cjs");

const APP = "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
const SECRET = process.env.APPOINTMENTS_SECRET;
if (!SECRET) throw new Error("APPOINTMENTS_SECRET (celui de l'application de test) est requis");
const derive = (label) => createHmac("sha256", SECRET).update(`cely-appointments:${label}`).digest();
const hmac = (label, v) => createHmac("sha256", derive(label)).update(v).digest("hex");
const one = async (q, p) => (await sql(q, p))[0];
/** Capture. `full` : tout l'écran de l'onboarding (il défile dans son propre cadre : la fenêtre est agrandie le temps de la capture). */
async function shot(p, name, full = false) {
  const flow = p.locator("[data-discovery-flow]");
  if (!full || !(await flow.count())) return p.screenshot({ path: join(SHOTS, name), fullPage: full });
  const size = p.viewportSize();
  await p.setViewportSize({ width: size.width, height: Math.min(6000, await flow.evaluate((e) => e.scrollHeight)) });
  await p.waitForTimeout(300);
  await p.screenshot({ path: join(SHOTS, name) });
  await p.setViewportSize(size);
}
/** Les captures d'un tuto se chargent à l'approche : on les fait défiler une à une et on attend leur affichage. */
async function screenshotsLoaded(p) {
  const imgs = p.locator("[data-screenshot]");
  const n = await imgs.count();
  const ok = [];
  for (let i = 0; i < n; i++) {
    await imgs.nth(i).scrollIntoViewIfNeeded();
    ok.push(await imgs.nth(i).evaluate((e) => new Promise((res) => {
      const done = () => res(e.naturalWidth > 0);
      if (e.complete && e.naturalWidth > 0) return done();
      e.addEventListener("load", done, { once: true }); e.addEventListener("error", () => res(false), { once: true });
      setTimeout(() => res(e.complete && e.naturalWidth > 0), 20000);
    })));
  }
  await p.locator("[data-discovery-flow]").evaluate((e) => e.scrollTo(0, 0));
  return ok;
}
const failures = [];
const check = (label, ok, detail = "") => { console.log(`${ok ? "OK  " : "ÉCHEC"} ${label}${detail ? ` · ${detail}` : ""}`); if (!ok) failures.push(label); };

async function portalLogin(ctx, code) {
  const p = await ctx.newPage();
  await p.goto(`${APP}/portail`, { waitUntil: "domcontentloaded" });
  const r = await p.evaluate(async (c) => (await fetch("/api/portail/connexion", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) })).status, code);
  if (r !== 200) throw new Error(`connexion portail : ${r}`);
  return p;
}
const screenId = (p) => p.locator("[data-discovery-flow]").getAttribute("data-screen");
const onScreen = (p, id) => p.locator(`[data-discovery-flow][data-screen="${id}"]`).waitFor({ timeout: 10000 });
const answerRow = (pid, key) => one(`select value, unknown, rev from discovery_answers where project_id = $1 and key = $2`, [pid, key]);

(async () => {
  // --- client fictif SANS site sur sa fiche, un contact, un projet publié, un code d'accès ---
  await sql(`update appt_settings set server_key_hash = $1`, [createHash("sha256").update(derive("rpc").toString("base64url")).digest("hex")]);
  const tag = Date.now().toString(36);
  const cid = (await one(`insert into companies (name) values ($1) returning id`, [`[TEST] Atelier Nova ${tag}`])).id;
  const lea = (await one(`insert into people (company_id, first_name, last_name, email, is_primary) values ($1, 'Léa', 'Test', $2, true) returning id`, [cid, `lea-${tag}@atelier-nova.example.test`])).id;
  const pid = (await one(`insert into projects (company_id, name, status, portal_published) values ($1, '[TEST] Offre découverte Nova', 'en_cours', true) returning id`, [cid])).id;
  await sql(`insert into project_members (project_id, person_id) values ($1, $2)`, [pid, lea]);
  const code = `NOVA${tag.toUpperCase().replace(/[OIL]/g, "X").padEnd(16, "0").slice(0, 16)}`;
  await sql(`insert into portal_accesses (person_id, code_hash, code_hint) values ($1, $2, $3)`, [lea, hmac("portal-code", code.replace(/O/g, "0").replace(/[IL]/g, "1")), code.slice(-4)]);
  console.log("projet :", pid, "· fiche :", cid);

  const b = await chromium.launch(); const errors = [];
  const watch = (p, who) => { p.on("pageerror", (e) => errors.push(`${who}: ${e.message}`)); p.on("dialog", (d) => d.accept()); return p; };

  // 1. Propriétaire : cocher l'offre, adresse lemlist
  const owner = await context(b, "owner");
  const op = watch(await owner.newPage(), "owner");
  await op.goto(`${APP}/projets/${pid}`, { waitUntil: "networkidle" });
  await op.locator("[data-discovery-checkbox]").click();
  await op.locator("[data-discovery-button]").waitFor({ timeout: 15000 });
  await sql(`update discovery_settings set lemlist_invite_email = 'celien@example.test'`);

  // 2. Léa, ordinateur : accueil puis questions
  const cctx = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: "fr-FR", timezoneId: "Europe/Paris" });
  const cp = watch(await portalLogin(cctx, code), "léa");
  await cp.goto(`${APP}/portail/p/${pid}/onboarding`, { waitUntil: "networkidle" });
  await cp.locator("[data-discovery-flow]").waitFor();
  check("mascotte officielle affichée (Cély, rose #E88BF7)", (await cp.locator('[data-mascot] path[fill="#E88BF7"]').count()) === 1);
  await cp.waitForTimeout(400);
  await shot(cp, "1-accueil.png");
  await cp.locator("[data-start]").click();
  await onScreen(cp, "offer:0");
  const mainActions = () => cp.locator("main button.bg-ink, main a.bg-ink").count();
  check("une seule action principale par écran (question)", (await mainActions()) === 1);

  // question 1 : réponse normale
  await cp.locator("[data-answer]").fill("[TEST] On aide les ateliers à livrer plus vite.");
  await cp.keyboard.press("Enter");
  await onScreen(cp, "offer:1");
  // question 2 (obligatoire) : vide et case décochée → on ne passe pas, message clair
  await cp.locator("[data-ok]").click();
  await cp.locator("[data-needed]").waitFor();
  check("question obligatoire vide et case décochée : on reste, message affiché", (await screenId(cp)) === "offer:1");
  await cp.locator("[data-answer]").fill("[TEST] Des retards de livraison à répétition.");
  await cp.locator("[data-ok]").click();
  await onScreen(cp, "offer:2");
  // question 3 : « Je ne sais pas »
  await cp.locator("[data-unknown]").check();
  await shot(cp, "2-je-ne-sais-pas.png");
  await cp.locator("[data-ok]").click();
  await onScreen(cp, "offer:3");
  check("« Je ne sais pas » cochée : on passe à la suite sans répondre", JSON.stringify(await answerRow(pid, "results")) === JSON.stringify({ value: "", unknown: true, rev: 1 }));

  // question 4 : lien du site. D'abord invalide, puis sans « https:// »
  check("question 4 : champ « Lien de votre site (si vous en avez un) »", (await cp.locator('label[for="q-website"]').innerText()) === "Lien de votre site (si vous en avez un)");
  await cp.locator("[data-answer]").fill("[TEST] Un atelier de menuiserie de 40 personnes.");
  await cp.locator("[data-website]").fill("pas un site");
  await cp.locator("[data-ok]").click();
  await cp.locator("[data-website-error]").waitFor();
  check("lien invalide : refusé, on reste sur la question", (await screenId(cp)) === "offer:3" && !(await answerRow(pid, "website_url")));
  await shot(cp, "3-site-invalide.png");
  await cp.locator("[data-website]").fill("www.atelier-nova.example.test");
  await cp.locator("[data-website]").blur();
  check("lien sans « https:// » : complété dans le champ", (await cp.locator("[data-website]").inputValue()) === "https://www.atelier-nova.example.test");
  await shot(cp, "4-question-4-site.png");
  await cp.locator("[data-ok]").dblclick(); // double clic sur l'envoi de l'étape
  await onScreen(cp, "offer:4");
  await cp.waitForTimeout(500);
  check("double clic : un seul écran d'avance, une seule écriture", (await screenId(cp)) === "offer:4" && (await answerRow(pid, "recent_clients")).rev === 1 && (await answerRow(pid, "website_url")).rev === 1);
  check("lien arrivé sur la fiche entreprise, sans double saisie", (await one(`select website from companies where id = $1`, [cid])).website === "https://www.atelier-nova.example.test");

  // question 5 : case cochée puis réponse saisie → la case se décoche
  await cp.locator("[data-unknown]").check();
  await cp.locator("[data-answer]").fill("[TEST] Concurrent X ; nous, on s'engage sur les délais.");
  check("case cochée puis réponse saisie : la case se décoche", !(await cp.locator("[data-unknown]").isChecked()));
  await cp.keyboard.press("Enter");
  await onScreen(cp, "offer:5");
  check("… et c'est la réponse qui est enregistrée", (await answerRow(pid, "competitors")).unknown === false);
  // question 6 (facultative) : passer
  await cp.locator("[data-ok]").click();
  await onScreen(cp, "offer:6");
  // question 7 : réponse saisie puis case cochée → la réponse s'efface, et revient si on décoche
  await cp.locator("[data-answer]").fill("[TEST] Brouillon que je retire");
  await cp.locator("[data-unknown]").check();
  check("réponse saisie puis case cochée : le champ se vide", (await cp.locator("[data-answer]").inputValue()) === "");
  await cp.locator("[data-unknown]").uncheck();
  check("… et la réponse revient si on décoche", (await cp.locator("[data-answer]").inputValue()) === "[TEST] Brouillon que je retire");
  await cp.locator("[data-unknown]").check();
  await cp.locator("[data-ok]").click();
  await onScreen(cp, "lemlist");

  // 3. lemlist : quatre étapes, quatre captures chargées, aucun emplacement vide
  const imgs = await screenshotsLoaded(cp);
  check("lemlist : 4 captures affichées, aucun emplacement vide", imgs.length === 4 && imgs.every(Boolean) && (await cp.locator("[data-screenshot-slot]").count()) === 0, JSON.stringify(imgs));
  await shot(cp, "5-lemlist.png", true);
  check("une seule action principale par écran (lemlist)", (await mainActions()) === 1);
  await cp.locator("[data-lemlist-done]").dblclick();
  await onScreen(cp, "blacklist");
  await cp.waitForTimeout(400);
  check("double clic sur « C'est fait » : une seule étape d'avance", (await screenId(cp)) === "blacklist");
  await shot(cp, "6-blacklist.png");
  check("une seule action principale par écran (blacklist)", (await mainActions()) === 1);
  await cp.locator("[data-none]").click(); await onScreen(cp, "linkedin");
  await cp.locator("[data-later]").click(); await onScreen(cp, "documents");
  await cp.locator("[data-none]").click(); await onScreen(cp, "targets:0");
  await shot(cp, "7-cible.png");
  check("une seule action principale par écran (cible)", (await mainActions()) === 1);
  for (let i = 0; i < 3; i++) {
    await cp.locator("[data-validate]").click();
    await cp.locator("[data-next-target]").click();
    await cp.waitForTimeout(300);
  }
  await onScreen(cp, "recap");
  check("récapitulatif : « Je ne sais pas » visible sur 2 questions, lien du site présent", (await cp.locator("[data-recap-unknown]").count()) === 2 && (await cp.locator("[data-recap-website]").innerText()) === "https://www.atelier-nova.example.test");
  await shot(cp, "8-recap.png", true);
  check("une seule action principale par écran (récapitulatif)", (await mainActions()) === 1);
  await cp.locator("[data-send]").dblclick();
  if (await cp.locator("[data-missing]").count()) await cp.locator("[data-send]").dblclick();
  await cp.locator("[data-sent]").waitFor({ timeout: 15000 });
  await cp.waitForTimeout(500);
  await shot(cp, "9-envoye.png");
  check("envoi (double clic) : une seule action « Onboarding reçu, à traiter »", (await one(`select count(*)::int n from project_tasks where project_id = $1 and title = 'Onboarding reçu, à traiter'`, [pid])).n === 1);

  // 4. Mobile (même contact) : question, question 4, lemlist ; pas de défilement horizontal
  const mctx = await b.newContext({ ...devices["iPhone 13"], locale: "fr-FR", timezoneId: "Europe/Paris" });
  const mp = watch(await portalLogin(mctx, code), "léa-mobile");
  await mp.goto(`${APP}/portail/p/${pid}/onboarding`, { waitUntil: "networkidle" });
  await mp.locator("[data-review]").click(); await onScreen(mp, "recap");
  await shot(mp, "mobile-1-recap.png");
  const noOverflow = () => mp.evaluate(() => { const el = document.querySelector("[data-discovery-flow]"); return el.scrollWidth <= el.clientWidth; });
  await mp.locator('[data-recap="offer:0"] button', { hasText: "Corriger" }).click(); await onScreen(mp, "offer:0");
  const widths = [await noOverflow()];
  await shot(mp, "mobile-2-question.png");
  for (let i = 0; i < 3; i++) await mp.locator("[data-skip]").click();
  await onScreen(mp, "offer:3");
  widths.push(await noOverflow());
  await shot(mp, "mobile-3-question-4.png", true);
  for (let i = 0; i < 4; i++) await mp.locator("[data-skip]").click();
  await onScreen(mp, "lemlist");
  const mobileImgs = await screenshotsLoaded(mp);
  check("mobile : les 4 captures lemlist s'affichent", mobileImgs.length === 4 && mobileImgs.every(Boolean));
  widths.push(await noOverflow());
  await shot(mp, "mobile-4-lemlist.png", true);
  check("mobile : aucun défilement horizontal (question, question 4, lemlist)", widths.every(Boolean), JSON.stringify(widths));

  // 5. Ce que je vois côté CRM
  await op.goto(`${APP}/projets/${pid}/onboarding-decouverte`, { waitUntil: "networkidle" });
  await op.locator("[data-discovery-panel]").waitFor({ timeout: 20000 });
  const todo = (await op.locator("[data-discovery-to-complete] li").allInnerTexts()).map((x) => x.trim());
  check("CRM : bloc « À compléter avec le client » avec les 2 questions", todo.length === 2 && todo[0] === "Quel résultat concret obtiennent-ils ?" && todo[1] === "Ce qu'il ne faut jamais dire ?", JSON.stringify(todo));
  check("CRM : badge sur chaque question concernée", (await op.locator("[data-discovery-answers] [data-unknown]").count()) === 2);
  check("CRM : lien du site affiché et signalé présent sur la fiche", /atelier-nova\.example\.test[\s\S]*Présent sur la fiche/.test(await op.locator("[data-discovery-website]").innerText()));
  await shot(op, "crm-1-panneau.png", true);
  await op.goto(`${APP}/fiches/${cid}`, { waitUntil: "networkidle" });
  await op.waitForTimeout(600);
  check("CRM : la fiche entreprise affiche le site", (await op.locator('a[href="https://www.atelier-nova.example.test"]').count()) > 0);
  await shot(op, "crm-2-fiche.png");

  // 6. Le client répond ensuite : la question sort de « à compléter »
  await cp.goto(`${APP}/portail/p/${pid}/onboarding`, { waitUntil: "networkidle" });
  // la reprise est par contact : Léa s'était arrêtée sur lemlist (mobile), elle avance jusqu'au récapitulatif
  while ((await screenId(cp)) !== "recap") { await cp.locator("[data-skip]").click(); await cp.waitForTimeout(150); }
  await cp.locator("[data-recap-unknown]").first().click(); await onScreen(cp, "offer:2");
  check("la case est restée cochée à la reprise", await cp.locator("[data-unknown]").isChecked());
  await cp.locator("[data-answer]").fill("[TEST] −20 % de retards en 3 mois.");
  await cp.locator("[data-ok]").click();
  await onScreen(cp, "offer:3");
  check("le client répond ensuite : case décochée en base", JSON.stringify(await answerRow(pid, "results")) === JSON.stringify({ value: "[TEST] −20 % de retards en 3 mois.", unknown: false, rev: 2 }));
  await op.goto(`${APP}/projets/${pid}/onboarding-decouverte`, { waitUntil: "networkidle" });
  await op.locator("[data-discovery-panel]").waitFor({ timeout: 20000 });
  check("CRM : il ne reste qu'une question à compléter, et le changement est tracé", (await op.locator("[data-discovery-to-complete] li").count()) === 1 && (await op.locator("[data-discovery-changes] li").count()) >= 1);
  await shot(op, "crm-3-panneau-apres-reponse.png", true);

  check("aucune erreur dans la console", errors.length === 0, errors.join(" | "));
  await b.close();
  if (failures.length) { console.error(`\n${failures.length} vérification(s) en échec`); process.exit(1); }
  console.log("\nToutes les vérifications passent.");
})().catch((e) => { console.error(e); process.exit(1); });
