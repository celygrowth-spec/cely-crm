// Recette navigateur du lot 7 : chrono → projet → totaux ; chrono oublié arrêté avec une fin confirmée.
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const pr = (await one(`insert into projects (company_id, name, status) values ($1, '[TEST] Refonte', 'en_cours') returning id`, [studio])).id;
  // 1. Chrono sur le projet depuis la page Temps
  await p.goto(`${APP}/temps`, { waitUntil: "networkidle" });
  await p.locator("[data-start-timer]").first().click();
  await p.getByLabel("Rechercher le client").fill("Studio");
  await p.getByRole("dialog").getByRole("button", { name: "[TEST] Studio Démo" }).click();
  await p.getByLabel("Projet").selectOption(pr);
  await p.getByRole("dialog").getByRole("button", { name: "Démarrer" }).click();
  await p.waitForTimeout(1500);
  log("1. chrono :", JSON.stringify(await one(`select project_id = $1 as sur_projet, ended_at is null as en_cours from time_entries`, [pr])));
  // 2. Chrono oublié (il y a 2 jours) : fin proposée, confirmée, tracée
  await sql(`update time_entries set started_at = now() - interval '2 days' where ended_at is null`);
  p.once("dialog", async (d) => { log("2. proposition :", d.message().replace(/\n/g, " "), "→", d.defaultValue()); await d.accept(d.defaultValue()); });
  await p.reload({ waitUntil: "networkidle" });
  await p.getByRole("button", { name: /Arrêter/ }).first().click();
  await p.waitForTimeout(2000);
  log("   messages :", (await p.locator("[data-sonner-toast]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ")).join(" | "));
  log("   enregistré :", JSON.stringify(await one(`select round(extract(epoch from ended_at - started_at) / 3600) as heures, corrected_at is not null as corrige from time_entries`)));
  // 3. Totaux : filtre par projet sur les mêmes sessions
  await sql(`insert into time_entries (company_id, label, started_at, ended_at, source) values ($1, 'sans projet', now() - interval '3 hours', now() - interval '2 hours', 'manual')`, [studio]);
  await p.goto(`${APP}/temps?p=mois`, { waitUntil: "networkidle" });
  const total = async () => (await p.locator("[data-total]").innerText()).trim();
  log("3. total client (mois) :", await total());
  await p.locator("[data-project-filter] select").selectOption(pr);
  await p.waitForURL(/projet=/); await p.waitForLoadState("networkidle");
  log("   total projet :", await total());
  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
