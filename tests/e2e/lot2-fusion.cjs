// Recette navigateur du lot 2 (C02, environnement de test local : npm run test-env). Usage : node tests/e2e/lot2-fusion.cjs
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
const toast = async (p, re) => { const t = p.locator("[data-sonner-toast]", { hasText: re }).last(); await t.waitFor({ timeout: 20000 }); return (await t.textContent()).replace(/\s+/g, " "); };
const win = async (p, id, amount) => {
  await p.goto(`${APP}/fiches/${id}`, { waitUntil: "networkidle" });
  await p.locator("[data-deal-actions]").getByRole("button", { name: "Gagné" }).click();
  await p.waitForSelector("[data-win-sale]");
  await p.getByRole("radio", { name: "Ponctuel" }).click();
  await p.getByLabel(/Montant/).first().fill(String(amount));
  await p.getByRole("button", { name: "Confirmer la vente" }).click();
  await toast(p, /vente gagnée/);
};
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const acme = (await one(`select id from companies where name = '[TEST] Acme'`)).id;
  const fusion = (keep, merge) => `${APP}/prospection/doublons/fusion?a=${keep}&b=${merge}`;

  // 1. Deux ventes actives : conflit présenté, fusion impossible
  await win(p, studio, 2500);
  await win(p, acme, 1200);
  await p.goto(fusion(studio, acme), { waitUntil: "networkidle" });
  await p.waitForSelector("[data-merge-preview] p");
  log("1. aperçu :", (await p.locator("[data-merge-preview]").textContent()).replace(/\s+/g, " "));
  log("   blocage affiché :", await p.locator("[data-merge-blocking]").count() > 0);
  await p.getByRole("checkbox").last().check();
  log("   bouton Fusionner désactivé :", await p.getByRole("button", { name: "Fusionner" }).isDisabled());

  // 2. Doublon sans vente, avec projet, rendez-vous et revenu : tout est rattaché
  const bis = (await one(`insert into companies (name) values ('[TEST] Studio Démo (doublon)') returning id`)).id;
  await sql(`insert into projects (company_id, name) values ($1, '[TEST] Projet du doublon')`, [bis]);
  await sql(`insert into people (company_id, first_name, email) values ($1, 'Léa', 'lea@studio.example.test')`, [bis]);
  const type = (await one(`select id from appt_event_types limit 1`)).id;
  await sql(`insert into appt_bookings (event_type_id, company_id, status, starts_at, ends_at, schedule_timezone, invitee_timezone, first_name, last_name, email, email_norm, event_snapshot, crm_status, idempotency_key, manage_token_hash)
             values ($1, $2, 'confirmed', now() + interval '3 days', now() + interval '3 days 30 minutes', 'Europe/Paris', 'Europe/Paris', 'Léa', 'Test', 'lea@studio.example.test', 'lea@studio.example.test', '{}', 'linked', gen_random_uuid()::text, repeat('d', 64))`, [type, bis]).catch((e) => log("   (rendez-vous non créé :", e.message, ")"));
  await p.goto(fusion(studio, bis), { waitUntil: "networkidle" });
  await p.waitForSelector("[data-merge-preview] p");
  log("2. aperçu :", (await p.locator("[data-merge-preview]").textContent()).replace(/\s+/g, " "));
  await p.getByRole("checkbox").last().check();
  await p.getByRole("button", { name: "Fusionner" }).click();
  await p.waitForURL(/\/fiches\//, { timeout: 20000 });
  log("   après fusion :", JSON.stringify(await one(`select
      (select count(*)::int from projects where company_id = $1) projets,
      (select count(*)::int from appt_bookings where company_id = $1) rdv,
      (select count(*)::int from people where company_id = $1) personnes,
      (select count(*)::int from projects where company_id = $2) restes_projets,
      (select merged_into_id = $1 from companies where id = $2) redirige`, [studio, bis])));
  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
