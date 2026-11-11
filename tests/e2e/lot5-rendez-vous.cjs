// Recette navigateur du lot 5 (environnement local : agenda Google NON connecté, Gmail non configuré).
// Usage : node tests/e2e/lot5-rendez-vous.cjs
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
(async () => {
  const b = await chromium.launch(); const errors = [];
  // la clé serveur est enregistrée à la première visite de Rendez-vous par le propriétaire (comme en production)
  { const c = await context(b, "owner"); const q = await c.newPage(); await q.goto(`${APP}/rendez-vous`, { waitUntil: "networkidle" }); await c.close(); }
  // 1. Agenda non connecté : la réservation en ligne est suspendue, avec un message utile
  const pub = await (await b.newContext()).newPage();
  pub.on("pageerror", (e) => errors.push(e.message));
  await pub.goto(`${APP}/rdv/appel-decouverte`, { waitUntil: "networkidle" });
  await pub.waitForTimeout(1500);
  log("1. page publique :", ((await pub.locator("body").innerText()).match(/momentanément suspendue[^\n]*/) ?? ["(message absent)"])[0]);
  const api = await pub.request.post(`${APP}/api/rdv/book`, { data: { slug: "appel-decouverte", starts_at: new Date(Date.now() + 3 * 864e5).toISOString(), invitee: { first_name: "A", last_name: "B", email: "a@b.example.test", timezone: "Europe/Paris" }, answers: { besoin: "x" }, idempotency_key: "e2e-lot5-0001" } });
  log("   réservation directe par l'API :", api.status(), ((await api.json()).message ?? "").slice(0, 60));
  log("   rendez-vous créés :", (await sql(`select count(*)::int n from appt_bookings`))[0].n);
  // 2. Passages planifiés : sans secret ni session, refusé ; lancés par le propriétaire, rapportés
  const anon = await pub.request.get(`${APP}/api/cron`);
  log("2. /api/cron sans autorisation :", anon.status());
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${APP}/parametres/passages`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Lancer maintenant" }).click();
  await p.locator("[data-sonner-toast]").first().waitFor({ timeout: 30000 });
  await p.reload({ waitUntil: "networkidle" });
  for (const j of ["agenda", "rappels", "gmail", "fireflies"]) log(`   ${j} :`, (await p.locator(`[data-job=${j}]`).innerText()).replace(/\s+/g, " ").slice(0, 160));
  await p.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/lot5-passages.png` });
  // 3. Emails à rattacher : page vide, accessible
  await p.goto(`${APP}/mail/a-rattacher`, { waitUntil: "networkidle" });
  log("3. emails à rattacher :", await p.locator("h1").first().textContent());
  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
