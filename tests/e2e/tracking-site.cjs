// Recette de Tracking site dans l'environnement de test local (npm run test-env, avec SITE_TRACKING_ORIGINS
// = http://localhost:4100 et SITE_TRACKING_SECRET). Un faux site local charge le VRAI script de mesure servi par le
// CRM ; contacts fictifs uniquement (example.test). Usage : node tests/e2e/tracking-site.cjs
//
// La réservation en ligne exige un agenda Google connecté, absent de l'environnement de test : le rendez-vous est
// donc créé par les mêmes fonctions que la réservation publique (appt_book puis site_attach_booking), avec la visite
// et le visiteur lus dans le navigateur.
const http = require("node:http");
const { randomUUID, createHash, createHmac } = require("node:crypto");
const { chromium } = require("playwright");
const { context, sql } = require("../../scripts/test-env/browser.cjs");

const APP = "http://localhost:3000", SITE = "http://localhost:4100";
// clé serveur de l'application, dérivée de APPOINTMENTS_SECRET comme le fait src/lib/appointments/secrets.ts
const SECRET = process.env.APPOINTMENTS_SECRET;
if (!SECRET) { console.error("APPOINTMENTS_SECRET manquant : passez la valeur donnée à l'application de test."); process.exit(1); }
const KEY = createHmac("sha256", SECRET).update("cely-appointments:rpc").digest().toString("base64url");
const BOT_SECRET = process.env.SITE_TRACKING_SECRET ?? "secret-robots-local-uniquement-0123";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const run = Date.now().toString(36);
const CAMPAIGN = `e2e-parcours-${run}`;
// nom sans mot commun avec une autre fiche : le CRM crée alors la fiche au lieu de demander à laquelle rattacher
const NAME = `Zq${run.split("").reverse().join("")}`;
let failures = 0;
const check = (label, ok, detail = "") => { console.log(`${ok ? "  ok " : "  ÉCHEC"} ${label}${detail ? ` : ${detail}` : ""}`); if (!ok) failures++; };
const sha = (s) => createHash("sha256").update(s).digest("hex");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (title) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body style="min-height:2400px">
<h1>${title}</h1><nav><a href="/">Accueil</a> <a href="/services">Services</a> <a href="/contact">Contact</a></nav>
<a id="rdv" data-cely-rdv href="${APP}/rdv/appel-decouverte" target="_blank">Prendre rendez-vous</a>
<form id="f" data-cely-form="contact" onsubmit="event.preventDefault()"><input name="email"><button>Envoyer</button></form>
<button data-cely-consent>Gérer mes choix</button>
<script src="${APP}/api/site/mesure.js" async data-cookies-url="/cookies"></script></body></html>`;

async function siteContext(browser) {
  // en local, le CRM et le faux site partagent la même adresse : sans adresse distincte, ces visites seraient
  // écartées comme celles du propriétaire (l'exclusion est vérifiée à part, à l'étape 5)
  const ctx = await browser.newContext({ userAgent: UA, locale: "fr-FR", viewport: { width: 1280, height: 800 }, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.50" } });
  // le script ignore les navigateurs pilotés : la recette se présente comme un navigateur ordinaire
  await ctx.addInitScript(() => Object.defineProperty(navigator, "webdriver", { get: () => false }));
  return ctx;
}
const banner = (p) => p.locator("[data-cely-bandeau]");
const collected = (p) => p.waitForResponse((r) => r.url().includes("/api/site/collect"), { timeout: 15000 });

(async () => {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, SITE).pathname;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page(path === "/" ? "Accueil" : path));
  }).listen(4100);
  const browser = await chromium.launch();
  try {
    await sql(`insert into appt_event_types (name, slug, duration_min, schedule_id, min_notice_min, horizon_days)
               select '[TEST] Appel découverte', 'appel-decouverte', 30, (select id from appt_schedules where is_default), 0, 365
               where not exists (select 1 from appt_event_types where slug = 'appel-decouverte')`);

    console.log("1. Lien du Générateur de liens UTM");
    const owner = await context(browser, "owner");
    // comme en production : la clé serveur de l'application est enregistrée en base (passage lancé par le propriétaire)
    await owner.request.get(`${APP}/api/cron?taches=corbeille`);
    const crm = await owner.newPage();
    await crm.goto(`${APP}/tracking-site?onglet=campagnes`, { waitUntil: "networkidle" });
    const form = crm.locator("[data-utm-builder]");
    await form.getByLabel("Page du site").fill("/services");
    await form.getByLabel("Source").fill("LinkedIn");
    await form.getByLabel("Support").fill("Post");
    await form.getByLabel("Campagne").fill(`E2E Parcours ${run}`);
    await form.getByLabel("Nom lisible du lien").fill(`[TEST] Lien de recette ${run}`);
    const built = await crm.locator("[data-utm-url]").innerText();
    check("convention appliquée sous les yeux de l'utilisateur", built === `https://www.celygrowth.com/services?utm_source=linkedin&utm_medium=post&utm_campaign=${CAMPAIGN}`, built);
    await form.getByRole("button", { name: "Enregistrer" }).click();
    await crm.getByText(`[TEST] Lien de recette ${run}`).first().waitFor({ timeout: 15000 });
    check("lien enregistré avec son nom lisible", (await sql(`select count(*)::int n from site_utm_links where utm_campaign = $1`, [CAMPAIGN]))[0].n === 1);
    const link = built.replace("https://www.celygrowth.com", SITE);

    console.log("2. Visite par ce lien, consentement accepté, retour en direct, rendez-vous");
    const visitor = await siteContext(browser);
    const p1 = await visitor.newPage();
    await Promise.all([collected(p1), p1.goto(link)]);
    await banner(p1).waitFor({ state: "attached", timeout: 10000 });
    const buttons = await p1.evaluate(() => [...document.querySelector("[data-cely-bandeau]").shadowRoot.querySelectorAll("button")].map((b) => ({ t: b.textContent, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })));
    check("bandeau : Refuser et Accepter, deux boutons de même taille", buttons.length === 2 && buttons[0].t === "Refuser" && buttons[1].t === "Accepter" && buttons[0].w === buttons[1].w && buttons[0].h === buttons[1].h, JSON.stringify(buttons));
    check("avant le choix : aucun cookie, aucun identifiant persistant", (await visitor.cookies()).length === 0 && (await p1.evaluate(() => localStorage.getItem("cely_visiteur"))) === null);
    await Promise.all([collected(p1), p1.evaluate(() => document.querySelector("[data-cely-bandeau]").shadowRoot.querySelectorAll("button")[1].click())]);
    const uid = (await p1.evaluate(() => localStorage.getItem("cely_visiteur"))).split("|")[0];
    await p1.evaluate(() => window.scrollTo(0, 1200));
    await wait(700);
    // l'onglet passe à l'arrière-plan : le temps passé et le défilement de la page partent à ce moment-là
    await Promise.all([collected(p1), p1.evaluate(() => { Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true }); document.dispatchEvent(new Event("visibilitychange")); })]);
    await Promise.all([collected(p1), p1.goto(`${SITE}/contact`)]); // changement de page avec rechargement : UTM conservés
    await wait(600);
    const v1 = await p1.evaluate(() => window.cely.visit());
    await p1.close(); // l'onglet fermé, l'identifiant de visite disparaît
    await wait(800);
    const first = (await sql(`select channel, utm_campaign, visitor_id::text, pageviews, entry_page, exit_page, max_scroll from site_visits where id = $1`, [v1]))[0];
    check("visite comptée dans sa campagne, deux pages, UTM conservés d'une page à l'autre", first?.channel === "campaign" && first.utm_campaign === CAMPAIGN && first.pageviews === 2 && first.entry_page === "/services" && first.exit_page === "/contact", JSON.stringify(first));
    check("rattachement commencé à l'acceptation (visiteur relié à la visite en cours)", first?.visitor_id === uid);
    check("profondeur de défilement mesurée", first?.max_scroll > 20, String(first?.max_scroll));

    const p2 = await visitor.newPage(); // retour plus tard, en direct
    await Promise.all([collected(p2), p2.goto(`${SITE}/`)]);
    check("visiteur déjà consentant : pas de nouveau bandeau", (await banner(p2).count()) === 0);
    const v2 = await p2.evaluate(() => window.cely.visit());
    const [popup] = await Promise.all([visitor.waitForEvent("page"), collected(p2), p2.click("#rdv")]);
    const target = new URL(popup.url());
    await popup.close();
    check("lien de réservation : la visite et le visiteur sont transmis", target.searchParams.get("sv") === v2 && target.searchParams.get("su") === uid, target.search);
    await wait(600);
    const second = (await sql(`select channel, visitor_id::text, is_returning, cta_clicks from site_visits where id = $1`, [v2]))[0];
    check("retour en direct : nouvelle visite, visiteur reconnu, clic rendez-vous compté", second?.channel === "direct" && second.visitor_id === uid && second.is_returning === true && second.cta_clicks === 1, JSON.stringify(second));

    // rendez-vous : mêmes fonctions que la réservation publique, contact fictif
    const bid = randomUUID(), email = `lea-${run}@atelier-${run}.example.test`;
    let d = new Date(Date.now() + 14 * 864e5); while (d.getUTCDay() !== 2) d = new Date(d.getTime() + 864e5);
    const book = async (bookingId, key) => (await sql(`select public.appt_book($1, $2, 'appel-decouverte', $3, $4::jsonb, '{"besoin":"Recette Tracking site"}'::jsonb, '[]'::jsonb, false, $5, $6, 10) as r`,
      [KEY, bookingId, `${d.toISOString().slice(0, 10)}T09:00:00Z`, JSON.stringify({ first_name: "Léa", last_name: "Recette", email, company_name: `[TEST] ${NAME}`, timezone: "Europe/Paris" }), sha(`tok-${bookingId}`), key]))[0].r;
    // premier créneau libre (les passages précédents de la recette en occupent)
    let booked = await book(bid, `e2e-${run}`);
    for (let i = 0; booked.status === "unavailable" && i < 40; i++) { d = new Date(d.getTime() + 864e5); if ([0, 6].includes(d.getUTCDay())) continue; booked = await book(bid, `e2e-${run}`); }
    const again = await book(randomUUID(), `e2e-${run}`); // double envoi du formulaire
    check("double envoi : un seul rendez-vous", booked.status === "confirmed" && again.status === "existing" && (await sql(`select count(*)::int n from appt_bookings where email_norm = $1`, [email]))[0].n === 1, `${booked.status} / ${again.status}`);
    const attach = async () => (await sql(`select public.site_attach_booking($1, $2, $3, $4, 'LinkedIn', 'Un post sur le référencement IA') as r`, [KEY, bid, v2, uid]))[0].r;
    check("rendez-vous rattaché une seule fois à sa visite", (await attach()) === "ok" && (await attach()) === "existing");
    const fiche = (await sql(`select c.id::text, c.name, s.name as source from appt_bookings b join companies c on c.id = b.company_id left join lead_sources s on s.id = c.source_id where b.id = $1`, [bid]))[0];
    check("fiche créée, source remplie avec la première source (la campagne LinkedIn)", fiche?.name === `[TEST] ${NAME}` && fiche.source === "LinkedIn", JSON.stringify(fiche));

    console.log("3. La fiche, Aujourd'hui et Tracking site");
    const journey = await (await owner.request.get(`${APP}/api/fiches/${fiche.id}/parcours-site`)).json();
    check("parcours complet : campagne en première source, direct en dernière, deux visites, rendez-vous",
      journey.first?.channel === "campaign" && journey.first.campaign === CAMPAIGN && journey.last?.channel === "direct" && journey.visits.length === 2 && journey.bookings.length === 1 && journey.bookings[0].counted === true,
      JSON.stringify({ first: journey.first, last: journey.last, visits: journey.visits?.length }));
    check("source déclarée affichée à côté de la source mesurée", journey.declared?.[0]?.source === "LinkedIn" && /référencement/.test(journey.declared[0].detail));
    await crm.goto(`${APP}/fiches/${fiche.id}`, { waitUntil: "networkidle" });
    const section = crm.locator("[data-site-journey]");
    await section.getByText("Première source").waitFor({ timeout: 15000 });
    const sectionText = await section.innerText();
    check("section Parcours site de la fiche", /Campagne · linkedin \/ e2e-parcours/.test(sectionText) && /Direct/.test(sectionText) && /Rendez-vous confirmé/.test(sectionText) && /LinkedIn/.test(sectionText));
    await crm.screenshot({ path: process.env.SHOTS ? `${process.env.SHOTS}/fiche-parcours.png` : "/dev/null", fullPage: true }).catch(() => undefined);

    // le prospect revient deux jours après son rendez-vous, sur une page d'offre
    await sql(`update site_attributions set converted_at = now() - interval '2 days' where booking_id = $1`, [bid]);
    await sql(`update site_visits set started_at = started_at - interval '2 days' where id = any($1::uuid[])`, [`{${v1},${v2}}`]);
    const p3 = await visitor.newPage();
    await Promise.all([collected(p3), p3.goto(`${SITE}/services`)]);
    await wait(700);
    await p3.close();
    await crm.goto(`${APP}/`, { waitUntil: "networkidle" });
    const home = await crm.locator("body").innerText();
    check("Aujourd'hui : signal de retour sur une page à forte intention, avec lien vers la fiche", home.includes(`[TEST] ${NAME} est revenu sur le site (/services) : forte intention`) && (await crm.locator(`a[href="/fiches/${fiche.id}"]`).count()) > 0);
    const today = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
    const camp = await (await owner.request.get(`${APP}/api/tracking/campaigns?from=${from}&to=${today}&campaign=${CAMPAIGN}`)).json();
    const row = camp.campaigns.find((c) => c.campaign === CAMPAIGN), lk = camp.links.find((l) => l.utm_campaign === CAMPAIGN);
    check("Tracking site : la campagne et son lien (visites, pages, rendez-vous en première source)", row?.visits === 1 && row.pageviews === 2 && row.bookings_first === 1 && lk?.visits === 1, JSON.stringify({ row, lien: lk && { visits: lk.visits } }));
    const prospects = await (await owner.request.get(`${APP}/api/tracking/prospects?from=${from}&to=${today}`)).json();
    const pr = prospects.prospects.find((x) => x.company_id === fiche.id);
    check("Tracking site : le prospect, sa première et sa dernière source, ses visites", pr?.first.channel === "campaign" && pr.last.channel === "direct" && pr.visits === 3 && pr.booking_status === "confirmed", JSON.stringify(pr && { first: pr.first, last: pr.last, visits: pr.visits }));

    console.log("4. Consentement refusé, puis retiré");
    const anon = await siteContext(browser);
    const a1 = await anon.newPage();
    await Promise.all([collected(a1), a1.goto(`${SITE}/services?UTM_Source=Linked-In&utm_medium=POST&utm_campaign=E2E%20Refus%20${run}`)]);
    await banner(a1).waitFor({ state: "attached" });
    await a1.evaluate(() => document.querySelector("[data-cely-bandeau]").shadowRoot.querySelectorAll("button")[0].click());
    const va = await a1.evaluate(() => window.cely.visit());
    await Promise.all([collected(a1), a1.goto(`${SITE}/contact`)]);
    await wait(600);
    const refused = (await sql(`select channel, utm_source, utm_campaign, utm_raw, visitor_id, pageviews from site_visits where id = $1`, [va]))[0];
    check("refus : visite comptée dans sa campagne, UTM normalisés, valeur d'origine gardée, aucun identifiant",
      refused?.channel === "campaign" && refused.utm_source === "linkedin" && refused.utm_campaign === `e2e-refus-${run}` && refused.utm_raw?.utm_source === "Linked-In" && refused.visitor_id === null && refused.pageviews === 2, JSON.stringify(refused));
    check("refus : rien d'identifiant dans le navigateur", (await a1.evaluate(() => localStorage.getItem("cely_visiteur"))) === null && (await anon.cookies()).length === 0);
    // refusé puis accepté : le rattachement commence à l'acceptation
    await a1.click("[data-cely-consent]");
    await banner(a1).waitFor({ state: "attached" });
    await Promise.all([collected(a1), a1.evaluate(() => document.querySelector("[data-cely-bandeau]").shadowRoot.querySelectorAll("button")[1].click())]);
    await wait(500);
    const uid2 = (await a1.evaluate(() => localStorage.getItem("cely_visiteur"))).split("|")[0];
    check("refusé puis accepté : la visite en cours reçoit l'identifiant", (await sql(`select visitor_id::text from site_visits where id = $1`, [va]))[0].visitor_id === uid2);
    await Promise.all([collected(a1), a1.evaluate(() => window.cely.consent.refuse())]);
    await wait(500);
    check("consentement retiré : identifiant supprimé partout, visite toujours comptée mais anonyme",
      (await a1.evaluate(() => localStorage.getItem("cely_visiteur"))) === null && (await sql(`select count(*)::int n from site_visitors where id = $1`, [uid2]))[0].n === 0
      && (await sql(`select visitor_id from site_visits where id = $1`, [va]))[0].visitor_id === null);

    console.log("5. Sécurité du point de collecte");
    const api = owner.request;
    const ev = (o = {}) => JSON.stringify({ t: "pv", v: randomUUID(), p: randomUUID(), path: "/", ...o });
    const post = (body, headers = {}) => api.post(`${APP}/api/site/collect`, { data: body, headers: { "content-type": "text/plain", origin: SITE, "user-agent": UA, ...headers } });
    check("origine inconnue refusée", (await post(ev(), { origin: "https://pirate.example" })).status() === 403);
    check("événement mal formé refusé", (await post(JSON.stringify({ t: "pv", v: "x" }))).status() === 400 && (await post("pas du json")).status() === 400);
    check("chemin avec paramètres refusé (pas de donnée personnelle dans l'adresse)", (await post(ev({ path: "/contact?email=a@b.fr" }))).status() === 400);
    check("charge trop lourde refusée", [400, 413].includes((await post(ev({ q: "x".repeat(6000) }))).status()));
    const before = (await sql(`select count(*)::int n from site_visits`))[0].n;
    await post(ev(), { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" });
    check("robot : jamais compté comme une visite humaine", (await sql(`select count(*)::int n from site_visits`))[0].n === before);
    // mes propres visites : la connexion d'où j'utilise le CRM est écartée
    await api.get(`${APP}/api/counters`, { headers: { "x-forwarded-for": "198.51.100.7" } });
    await wait(400);
    await post(ev(), { "x-forwarded-for": "198.51.100.7" });
    await post(ev(), { "x-forwarded-for": "198.51.100.8" });
    check("visites du propriétaire exclues, celles d'une autre connexion comptées", (await sql(`select count(*)::int n from site_visits`))[0].n === before + 1);
    check("aucune adresse IP en base", (await sql(`select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name like 'site\\_%' and column_name ~ '(^|_)ip$'`))[0].n === 0);
    const bot = (headers, body) => api.post(`${APP}/api/site/bot`, { data: body, headers });
    check("signalement de robot sans secret refusé", (await bot({}, { ua: "GPTBot", path: "/" })).status() === 401 && (await bot({ authorization: "Bearer mauvais-secret-mauvais-secret-00" }, { ua: "GPTBot", path: "/" })).status() === 401);
    const path = `/e2e-${run}`;
    await bot({ authorization: `Bearer ${BOT_SECRET}` }, { ua: "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)", path, ip: "203.0.113.9" });
    await bot({ authorization: `Bearer ${BOT_SECRET}` }, { ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", path, ip: "203.0.113.9" });
    const bots = await sql(`select bot, status from site_bot_hits where path = $1 order by bot`, [path]);
    check("robot au nom connu venu d'une adresse non publiée : non vérifié ; éditeur sans liste : non vérifiable",
      bots.length === 2 && bots[0].bot === "ClaudeBot" && bots[0].status === "unverifiable" && bots[1].bot === "GPTBot" && ["unverified", "unverifiable"].includes(bots[1].status), JSON.stringify(bots));

    console.log("6. Deuxième compte et identifiants manipulés");
    const stranger = await context(browser, "stranger");
    const s = stranger.request;
    for (const url of [`/api/tracking/overview?from=${from}&to=${today}`, `/api/tracking/prospects?from=${from}&to=${today}`, `/api/tracking/live`, `/api/fiches/${fiche.id}/parcours-site`]) {
      const r = await s.get(`${APP}${url}`);
      check(`autre compte refusé : ${url.split("?")[0]}`, r.status() === 403 && !(await r.text()).includes(NAME));
    }
    const sp = await stranger.newPage();
    await sp.goto(`${APP}/tracking-site`, { waitUntil: "networkidle" });
    check("autre compte : l'espace ne montre aucune donnée", !(await sp.locator("body").innerText()).includes(CAMPAIGN) && (await sp.locator("[data-kpis]").count()) === 0);
    const other = await (await api.get(`${APP}/api/fiches/${randomUUID()}/parcours-site`)).json();
    check("identifiant de fiche inventé : parcours vide", other.first === null && other.visits.length === 0);
    check("fiche mal formée ou période démesurée : refusées", (await api.get(`${APP}/api/fiches/1%20or%201=1/parcours-site`)).status() === 400 && (await api.get(`${APP}/api/tracking/overview?from=2000-01-01&to=${today}`)).status() === 400
      && (await api.get(`${APP}/api/tracking/overview?from=${from}&to=${today}&channel=${encodeURIComponent("x' or '1'='1")}`)).status() === 400);
    const anonReq = await (await browser.newContext()).request.get(`${APP}/api/tracking/overview?from=${from}&to=${today}`);
    check("sans session : refusé", anonReq.status() === 401);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failures ? `\n${failures} vérification(s) en échec` : "\nToutes les vérifications passent.");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
