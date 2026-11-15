// Recette navigateur « Navigation et Accueil ». Environnement local uniquement (npm run test-env), données [TEST] fictives.
// Usage : TEST_APP_PORT=3000 TEST_DB_PORT=54321 SHOTS=/tmp node tests/e2e/nav-accueil.cjs
const { chromium } = require("playwright");
const { context, sql, token } = require("../../scripts/test-env/browser.cjs");
const APP = `http://localhost:${process.env.TEST_APP_PORT ?? 3000}`;
const SHOTS = process.env.SHOTS ?? "/tmp";
const log = (...a) => console.log(...a);
/** Appel RPC au nom du compte de test (mêmes règles que l'application). */
async function rpc(fn, args) {
  const r = await fetch(`http://127.0.0.1:${process.env.TEST_DB_PORT ?? 54321}/rest/v1/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token("owner")}`, apikey: "test" }, body: JSON.stringify(args) });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}
const one = async (q, p) => (await sql(q, p))[0];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

(async () => {
  const b = await chromium.launch(); const errors = [];
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const acme = (await one(`select id from companies where name = '[TEST] Acme'`)).id;

  // 0. Compte sans données propres : l'Accueil s'affiche, chaque bloc a son message
  {
    const p = await (await context(b, "owner")).newPage(); p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(APP + "/", { waitUntil: "networkidle" });
    log("0. vide :", (await p.locator("[data-empty]").allTextContents()).join(" | "));
    await p.screenshot({ path: `${SHOTS}/accueil-vide.png`, fullPage: true });
    await p.context().close();
  }

  // Données fictives : facture en retard, projet avec jalon, appel à rattacher, rendez-vous du jour, tâche de projet
  await sql(`insert into finance_invoices (company_id, reference, issue_date, due_date, amount_ht, vat_rate, vat_amount, amount_ttc)
             values ($1, '[TEST] F-001', $2, $3, 1000, '20', 200, 1200)`, [studio, daysAgo(40), daysAgo(10)]);
  const pr = (await one(`insert into projects (company_id, name, status) values ($1, '[TEST] Refonte', 'en_cours') returning id`, [studio])).id;
  await sql(`insert into project_milestones (project_id, title, due_date) values ($1, '[TEST] Livraison maquettes', $2)`, [pr, inDays(5)]);
  await sql(`insert into project_tasks (project_id, title, due_date) values ($1, '[TEST] Valider le brief', $2)`, [pr, today]);
  await sql(`insert into projects (company_id, name, status) values ($1, '[TEST] Audit', 'a_preparer')`, [acme]);
  const call = (await one(`insert into fireflies_calls (account_id, fireflies_id, title, occurred_at) values ('c', 'ff-nav-1', '[TEST] Appel découverte', now() - interval '1 day') returning id`)).id;
  await sql(`update fireflies_calls set company_id = null, link_state = 'to_link', link_source = null,
             link_candidates = jsonb_build_array(jsonb_build_object('company_id', $2::uuid, 'name', '[TEST] Acme', 'reasons', jsonb_build_array('domaine'), 'archived', false)) where id = $1`, [call, acme]);
  const campaign = await rpc("create_campaign_draft", { p_name: "[TEST] Fondateurs" });
  await rpc("save_campaign_sequence", { p_campaign: campaign, p_steps: [{ name: "Invitation", step_type: "linkedin_invite", delay_days: 0, message: "" }] });
  await rpc("enroll_in_campaign", { p_campaign: campaign, p_company_ids: [acme] });
  await rpc("activate_participants", { p_campaign: campaign, p_ids: [(await one(`select id from campaign_participants where company_id = $1`, [acme])).id] });
  const type = (await one(`select id from appt_event_types limit 1`))?.id;
  if (type) await sql(`insert into appt_bookings (event_type_id, company_id, status, starts_at, ends_at, schedule_timezone, invitee_timezone, first_name, last_name, email, email_norm, event_snapshot, crm_status, idempotency_key, manage_token_hash)
             values ($1, $2, 'confirmed', date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' + interval '23 hours', date_trunc('day', now() at time zone 'Europe/Paris') at time zone 'Europe/Paris' + interval '23 hours 30 minutes', 'Europe/Paris', 'Europe/Paris', 'Claire', 'Test', 'claire@studio.example.test', 'claire@studio.example.test', '{"name":"[TEST] Découverte"}', 'linked', gen_random_uuid()::text, repeat('e', 64))`, [type, studio]).catch((e) => log("   (rendez-vous non créé :", e.message, ")"));
  else log("   (aucun type de rendez-vous : bloc rendez-vous non vérifié)");

  for (const [name, viewport] of [["ordinateur", { width: 1360, height: 900 }], ["telephone", { width: 390, height: 844 }]]) {
    const p = await (await context(b, "owner", { viewport })).newPage(); p.on("pageerror", (e) => errors.push(e.message));
    p.on("dialog", (d) => d.accept());
    await p.goto(APP + "/", { waitUntil: "networkidle" });
    await p.waitForSelector("[data-home-calls]", { timeout: 20000 }).catch(() => {});
    log(`1. ${name} — finance :`, (await p.locator("[data-home-finance]").textContent()).replace(/\s+/g, " ").slice(0, 220));
    log(`   clients :`, (await p.locator("[data-home-project]").allTextContents()).map((t) => t.replace(/\s+/g, " ")).join(" | "));
    log(`   relances :`, (await p.locator("[data-home-followups] li").allTextContents()).map((t) => t.replace(/\s+/g, " ")).join(" | ") || "aucune");
    log(`   à traiter :`, (await p.locator("[data-home-todo]").textContent()).replace(/\s+/g, " ").slice(0, 400));
    log(`   largeur :`, await p.evaluate(() => document.documentElement.scrollWidth));
    await p.screenshot({ path: `${SHOTS}/accueil-${name}.png`, fullPage: true });
    if (name === "ordinateur") {
      // 2. rattacher l'appel depuis l'Accueil : double clic → un seul envoi, l'appel disparaît sans recharger
      let posts = 0; p.on("request", (r) => r.method() === "POST" && r.url().includes(`/api/fireflies/calls/${call}/link`) && posts++);
      await p.getByRole("button", { name: "Rattacher à [TEST] Acme" }).dblclick();
      await p.waitForSelector("[data-home-calls-done]", { timeout: 20000 });
      const row = await one(`select company_id, link_state, link_source from fireflies_calls where id = $1`, [call]);
      log("2. rattachement :", posts, "envoi(s) ;", row.company_id === acme ? "fiche Acme" : row.company_id, row.link_state, row.link_source, "; bloc :", await p.locator("[data-home-calls-done]").textContent());
      // 3. un clic pour agir : facture en retard → la facture ; projet → le projet
      await p.locator("[data-home-late] a").first().click(); await p.waitForURL(/facture=/); log("3. facture →", new URL(p.url()).search);
      await p.goto(APP + "/", { waitUntil: "networkidle" }); await p.locator("[data-home-project]").first().click(); await p.waitForURL(/\/projets\//); log("   projet →", new URL(p.url()).pathname);
    }
    await p.context().close();
  }

  // 4. second compte (non propriétaire) : mêmes règles d'accès qu'avant, aucune donnée affichée
  {
    const p = await (await context(b, "stranger")).newPage();
    const r = await p.goto(APP + "/", { waitUntil: "networkidle" });
    log("4. second compte :", r?.status(), new URL(p.url()).pathname, "; Acme visible :", (await p.content()).includes("[TEST] F-001"));
    await p.context().close();
  }
  log("erreurs JS :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
