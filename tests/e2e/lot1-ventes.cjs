// Recette navigateur du lot 1 (environnement de test local : npm run test-env). Usage : node tests/e2e/lot1-ventes.cjs
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
/** Attend le toast attendu (jamais un ancien) et renvoie son texte. */
const toast = async (p, re) => { const t = p.locator("[data-sonner-toast]", { hasText: re }).last(); await t.waitFor({ timeout: 20000 }); return (await t.textContent()).replace(/\s+/g, " "); };
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const acme = (await one(`select id from companies where name = '[TEST] Acme'`)).id;
  const fiche = async () => { await p.goto(`${APP}/fiches/${studio}`, { waitUntil: "networkidle" }); };

  // 1. Gagné mensuel ; l'étape est verrouillée
  await fiche();
  await p.locator("[data-deal-actions]").getByRole("button", { name: "Gagné" }).click();
  await p.waitForSelector("[data-win-sale]");
  await p.getByRole("radio", { name: "Mensuel" }).click();
  await p.getByLabel("Montant par mois").fill("1000");
  await p.getByRole("button", { name: "Confirmer la vente" }).click();
  log("1.", await toast(p, /vente gagnée/));
  await p.waitForSelector("[data-deal-outcome=won]");
  log("   sélecteur d'étape désactivé :", await p.getByLabel("Étape du pipeline").isDisabled());
  const claire = (await one(`select id from people where email = 'claire@studio.example.test'`)).id;
  await sql(`insert into portal_accesses (person_id, code_hash, code_hint) values ($1, $2, 'AB12') on conflict do nothing`, [claire, "b".repeat(64)]);

  // 2. Rouvrir : décisions affichées (projet, revenu, accès client)
  await p.locator("[data-deal-outcome]").getByRole("button").first().click();
  await p.getByRole("button", { name: "Rouvrir l'opportunité" }).click();
  await p.waitForSelector("[data-transition=open]");
  log("2. décisions :", (await p.locator("[data-transition=open] legend").allInnerTexts()).join(" | "));
  await p.locator("[data-decide=project]").getByLabel("Passe en attente").check();
  await p.locator("[data-transition=open]").getByRole("button", { name: "Rouvrir" }).click();
  log("  ", await toast(p, /opportunité rouverte/));
  await p.waitForSelector("[data-deal-actions]");
  log("   étape modifiable :", !(await p.getByLabel("Étape du pipeline").isDisabled()), "| projet :", (await one(`select status from projects where company_id = $1`, [studio])).status);

  // 3. Perdu (vente rouverte avec liens) : décisions par défaut archiver / arrêter / révoquer
  await p.locator("[data-deal-actions]").getByRole("button", { name: "Perdu" }).click();
  await p.waitForSelector("[data-transition=lost]");
  await p.getByLabel("Motif de perte").fill("Budget gelé");
  await p.locator("[data-transition=lost]").getByRole("button", { name: "Marquer perdu" }).click();
  log("3.", await toast(p, /opportunité perdue/));
  log("   base :", JSON.stringify(await one(`select (select status from projects where company_id = $1 order by created_at desc limit 1) projet,
    (select status from finance_missions where company_id = $1 order by created_at desc limit 1) revenu,
    (select revoked_at is not null from portal_accesses where person_id = $2) acces_revoque, (select state from sales where company_id = $1 order by cycle desc limit 1) vente`, [studio, claire])));

  // 4. Client qui revient : rouvrir (plus rien d'actif), regagner → nouvelle vente ; puis nouvelle opportunité → 3e vente
  await fiche();
  await p.locator("[data-deal-outcome]").getByRole("button").first().click();
  await p.getByRole("button", { name: "Rouvrir l'opportunité" }).click();
  await p.locator("[data-transition=open]").getByRole("button", { name: "Rouvrir" }).click();
  await toast(p, /opportunité rouverte/);
  await p.waitForSelector("[data-deal-actions]");
  await p.locator("[data-deal-actions]").getByRole("button", { name: "Gagné" }).click();
  await p.waitForSelector("[data-win-sale]");
  await p.getByRole("radio", { name: "Ponctuel" }).click();
  await p.getByLabel("Montant", { exact: true }).fill("4000");
  await p.getByRole("button", { name: "Confirmer la vente" }).click();
  log("4.", await toast(p, /vente gagnée/));
  const cycle2 = await one(`select id, cycle, project_id from sales where company_id = $1 and state = 'won'`, [studio]);
  await sql(`update projects set status = 'termine' where id = $1`, [cycle2.project_id]);
  await fiche();
  await p.locator("[data-deal-outcome]").getByRole("button").first().click();
  await p.getByRole("button", { name: "Nouvelle opportunité" }).click();
  await p.waitForSelector("[data-new-opportunity]");
  await p.locator("[data-new-opportunity]").getByRole("button", { name: "Ouvrir" }).click();
  log("  ", await toast(p, /nouvelle opportunité/));
  await p.waitForSelector("[data-deal-actions]");
  await p.locator("[data-deal-actions]").getByRole("button", { name: "Gagné" }).click();
  await p.waitForSelector("[data-win-sale]");
  await p.getByRole("radio", { name: "Mensuel" }).click();
  await p.getByLabel("Montant par mois").fill("1500");
  await p.getByRole("button", { name: "Confirmer la vente" }).click();
  await toast(p, /vente gagnée/);
  log("   ventes de la fiche :", JSON.stringify(await sql(`select cycle, state, (select status from projects where id = s.project_id) projet from sales s where company_id = $1 order by cycle`, [studio])));
  await p.goto(`${APP}/ventes?vue=gagnees&periode=tout`, { waitUntil: "networkidle" });
  log("   Gagnées :", (await p.locator("[data-won-list] tbody tr").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")));

  // 5. Carte Ventes : démarrer la mission, puis reculer → confirmation demandée (acceptée ici)
  await p.goto(`${APP}/ventes`, { waitUntil: "networkidle" });
  const card = p.locator(`[data-sale-card="${studio}"]`);
  await card.getByRole("button", { name: "Finaliser le dossier" }).click();
  await p.getByLabel(/J'ai vérifié/).check();
  await p.getByRole("button", { name: "Confirmer : passer en Onboarding" }).click();
  await toast(p, /Onboarding/);
  await p.waitForTimeout(1500); // la liste se relit
  await card.getByRole("button", { name: /Actions pour/ }).click();
  await p.getByRole("menuitem", { name: "Démarrer la mission" }).click();
  await toast(p, /En mission/);
  await p.waitForTimeout(1500);
  await card.getByRole("button", { name: /Actions pour/ }).click();
  const dialogs = [];
  p.removeAllListeners("dialog"); p.on("dialog", (d) => { dialogs.push(d.message().split("\n")[0]); d.accept(); });
  await p.getByRole("menuitem", { name: "Passer en Onboarding" }).click();
  await p.waitForTimeout(1500);
  log("5. confirmation demandée :", dialogs, "| projet :", (await one(`select p.status from sales s join projects p on p.id = s.project_id where s.company_id = $1 and s.state = 'won'`, [studio])).status);

  // 6. Kanban : Perdu sans élément lié (simple)
  const pl = (await one(`select pipeline_id from companies where id = $1`, [acme])).pipeline_id;
  await p.goto(`${APP}/pipelines/${pl}`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Clôturer [TEST] Acme", exact: true }).click();
  await p.getByRole("menuitem", { name: "Perdu" }).click();
  await p.waitForSelector("[data-transition=lost]");
  log("6. décisions Kanban (aucun lien) :", await p.locator("[data-transition=lost] fieldset").count());
  await p.locator("[data-transition=lost]").getByRole("button", { name: "Marquer perdu" }).click();
  log("  ", await toast(p, /Acme : opportunité perdue/));
  log("erreurs :", errors);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
