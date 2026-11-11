// Recette finale : accès avec plusieurs comptes et identifiants manipulés. Usage : node tests/e2e/recette-acces.cjs
const { chromium } = require("playwright");
const { context, sql, token } = require("../../scripts/test-env/browser.cjs");
const APP = "http://localhost:3000";
const log = (...a) => console.log(...a);
const one = async (q, p) => (await sql(q, p))[0];
async function rpcAs(who, fn, args) {
  const headers = { "content-type": "application/json", apikey: "test", ...(who === "anon" ? {} : { authorization: `Bearer ${token(who)}` }) };
  const r = await fetch(`http://127.0.0.1:54321/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  return { status: r.status, body: (await r.text()).slice(0, 90) };
}
(async () => {
  const b = await chromium.launch();
  const studio = (await one(`select id from companies where name = '[TEST] Studio Démo'`)).id;
  // 1. Visiteur anonyme : pages renvoyées à la connexion, API refusées
  const anon = await (await b.newContext()).newPage();
  for (const u of ["/", "/ventes", "/finance/revenus", `/fiches/${studio}`, "/parametres/passages"]) {
    await anon.goto(APP + u, { waitUntil: "domcontentloaded" });
    log(`anonyme ${u} →`, new URL(anon.url()).pathname);
  }
  for (const u of ["/api/ventes", "/api/counters", "/api/cron", `/api/pipelines/x/cards`]) log(`anonyme API ${u} →`, (await anon.request.get(APP + u)).status());
  // 2. Compte connecté mais non propriétaire
  const st = await (await context(b, "stranger")).newPage();
  for (const u of ["/", "/finance", `/fiches/${studio}`]) {
    await st.goto(APP + u, { waitUntil: "domcontentloaded" });
    log(`étranger ${u} →`, new URL(st.url()).pathname + new URL(st.url()).search);
  }
  const v = await st.request.get(APP + "/api/ventes");
  log("étranger API /api/ventes →", v.status(), (await v.text()).slice(0, 80), "· /api/cron →", (await st.request.post(APP + "/api/cron")).status());
  for (const [fn, args] of [["sale_confirm", { p_company: studio, p_data: {} }], ["merge_preview", { p_keep: studio, p_merge: studio }], ["finance_add_revenue", { p_data: { company_id: studio, label: "x", kind: "ponctuel", amount: 1, date: "2026-11-11" } }], ["mail_inbound_link", { p_message: studio, p_company: studio }], ["time_stop", {}]]) {
    log(`étranger rpc ${fn} →`, JSON.stringify(await rpcAs("stranger", fn, args)));
  }
  // 3. Propriétaire, identifiants manipulés
  const ow = await (await context(b, "owner")).newPage();
  for (const u of ["/fiches/00000000-0000-0000-0000-00000000dead", "/projets/00000000-0000-0000-0000-00000000dead", "/prospection/doublons/fusion?a=x&b=y"]) {
    const r = await ow.goto(APP + u, { waitUntil: "networkidle" });
    log(`propriétaire ${u} →`, r.status(), ((await ow.locator("main").innerText().catch(() => "")) || "").replace(/\s+/g, " ").slice(0, 70));
  }
  log("propriétaire /api/cron?taches=inexistante →", (await ow.request.post(APP + "/api/cron?taches=inexistante")).status());
  // 4. Fonctions publiques sans la clé serveur
  for (const [fn, args] of [["mail_inbound_ingest", { p_server_key: "x".repeat(40), p_account: studio, p_messages: [] }], ["job_report", { p_server_key: "x".repeat(40), p_job: "agenda", p_ok: true }], ["appt_rate_check", { p_server_key: "x".repeat(40), p_email: "a@b.c", p_ip_hash: "z" }]]) {
    log(`anonyme rpc ${fn} (mauvaise clé) →`, JSON.stringify(await rpcAs("anon", fn, args).catch((e) => String(e))));
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
