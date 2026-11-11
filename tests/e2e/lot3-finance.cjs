// Recette navigateur du lot 3 (Finance cohérente). Environnement local : npm run test-env. Usage : node tests/e2e/lot3-finance.cjs
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
const toast = async (p, re) => { const t = p.locator("[data-sonner-toast]", { hasText: re }).last(); await t.waitFor({ timeout: 20000 }); return (await t.textContent()).replace(/\s+/g, " "); };
const shot = (p, n) => p.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/lot3-${n}.png`, fullPage: false });
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const acme = (await one(`select id from companies where name = '[TEST] Acme'`)).id;

  // 1. Formulaire commun depuis Finance › Revenus par client : ponctuel 3 000 € pour Acme
  await p.goto(`${APP}/finance/clients?tous=1`, { waitUntil: "networkidle" });
  log("1. titre :", await p.locator("h1").first().textContent());
  await p.getByRole("button", { name: "Ajouter un revenu" }).first().click();
  await p.waitForSelector("[data-revenue-terms]");
  await p.getByLabel("Rechercher le client").fill("Acme");
  await p.getByRole("dialog").getByRole("button", { name: "[TEST] Acme" }).click();
  await p.getByPlaceholder("Audit SEO").fill("[TEST] Audit");
  await p.getByLabel("Montant", { exact: true }).fill("3000");
  await p.getByRole("button", { name: "Enregistrer" }).click();
  log("   ", await toast(p, /Revenu enregistré/));
  const m = (await one(`select id from finance_missions where company_id = $1 and label = '[TEST] Audit'`, [acme])).id;

  // 2. Acompte de 1 000 € réglé : « Partiellement encaissé », puis « Encaisser le solde (2 000 €) » en un clic
  await p.goto(`${APP}/finance/revenus?revenu=${m}`, { waitUntil: "networkidle" });
  await p.locator("[data-balance]").getByRole("button").click();
  await p.locator("[data-settle-rest]").waitFor();
  log("2. aide :", (await p.locator("[data-settle-rest]").textContent()).replace(/\s+/g, " "));
  await p.getByLabel("Montant dû").fill("1000");
  await p.locator("form:has([data-settle-rest]) button[type=submit]").click();
  log("   ", await toast(p, /encaissée|Paiement/));
  await p.goto(`${APP}/finance/revenus?revenu=${m}`, { waitUntil: "networkidle" });
  log("   statut :", await p.getByRole("dialog", { name: "Détail du revenu" }).locator("span", { hasText: /encaiss/i }).first().textContent());
  const solde = p.locator("[data-balance]").getByRole("button");
  log("   bouton :", await solde.textContent());
  await shot(p, "acompte");
  await solde.click();
  await p.locator("form:has([data-settle-rest]) button[type=submit]").click();
  await toast(p, /encaissée/);
  await p.goto(`${APP}/finance/revenus?revenu=${m}`, { waitUntil: "networkidle" });
  log("   après solde :", await p.getByRole("dialog", { name: "Détail du revenu" }).locator("span", { hasText: /Encaiss/ }).first().textContent(),
    "· base :", (await one(`select public.finance_revenue_state($1) s`, [m])).s);

  // 3. Avoir : la décision sur le revenu est proposée explicitement
  const inv = (await one(`select id from finance_invoices where mission_id = $1 order by created_at limit 1`, [m])).id;
  await p.goto(`${APP}/finance/revenus?facture=${inv}`, { waitUntil: "networkidle" });
  const avoir = p.getByRole("button", { name: "Avoir", exact: true });
  if (await avoir.count()) {
    await avoir.click();
    log("3. choix « réduire le revenu » proposé :", await p.locator("[data-reduce-revenue]").count() === 1);
    await p.keyboard.press("Escape");
  } else log("3. (bouton Avoir introuvable sur le détail de facture)");

  // 4. Gagné mensuel 1 000 € sur une fiche estimée à 12 000 € : montant « / mois », estimation dans l'historique
  await sql(`update companies set amount = 12000 where id = $1`, [studio]);
  await p.goto(`${APP}/fiches/${studio}`, { waitUntil: "networkidle" });
  await p.locator("[data-deal-actions]").getByRole("button", { name: "Gagné" }).click();
  await p.waitForSelector("[data-win-sale]");
  await p.getByRole("radio", { name: "Mensuel" }).click();
  await p.getByLabel("Montant par mois").fill("1000");
  await p.getByRole("button", { name: "Confirmer la vente" }).click();
  await toast(p, /vente gagnée/);
  await p.reload({ waitUntil: "networkidle" });
  await p.getByText("Détails", { exact: true }).first().click();
  await p.waitForTimeout(1500);
  log("4. fiche :", JSON.stringify(await one(`select amount::text, amount_recurring from companies where id = $1`, [studio])),
    "· affiché :", ((await p.locator("main").innerText()).match(/Montant confirmé\n[^\n]*/) ?? ["non"])[0].replace(/\s+/g, " "),
    "· historique :", (await one(`select content from interactions where company_id = $1 and content like 'Montant confirmé%'`, [studio]))?.content);
  const csv = await (await p.request.get(`${APP}/api/export`)).text();
  log("   export :", csv.split("\n").find((l) => l.includes("Studio Démo"))?.match(/1000(\.00)?[;,]"?mois/) ? "montant 1000 · par mois" : csv.slice(0, 200));
  await p.goto(`${APP}/ventes`, { waitUntil: "networkidle" });
  log("   Ventes :", (await p.locator("body").textContent()).match(/(Prévu|À jour|En retard|Partiellement réglé|Encaissé)/)?.[0]);
  await shot(p, "ventes");

  // 5. Facture saisie depuis Revenus par client sur un mensuel : l'échéance proposée n'est pas déjà facturée
  const sm = (await one(`select mission_id from sales where company_id = $1 and state = 'won'`, [studio])).mission_id;
  await sql(`select 1`);
  await p.goto(`${APP}/finance/clients?tous=1`, { waitUntil: "networkidle" });
  const card = p.locator("div.space-y-3 > div", { hasText: "[TEST] Studio Démo" }).first();
  await card.getByRole("button", { name: "Facture", exact: true }).first().click();
  await p.getByRole("dialog").locator("select").first().selectOption(sm);
  const cover = p.getByText(/correspond à l'échéance prévue du/);
  log("5. échéance proposée :", (await cover.count()) ? (await cover.textContent()).replace(/\s+/g, " ") : "aucune");
  await p.keyboard.press("Escape");

  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
