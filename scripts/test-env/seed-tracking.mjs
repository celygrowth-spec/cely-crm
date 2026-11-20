// Jeu de données fictives de Tracking site : 12 mois réalistes (toutes sources, campagnes UTM, IA, rendez-vous,
// robots, mots-clés) pour vérifier les courbes. ENVIRONNEMENT DE TEST UNIQUEMENT : le script parle au point
// /debug/sql de la base locale (scripts/test-env/server.mjs), qui n'existe nulle part ailleurs.
//
//   node scripts/test-env/seed-tracking.mjs               crée le jeu (remplace un jeu précédent)
//   node scripts/test-env/seed-tracking.mjs --supprimer   le supprime d'une seule commande
//
// Tout est marqué demo = true ; les fiches créées s'appellent « [TEST] … » et portent l'étiquette tracking-demo.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.TEST_DB_PORT ?? 54321);
const here = dirname(fileURLToPath(import.meta.url));

async function sql(q, params) {
  const r = await fetch(`http://127.0.0.1:${PORT}/debug/sql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sql: q, params }) });
  if (!r.ok) throw new Error(`Base de test injoignable ou requête refusée (${r.status}) : ${await r.text()}`);
  return r.json();
}
const DELETE = readFileSync(join(here, "..", "..", "supabase", "maintenance", "delete-tracking-demo.sql"), "utf8")
  .split("\n").filter((l) => !/^\s*(--|begin;|commit;)/.test(l)).join("\n").split(";").map((s) => s.trim()).filter(Boolean);

async function remove() {
  for (const stmt of DELETE) await sql(stmt);
}

// --- hasard reproductible : le même jeu à chaque lancement ---
let state = 20261125;
const rnd = () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
const pick = (weighted) => { let r = rnd() * weighted.reduce((s, [, w]) => s + w, 0); for (const [v, w] of weighted) { if ((r -= w) <= 0) return v; } return weighted[0][0]; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const uuid = () => { const h = () => Math.floor(rnd() * 65536).toString(16).padStart(4, "0"); return `${h()}${h()}-${h()}-4${h().slice(1)}-8${h().slice(1)}-${h()}${h()}${h()}`; };

const DAY = 86_400_000;
const PAGES = [["/", 30], ["/services", 14], ["/services/offre-decouverte", 9], ["/growth", 8], ["/contact", 7], ["/audit", 5], ["/audit/audit-marketing-digital", 5],
  ["/comparatif-growth-marketing", 4], ["/actualites", 4], ["/actualites/referencement-ia", 6], ["/actualites/inbound-vs-outbound", 4], ["/actualites/framework-aarrr", 3], ["/manifeste", 2], ["/nous-rejoindre", 1]];
const COUNTRIES = [["FR", 76], ["BE", 6], ["CH", 5], ["CA", 4], ["US", 3], ["MA", 2], ["DE", 1], ["ES", 1], ["GB", 1], ["LU", 1]];
const CAMPAIGNS = [
  { c: "lancement-offre-decouverte", s: "linkedin", m: "post", from: 300, to: 250, daily: 9, raw: { utm_source: "LinkedIn", utm_campaign: "Lancement Offre Découverte" } },
  { c: "newsletter-octobre", s: "newsletter", m: "email", from: 60, to: 46, daily: 7 },
  { c: "dirigeants-pme", s: "prospection", m: "email", from: 140, to: 20, daily: 2.2 },
  { c: "webinaire-ia", s: "linkedin", m: "social", from: 34, to: 6, daily: 6 },
  { c: "mail-direct", s: "email", m: "email", from: 365, to: 0, daily: 0.7 },
  { c: "signature", s: "signature", m: "email", from: 365, to: 0, daily: 0.5 },
];
const SOURCES = {
  organic: [["google", 82], ["bing", 11], ["duckduckgo", 4], ["ecosia", 2], ["qwant", 1]],
  ai: [["chatgpt", 52], ["perplexity", 22], ["claude", 10], ["gemini", 9], ["copilot", 5], ["mistral", 2]],
  social: [["linkedin", 78], ["facebook", 8], ["x", 6], ["youtube", 5], ["instagram", 3]],
  email: [["mail.google.com", 70], ["outlook.live.com", 30]],
  referral: [["malt.fr", 30], ["welcometothejungle.com", 22], ["blog.exemple-partenaire.fr", 20], ["annuaire-growth.example", 16], ["notion.site", 12]],
  paid: [["google", 80], ["linkedin", 20]],
};
const HOST = { google: "google.com", bing: "bing.com", duckduckgo: "duckduckgo.com", ecosia: "ecosia.org", qwant: "qwant.com", chatgpt: "chatgpt.com", perplexity: "perplexity.ai", claude: "claude.ai",
  gemini: "gemini.google.com", copilot: "copilot.microsoft.com", mistral: "chat.mistral.ai", linkedin: "linkedin.com", facebook: "facebook.com", x: "t.co", youtube: "youtube.com", instagram: "instagram.com" };
// part de chaque source selon l'ancienneté (0 = aujourd'hui, 1 = il y a un an) : l'IA et la recherche montent
const mix = (age) => [["direct", 24], ["organic", 22 + 16 * (1 - age)], ["social", 15], ["ai", 1.5 + 13 * (1 - age) ** 1.6], ["referral", 7], ["email", 4], ["paid", age < 0.25 ? 3 : 0.3]];
const CONV = { direct: 0.008, organic: 0.011, social: 0.007, ai: 0.019, referral: 0.012, email: 0.016, paid: 0.006, campaign: 0.017 };
const DECLARED = { organic: "Recherche Google", social: "LinkedIn", ai: "ChatGPT ou une autre IA", email: "Email reçu", campaign: "LinkedIn", referral: "Recommandation", direct: "Recommandation", paid: "Recherche Google" };

async function insert(table, cols, rows) {
  for (let i = 0; i < rows.length; i += 800) {
    const chunk = rows.slice(i, i + 800);
    await sql(`insert into public.${table} (${cols.map(([c]) => c).join(", ")})
      select ${cols.map(([c]) => c).join(", ")} from jsonb_to_recordset($1::jsonb) as x(${cols.map(([c, t]) => `${c} ${t}`).join(", ")})`, [JSON.stringify(chunk)]);
  }
}

async function create() {
  await remove();
  const now = Date.now();
  const visitors = [], visits = [], pageviews = [], events = [], attributions = [];
  const known = []; // visiteurs consentants susceptibles de revenir

  const addVisit = (at, v) => {
    const id = uuid();
    const n = pick([[1, 46], [2, 24], [3, 14], [4, 8], [6, 5], [9, 3]]);
    const entry = v.entry ?? pick(v.channel === "ai" ? [["/actualites/referencement-ia", 34], ["/growth", 16], ["/comparatif-growth-marketing", 14], ...PAGES] : PAGES);
    let t = at, duration = 0, scroll = 0, path = entry;
    const seen = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) path = pick(i === n - 1 && rnd() < 0.3 ? [["/contact", 5], ["/services/offre-decouverte", 5]] : PAGES);
      const d = int(6, path.startsWith("/actualites/") ? 260 : 110), s = int(18, 100);
      pageviews.push({ id: uuid(), visit_id: id, at: new Date(t).toISOString(), path, duration_s: d, scroll_pct: s });
      seen.push(path); duration += d; scroll = Math.max(scroll, s); t += (d + 2) * 1000;
    }
    const intent = seen.some((p) => /services|contact|audit/.test(p));
    const cta = rnd() < (intent ? 0.2 : 0.03);
    if (cta) events.push({ id: uuid(), visit_id: id, at: new Date(t).toISOString(), kind: "cta", path, label: "Prendre rendez-vous" });
    const form = !cta && seen.includes("/contact") && rnd() < 0.12;
    if (form) events.push({ id: uuid(), visit_id: id, at: new Date(t).toISOString(), kind: "form", path: "/contact", label: "contact" });
    const row = {
      id, visitor_id: v.visitor ?? null, started_at: new Date(at).toISOString(), last_seen_at: new Date(t).toISOString(), channel: v.channel, source: v.source ?? null,
      referrer_host: v.host ?? null, utm_source: v.utm?.s ?? null, utm_medium: v.utm?.m ?? null, utm_campaign: v.utm?.c ?? null, utm_raw: v.utm?.raw ?? null,
      country: pick(COUNTRIES), device: pick(v.channel === "social" ? [["mobile", 62], ["desktop", 34], ["tablet", 4]] : [["desktop", 58], ["mobile", 37], ["tablet", 5]]),
      browser: pick([["Chrome", 54], ["Safari", 27], ["Edge", 9], ["Firefox", 7], ["Samsung Internet", 3]]), entry_page: entry, exit_page: path,
      is_returning: !!v.returning, pageviews: n, duration_s: duration, max_scroll: scroll, cta_clicks: cta ? 1 : 0, forms: form ? 1 : 0, demo: true,
    };
    visits.push(row);
    return { row, cta, end: t };
  };

  for (let d = 365; d >= 0; d--) {
    const age = d / 365;
    const day = now - d * DAY;
    const weekday = new Date(day).getUTCDay();
    const base = (14 + 26 * (1 - age)) * (weekday === 0 || weekday === 6 ? 0.45 : 1) * (0.8 + rnd() * 0.4);
    const plan = [];
    for (let i = 0; i < Math.round(base); i++) plan.push({ channel: pick(mix(age)) });
    for (const k of CAMPAIGNS) {
      if (d > k.from || d < k.to) continue;
      // une campagne démarre fort puis s'essouffle
      const decay = k.daily >= 5 ? Math.max(0.15, 1 - (k.from - d) / Math.max(k.from - k.to, 1)) : 1;
      const count = Math.floor(k.daily * decay * (0.6 + rnd() * 0.8) + rnd());
      for (let i = 0; i < count; i++) plan.push({ channel: "campaign", utm: k });
    }
    for (const p of plan) {
      const at = day - int(0, 86_000) * 1000 + (d === 0 ? -3600_000 : 0);
      const v = { channel: p.channel };
      if (p.utm) { v.utm = p.utm; v.source = p.utm.s; v.host = p.utm.s === "linkedin" ? "linkedin.com" : null; }
      else if (SOURCES[p.channel]) { v.source = pick(SOURCES[p.channel]); v.host = HOST[v.source] ?? v.source; }
      // un visiteur consentant déjà venu revient parfois, le plus souvent en direct
      if (known.length > 20 && rnd() < 0.09) {
        const back = known[int(0, known.length - 1)];
        v.visitor = back.id; v.returning = true;
        if (!p.utm && rnd() < 0.6) { v.channel = "direct"; v.source = null; v.host = null; }
      } else if (rnd() < 0.3) {
        v.visitor = uuid();
        visitors.push({ id: v.visitor, first_seen_at: new Date(at).toISOString(), last_seen_at: new Date(at).toISOString(), expires_at: new Date(at + 395 * DAY).toISOString(), demo: true });
        known.push({ id: v.visitor, first: null });
      }
      const { row, cta, end } = addVisit(at, v);
      const k = v.visitor ? known.find((x) => x.id === v.visitor) : null;
      if (k && !k.first) k.first = row;
      if (rnd() < CONV[row.channel] * (cta ? 9 : 0.35) * (v.returning ? 2.2 : 1)) {
        const first = k?.first ?? row;
        attributions.push({
          id: uuid(), visit_id: row.id, visitor_id: row.visitor_id, converted_at: new Date(end + 90_000).toISOString(), first_visit_id: first.id, first_at: first.started_at,
          first_channel: first.channel, first_source: first.source, first_campaign: first.utm_campaign, first_medium: first.utm_medium,
          last_channel: row.channel, last_source: row.source, last_campaign: row.utm_campaign, last_medium: row.utm_medium, entry_page: first.entry_page,
          visits_before: v.returning ? int(1, 4) : 0,
          declared_source: rnd() < 0.7 ? (rnd() < 0.72 ? DECLARED[first.channel] : pick([["Recommandation", 3], ["LinkedIn", 3], ["Recherche Google", 2], ["Autre", 1]])) : null,
          declared_detail: null, company_id: null, person_id: null, demo: true,
        });
        events.push({ id: uuid(), visit_id: row.id, at: new Date(end + 90_000).toISOString(), kind: "booking", path: row.exit_page, label: "Rendez-vous confirmé" });
      }
    }
  }

  // --- fiches fictives : les douze derniers rendez-vous de visiteurs consentants ont une fiche ---
  const names = ["Atelier Lumen", "Maison Verdier", "Studio Orka", "Boréal Conseil", "Cabinet Halden", "Nova Fabrique", "Pixel & Pain", "Groupe Solène", "Atlas Mobilier", "Rivage Santé", "Kairn Énergie", "Les Ateliers Mirel"];
  const people = ["Léa", "Hugo", "Nina", "Paul", "Inès", "Marc", "Zoé", "Tom", "Sarah", "Louis", "Emma", "Jules"];
  const withFiche = attributions.filter((a) => a.visitor_id).slice(-12);
  for (const [i, a] of withFiche.entries()) {
    const [c] = await sql(`insert into public.companies (name, website, tags) values ($1, $2, '{tracking-demo}') returning id`, [`[TEST] ${names[i]}`, `demo-${i + 1}.example.test`]);
    const [p] = await sql(`insert into public.people (company_id, first_name, last_name, email, is_primary) values ($1, $2, 'Test', $3, true) returning id`, [c.id, people[i], `${people[i].toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")}@demo-${i + 1}.example.test`]);
    a.company_id = c.id; a.person_id = p.id;
    if (i === 0) a.declared_detail = "Un post de Célien sur le référencement dans les IA";
  }
  // l'un d'eux est revenu hier sur une page d'offre : signal dans Aujourd'hui
  const back = withFiche.at(-3);
  if (back) {
    addVisit(now - 20 * 3600_000, { channel: "direct", visitor: back.visitor_id, returning: true, entry: "/services/offre-decouverte" });
    visits.at(-1).demo = true;
  }
  // quelques visiteurs en ce moment (compteur En direct)
  for (let i = 0; i < 4; i++) {
    const { row } = addVisit(now - int(20, 200) * 1000, { channel: pick([["organic", 2], ["ai", 1], ["direct", 1]]), source: "google", host: "google.com" });
    row.last_seen_at = new Date(now - int(5, 90) * 1000).toISOString();
  }

  await insert("site_visitors", [["id", "uuid"], ["first_seen_at", "timestamptz"], ["last_seen_at", "timestamptz"], ["expires_at", "timestamptz"], ["demo", "boolean"]], visitors);
  await insert("site_visits", [["id", "uuid"], ["visitor_id", "uuid"], ["started_at", "timestamptz"], ["last_seen_at", "timestamptz"], ["channel", "text"], ["source", "text"], ["referrer_host", "text"],
    ["utm_source", "text"], ["utm_medium", "text"], ["utm_campaign", "text"], ["utm_raw", "jsonb"], ["country", "text"], ["device", "text"], ["browser", "text"], ["entry_page", "text"], ["exit_page", "text"],
    ["is_returning", "boolean"], ["pageviews", "int"], ["duration_s", "int"], ["max_scroll", "smallint"], ["cta_clicks", "int"], ["forms", "int"], ["demo", "boolean"]], visits);
  await insert("site_pageviews", [["id", "uuid"], ["visit_id", "uuid"], ["at", "timestamptz"], ["path", "text"], ["duration_s", "int"], ["scroll_pct", "smallint"]], pageviews);
  await insert("site_events", [["id", "uuid"], ["visit_id", "uuid"], ["at", "timestamptz"], ["kind", "text"], ["path", "text"], ["label", "text"]], events);
  await insert("site_attributions", [["id", "uuid"], ["visit_id", "uuid"], ["visitor_id", "uuid"], ["converted_at", "timestamptz"], ["first_visit_id", "uuid"], ["first_at", "timestamptz"],
    ["first_channel", "text"], ["first_source", "text"], ["first_campaign", "text"], ["first_medium", "text"], ["last_channel", "text"], ["last_source", "text"], ["last_campaign", "text"], ["last_medium", "text"],
    ["entry_page", "text"], ["visits_before", "int"], ["declared_source", "text"], ["declared_detail", "text"], ["company_id", "uuid"], ["person_id", "uuid"], ["demo", "boolean"]], attributions);

  // --- liens du générateur ---
  await insert("site_utm_links", [["name", "text"], ["path", "text"], ["utm_source", "text"], ["utm_medium", "text"], ["utm_campaign", "text"], ["url", "text"], ["created_at", "timestamptz"], ["demo", "boolean"]], [
    ["Post LinkedIn · lancement de l'offre découverte", "/services/offre-decouverte", "linkedin", "post", "lancement-offre-decouverte", 300],
    ["Newsletter d'octobre", "/actualites/referencement-ia", "newsletter", "email", "newsletter-octobre", 60],
    ["Prospection dirigeants de PME", "/growth", "prospection", "email", "dirigeants-pme", 140],
    ["Invitation au webinaire IA", "/actualites/referencement-ia", "linkedin", "social", "webinaire-ia", 34],
    ["Signature de mail", "/", "signature", "email", "signature", 365],
    ["Carte de visite (QR code)", "/contact", "qr-code", "print", "salon-growth-2026", 12],
  ].map(([name, path, s, m, c, age]) => ({ name, path, utm_source: s, utm_medium: m, utm_campaign: c, url: `https://www.celygrowth.com${path}?utm_source=${s}&utm_medium=${m}&utm_campaign=${c}`, created_at: new Date(now - age * DAY).toISOString(), demo: true })));

  // --- robots : passages quotidiens par page, les robots d'IA de plus en plus présents ---
  const BOTS = [["Googlebot", "search", 9, false], ["Bingbot", "search", 4, false], ["GPTBot", "ai", 3, true], ["OAI-SearchBot", "ai", 2, true], ["ChatGPT-User", "ai", 1.5, true],
    ["ClaudeBot", "ai", 2, true], ["PerplexityBot", "ai", 1.6, true], ["Applebot", "search", 0.8, false], ["Meta-ExternalAgent", "ai", 0.7, true], ["AhrefsBot", "other", 2, false]];
  const hits = new Map();
  for (let d = 365; d >= 0; d--) {
    const day = new Date(now - d * DAY).toISOString().slice(0, 10);
    for (const [bot, kind, rate, grows] of BOTS) {
      const count = Math.floor(rate * (grows ? 0.25 + 1.6 * (1 - d / 365) : 1) * (0.5 + rnd()) + rnd() * 0.6);
      for (let i = 0; i < count; i++) {
        // /manifeste et /nous-rejoindre ne sont jamais lues par les robots d'IA (recommandation à vérifier)
        const path = pick(kind === "ai" ? PAGES.filter(([p]) => p !== "/manifeste" && p !== "/nous-rejoindre") : PAGES);
        const status = ["ClaudeBot", "Meta-ExternalAgent", "Applebot", "AhrefsBot"].includes(bot) ? "unverifiable" : rnd() < 0.04 ? "unverified" : "verified";
        const key = `${day}|${bot}|${status}|${path}`;
        const h = hits.get(key) ?? { day, bot, kind, status, path, hits: 0, last_at: `${day}T${String(int(0, 23)).padStart(2, "0")}:15:00Z`, demo: true };
        h.hits++; hits.set(key, h);
      }
    }
  }
  await insert("site_bot_hits", [["day", "date"], ["bot", "text"], ["kind", "text"], ["status", "text"], ["path", "text"], ["hits", "int"], ["last_at", "timestamptz"], ["demo", "boolean"]], [...hits.values()]);

  // --- mots-clés : Search Console (page × requête, 12 mois) et Bing (niveaux requête, page, site) ---
  const QUERIES = [
    ["growth marketing temps partagé", "/growth", 6, 3.2, -1.2], ["head of growth freelance", "/growth", 11, 7.5, -2.5], ["agence growth pme", "/services", 9, 12.4, -4.5],
    ["audit marketing digital", "/audit/audit-marketing-digital", 14, 8.8, -2], ["référencement ia", "/actualites/referencement-ia", 10, 6.1, -3.5], ["être cité par chatgpt", "/actualites/referencement-ia", 5, 9.5, -5],
    ["inbound vs outbound", "/actualites/inbound-vs-outbound", 12, 14.2, -1], ["framework aarrr", "/actualites/framework-aarrr", 18, 11.3, 0.5], ["cely growth", "/", 4, 1.1, 0],
    ["growth marketing vs marketing digital", "/comparatif-growth-marketing", 8, 9.7, -3], ["offre découverte growth", "/services/offre-decouverte", 2, 4.4, -1.5], ["consultant growth lyon", "/", 3, 16.5, -2],
    ["prospection b2b linkedin", "/actualites/inbound-vs-outbound", 7, 21, 1.5], ["stratégie acquisition pme", "/services", 6, 13.6, -6], ["geo generative engine optimization", "/actualites/referencement-ia", 4, 7.2, -4],
  ];
  const seo = [];
  for (let d = 365; d >= 2; d--) {
    const day = new Date(now - d * DAY).toISOString().slice(0, 10);
    const progress = 1 - d / 365;
    let bc = 0, bi = 0;
    for (const [query, page, volume, pos0, drift] of QUERIES) {
      const position = Math.max(1, pos0 - drift * (1 - progress) + (rnd() - 0.5) * 1.6);
      const impressions = Math.max(0, Math.round(volume * (0.5 + progress) * (0.5 + rnd())));
      if (!impressions) continue;
      const ctr = position <= 3 ? 0.22 : position <= 6 ? 0.08 : position <= 10 ? 0.035 : 0.008;
      const clicks = Math.min(impressions, Math.floor(impressions * ctr * (0.4 + rnd() * 1.2) + rnd() * 0.5));
      seo.push({ provider: "gsc", day, page, query, clicks, impressions, position: Number(position.toFixed(2)), demo: true });
      // Bing : données hebdomadaires, volumes plus faibles, niveau requête uniquement pour les premières
      if (new Date(now - d * DAY).getUTCDay() === 1 && rnd() < 0.7) {
        const bImp = Math.max(1, Math.round(impressions * 1.4)), bClk = Math.floor(clicks * 0.9 + rnd() * 0.6);
        seo.push({ provider: "bing", day, page: "", query, clicks: bClk, impressions: bImp, position: Number((position + 1.5).toFixed(2)), demo: true });
        bc += bClk; bi += bImp;
      }
    }
    if (bi) seo.push({ provider: "bing", day, page: "", query: "", clicks: bc, impressions: bi, position: null, demo: true });
  }
  await insert("seo_daily", [["provider", "text"], ["day", "date"], ["page", "text"], ["query", "text"], ["clicks", "int"], ["impressions", "int"], ["position", "numeric"], ["demo", "boolean"]], seo);

  console.log(`Jeu fictif créé : ${visits.length} visites, ${pageviews.length} pages vues, ${attributions.length} rendez-vous, ${hits.size} lignes de robots, ${seo.length} lignes de mots-clés.`);
  console.log("Suppression : node scripts/test-env/seed-tracking.mjs --supprimer");
}

if (process.argv.includes("--supprimer")) {
  await remove();
  console.log("Jeu fictif de Tracking site supprimé.");
} else {
  await create();
}
