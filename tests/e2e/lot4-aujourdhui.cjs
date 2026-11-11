// Recette navigateur du lot 4 (« Aujourd'hui »). Environnement local : npm run test-env. Usage : node tests/e2e/lot4-aujourdhui.cjs
const { chromium } = require("playwright");
const { context, sql, token } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
const toast = async (p, re) => { const t = p.locator("[data-sonner-toast]", { hasText: re }).last(); await t.waitFor({ timeout: 20000 }); return (await t.textContent()).replace(/\s+/g, " "); };
/** Appel RPC au nom du compte de test (mêmes règles que l'application). */
async function rpc(fn, args) {
  const r = await fetch(`http://127.0.0.1:54321/rest/v1/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token("owner")}`, apikey: "test" }, body: JSON.stringify(args) });
  const j = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await context(b, "owner"); const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message)); p.on("dialog", (d) => d.accept());
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  const acme = (await one(`select id from companies where name = '[TEST] Acme'`)).id;

  // données : une tâche de projet attribuée à moi pour aujourd'hui ; une réponse de campagne à traiter
  const pr = (await one(`insert into projects (company_id, name, status) values ($1, '[TEST] Refonte', 'en_cours') returning id`, [studio])).id;
  const pt = (await one(`insert into project_tasks (project_id, title, due_date) values ($1, '[TEST] Valider les maquettes', $2) returning id`, [pr, today])).id;
  await sql(`insert into people (company_id, first_name, email) values ($1, 'Paul', 'paul@acme.example.test')`, [acme]);
  const campaign = await rpc("create_campaign_draft", { p_name: "[TEST] Fondateurs" });
  await rpc("save_campaign_sequence", { p_campaign: campaign, p_steps: [{ name: "Invitation", step_type: "linkedin_invite", delay_days: 0, message: "" }, { name: "Email", step_type: "email", delay_days: 3, subject: "Bonjour", message: "Bonjour" }] });
  await rpc("enroll_in_campaign", { p_campaign: campaign, p_company_ids: [acme] });
  const part = (await one(`select id from campaign_participants where company_id = $1`, [acme])).id;
  await rpc("activate_participants", { p_campaign: campaign, p_ids: [part] });
  await rpc("record_reply", { p_participant: part, p_content: "Oui, avec plaisir pour un échange." });

  // 1. Accueil = Aujourd'hui : la tâche de projet et la réponse à traiter y sont ; le compteur du menu les compte
  await p.goto(`${APP}/`, { waitUntil: "networkidle" });
  log("1. URL :", new URL(p.url()).pathname, "· titre :", await p.locator("h1").first().textContent());
  log("   tâche de projet listée :", await p.locator(`[data-project-task="${pt}"]`).count() === 1, "· réponses :", (await p.locator("[data-today-replies]").textContent())?.replace(/\s+/g, " ").slice(0, 40));
  log("   compteur du menu :", (await p.getByRole("link", { name: /Aujourd'hui/ }).first().textContent()).replace(/\s+/g, " "));
  await p.screenshot({ path: `${process.env.SHOTS ?? "/tmp"}/lot4-aujourdhui.png` });

  // 2. Validée ici : terminée dans le projet, sortie de la file
  await p.locator(`[data-project-task="${pt}"] input[type=checkbox]`).check();
  log("2.", await toast(p, /Tâche du projet terminée/));
  log("   projet :", (await one(`select status from project_tasks where id = $1`, [pt])).status);
  await p.goto(`${APP}/`, { waitUntil: "networkidle" });
  log("   encore listée :", await p.locator(`[data-project-task="${pt}"]`).count());

  // 3. Anciennes adresses
  await p.goto(`${APP}/a-faire`, { waitUntil: "networkidle" });
  log("3. /a-faire →", new URL(p.url()).pathname + new URL(p.url()).search);
  await p.goto(`${APP}/prospection/aujourdhui`, { waitUntil: "networkidle" });
  log("   /prospection/aujourdhui →", new URL(p.url()).pathname);

  // 4. Réponse : « RDV obtenu » propose une suite ; double clic = une seule tâche ; la fiche reste dans la file
  await p.goto(`${APP}/prospection/reponses`, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: /RDV obtenu/ }).first().click();
  log("4. suite proposée :", await p.locator("[data-next-step]").count() === 1, "·", await p.getByLabel("Tâche de suivi").inputValue());
  const save = p.getByRole("button", { name: "Enregistrer le résultat" });
  await Promise.all([save.click(), save.dblclick().catch(() => {})]);
  log("   ", await toast(p, /Rendez-vous obtenu/));
  await p.waitForTimeout(1000);
  log("   tâches créées :", (await one(`select count(*)::int n from tasks where company_id = $1`, [acme])).n,
    "· résultat :", (await one(`select outcome from campaign_participants where id = $1`, [part])).outcome);
  await p.goto(`${APP}/?vue=semaine`, { waitUntil: "networkidle" });
  log("   dans Aujourd'hui (7 jours) :", await p.getByText("Préparer le rendez-vous avec [TEST] Acme").count() > 0);

  log("erreurs console :", errors.length ? errors : "aucune");
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
