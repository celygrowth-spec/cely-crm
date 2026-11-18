// Recette navigateur, côté CRM : case « Offre découverte », bouton, panneau, préparation des cibles.
// Usage (environnement de test lancé) : node tests/e2e/onboarding-decouverte-crm.cjs
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const SHOTS = process.env.SHOTS ?? "/tmp";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const people = await sql(`select id from people where company_id = $1 order by email`, [studio]);
  const pid = (await one(`insert into projects (company_id, name, status, portal_published) values ($1, '[TEST] Offre découverte', 'en_cours', true) returning id`, [studio])).id;
  for (const x of people) await sql(`insert into project_members (project_id, person_id) values ($1, $2)`, [pid, x.id]);
  log("projet :", pid);

  // 1. Case décochée par défaut, pas de bouton
  await p.goto(`${APP}/projets/${pid}`, { waitUntil: "networkidle" });
  log("1. case cochée au départ :", await p.locator("[data-discovery-checkbox]").isChecked(), "· bouton :", await p.locator("[data-discovery-button]").count());
  // 2. Cocher : le bouton apparaît
  await p.locator("[data-discovery-checkbox]").click();
  await p.locator("[data-discovery-button]").waitFor({ timeout: 15000 });
  log("2. après cochage : bouton visible ; en base :", JSON.stringify(await one(`select enabled, enabled_source from discovery_onboardings where project_id = $1`, [pid])));
  await p.screenshot({ path: `${SHOTS}/crm-1-general.png` });
  // 3. Panneau
  await p.locator("[data-discovery-button]").click();
  await p.locator("[data-discovery-panel]").waitFor({ timeout: 20000 });
  log("3. état :", await p.locator("[data-discovery-state]").innerText(), "· étapes :", (await p.locator("[data-step]").evaluateAll((els) => els.map((e) => `${e.dataset.step}=${e.dataset.progress}`))).join(" "));
  // 4. Cibles : cible 1 remplie, cible 2 seulement le nom, cible 3 vide
  const t1 = p.locator('[data-target="1"]');
  await t1.getByPlaceholder("Ex. : DAF d'ETI industrielles").fill("[TEST] DAF d'ETI industrielles");
  await t1.getByPlaceholder("Ex. : industrie, agroalimentaire").fill("Industrie");
  await t1.getByPlaceholder("Ex. : 50 à 500 salariés").fill("50 à 500 salariés");
  await t1.getByPlaceholder("Ex. : DAF, contrôleur de gestion").fill("DAF, RAF");
  await t1.getByPlaceholder("Ex. : France, Belgique").fill("France");
  await t1.locator("[data-target-save]").click();
  await p.waitForTimeout(800);
  const t2 = p.locator('[data-target="2"]');
  await t2.getByPlaceholder("Ex. : DAF d'ETI industrielles").fill("[TEST] Cabinets d'expertise comptable");
  await t2.locator("[data-target-save]").click();
  await p.waitForTimeout(800);
  log("4. cibles en base :", JSON.stringify(await sql(`select position, name, sector, rev from discovery_targets where project_id = $1 order by position`, [pid])));
  await p.screenshot({ path: `${SHOTS}/crm-2-panneau.png`, fullPage: true });
  // 5. Réglage lemlist (adresse fictive)
  await p.locator("#lemlist-invite").fill("celien@example.test");
  await p.locator("[data-discovery-settings]").getByRole("button", { name: "Enregistrer" }).click();
  await p.waitForTimeout(800);
  log("5. réglage :", JSON.stringify(await one(`select lemlist_invite_email from discovery_settings`)));
  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
