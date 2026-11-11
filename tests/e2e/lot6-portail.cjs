// Recette navigateur du lot 6 (portail et documents). Usage : node tests/e2e/lot6-portail.cjs
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const claire = (await one(`select id from people where email = 'claire@studio.example.test'`)).id;
  const pid = (await one(`insert into projects (company_id, name, status, portal_published) values ($1, '[TEST] Portail', 'en_cours', true) returning id`, [studio])).id;
  await sql(`insert into project_members (project_id, person_id) values ($1, $2)`, [pid, claire]);
  const f = (await one(`insert into company_files (company_id, storage_path, display_name, mime_type, size_bytes, status) values ($1::uuid, $2, '[TEST] Contrat signé.pdf', 'application/pdf', 100, 'ready') returning id`, [studio, studio + '/c.pdf'])).id;

  // 1. Partage d'un document de la fiche : destination choisie, confirmation avant toute visibilité client
  await p.goto(`${APP}/projets/${pid}/fichiers`, { waitUntil: "networkidle" });
  await p.getByLabel(/\[TEST\] Contrat signé\.pdf/).check();
  await p.locator("[data-share]").getByRole("button", { name: /Partager avec le projet/ }).click();
  await p.locator("[data-share-confirm]").waitFor();
  log("1. confirmation :", (await p.locator("[data-share-confirm]").innerText()).replace(/\s+/g, " ").slice(0, 150));
  log("   partagé avant confirmation :", (await one(`select count(*)::int n from project_files where file_id = $1`, [f])).n);
  await p.getByRole("button", { name: "Confirmer le partage" }).click();
  await p.locator("[data-sonner-toast]").first().waitFor();
  log("   après confirmation :", (await one(`select count(*)::int n from project_files where file_id = $1`, [f])).n, "·", (await p.locator("[data-sonner-toast]").first().innerText()).replace(/\s+/g, " "));

  // 2. Aperçu : signale que le contact ne voit rien sans accès valide
  await p.goto(`${APP}/projets/${pid}/apercu`, { waitUntil: "networkidle" });
  log("2. aperçu :", (await p.locator("[data-preview-warning]").innerText().catch(() => "(aucun avertissement)")).replace(/\s+/g, " "));
  await p.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/lot6-apercu.png` });
  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
