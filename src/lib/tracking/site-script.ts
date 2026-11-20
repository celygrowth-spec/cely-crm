// Script de mesure chargé par celygrowth.com : <script src="{CRM}/api/site/mesure.js" async></script>
//
// Principes :
// - léger, chargé en différé, aucun effet visible sur l'affichage ; un bloqueur de publicité peut l'empêcher de
//   se charger : la perte est acceptée, rien ne cherche à le contourner ;
// - avant consentement : ni cookie ni identifiant persistant. La visite a un identifiant aléatoire gardé dans
//   sessionStorage (effacé à la fermeture de l'onglet) pour relier ses pages et conserver ses UTM ;
// - après consentement : un identifiant de visiteur dans localStorage, conservé 13 mois au plus, sans prolongation ;
// - refuser est aussi simple qu'accepter (deux boutons identiques), le choix se modifie à tout moment
//   (window.cely.consent.open() ou tout élément portant data-cely-consent) ;
// - seul le chemin de la page est envoyé (jamais les paramètres de l'adresse, hors UTM et identifiants de clic).
//
// Écrit en JavaScript simple (pas de littéraux de gabarit) pour fonctionner tel quel dans tous les navigateurs récents.

const SOURCE = String.raw`/*! Cely Growth · mesure d'audience · v1 */
(function () {
  "use strict";
  var win = window, doc = document, nav = navigator;
  if (win.__celyMesure) return;
  win.__celyMesure = 1;
  var me = doc.currentScript;
  var ORIGIN;
  try { ORIGIN = new URL(me && me.src ? me.src : "").origin; } catch (e) { return; }
  var ENDPOINT = ORIGIN + "/api/site/collect";
  var COOKIES_URL = (me && me.getAttribute("data-cookies-url")) || "/cookies";

  // navigateurs pilotés et robots : jamais comptés
  if (nav.webdriver || /bot\b|bot\/|crawl|spider|headless|lighthouse|pagespeed|preview/i.test(nav.userAgent || "")) return;

  // --- stockage : toujours protégé (navigation privée, stockage bloqué) ---
  function get(store, k) { try { return win[store].getItem(k); } catch (e) { return null; } }
  function set(store, k, v) { try { win[store].setItem(k, v); return true; } catch (e) { return false; } }
  function del(store, k) { try { win[store].removeItem(k); } catch (e) {} }
  function uuid() {
    try { if (win.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    var b = new Uint8Array(16), h = "", i;
    try { crypto.getRandomValues(b); } catch (e) { for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256); }
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    for (i = 0; i < 16; i++) { h += (b[i] + 256).toString(16).slice(1); if (i === 3 || i === 5 || i === 7 || i === 9) h += "-"; }
    return h;
  }

  // --- exclusion de cet appareil : https://www.celygrowth.com/?cely_exclure=1 (0 pour annuler) ---
  var qs;
  try { qs = new URLSearchParams(win.location.search); } catch (e) { qs = null; }
  if (qs && qs.get("cely_exclure") === "1") set("localStorage", "cely_exclu", "1");
  if (qs && qs.get("cely_exclure") === "0") del("localStorage", "cely_exclu");
  if (get("localStorage", "cely_exclu") === "1") {
    win.cely = { excluded: true, track: function () {}, consent: { open: function () {}, accept: function () {}, refuse: function () {}, state: function () { return "exclu"; } } };
    return;
  }

  // --- consentement et identifiant de visiteur (13 mois au plus, jamais prolongé) ---
  var MONTHS_13 = 395 * 86400000, MONTHS_6 = 183 * 86400000;
  function readConsent() {
    var raw = get("localStorage", "cely_consent");
    if (!raw) return null;
    var p = raw.split("|"), at = Number(p[1]);
    if (!at || Date.now() - at > (p[0] === "oui" ? MONTHS_13 : MONTHS_6)) { del("localStorage", "cely_consent"); del("localStorage", "cely_visiteur"); return null; }
    return p[0] === "oui" ? "oui" : "non";
  }
  function visitorId() {
    if (readConsent() !== "oui") return null;
    var raw = get("localStorage", "cely_visiteur");
    if (!raw) return null;
    var p = raw.split("|");
    if (!/^[0-9a-f-]{36}$/.test(p[0]) || Date.now() - Number(p[1]) > MONTHS_13) { del("localStorage", "cely_visiteur"); del("localStorage", "cely_consent"); return null; }
    return p[0];
  }

  // --- visite : 30 minutes d'inactivité ou une nouvelle campagne en ouvrent une autre ---
  var IDLE = 30 * 60000;
  var KEEP = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "gbraid", "wbraid", "msclkid", "li_fat_id", "ttclid"];
  function landingQuery() {
    var out = [];
    if (!qs) return "";
    qs.forEach(function (value, name) {
      var n = name.toLowerCase();
      if (KEEP.indexOf(n) >= 0 && value) out.push(n + "=" + encodeURIComponent(n.indexOf("utm_") === 0 ? String(value).slice(0, 150) : "1"));
    });
    return out.join("&").slice(0, 900);
  }
  function externalReferrer() {
    try {
      var r = doc.referrer;
      if (!r) return "";
      var u = new URL(r);
      if (u.hostname === win.location.hostname) return "";
      return (u.protocol + "//" + u.hostname).slice(0, 200);
    } catch (e) { return ""; }
  }
  var memory = null;
  function loadVisit() {
    var raw = get("sessionStorage", "cely_visite");
    if (raw) { try { return JSON.parse(raw); } catch (e) {} }
    return memory;
  }
  function saveVisit(v) { memory = v; set("sessionStorage", "cely_visite", JSON.stringify(v)); }
  function currentVisit() {
    var now = Date.now(), v = loadVisit(), q = landingQuery();
    var hasUtm = q.indexOf("utm_") >= 0;
    if (!v || !v.id || now - v.t > IDLE || (hasUtm && q !== v.q)) {
      v = { id: uuid(), t: now, q: q, r: externalReferrer() };
    }
    v.t = now;
    saveVisit(v);
    return v;
  }

  // --- envoi : sendBeacon (ne bloque rien, part même à la fermeture de la page) ---
  function send(data) {
    var v = currentVisit();
    data.v = v.id;
    var u = visitorId();
    if (u) data.u = u;
    var body = JSON.stringify(data);
    try {
      if (nav.sendBeacon && nav.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }))) return;
    } catch (e) {}
    try { fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, mode: "cors", credentials: "omit", headers: { "Content-Type": "text/plain" } }).catch(function () {}); } catch (e) {}
  }

  // --- page vue, temps passé (onglet visible uniquement) et profondeur de défilement ---
  var page = null;
  function path() {
    var p = win.location.pathname || "/";
    if (p.length > 1) p = p.replace(/\/+$/, "");
    return p.slice(0, 300) || "/";
  }
  function scrollPct() {
    var el = doc.documentElement, body = doc.body || el;
    var full = Math.max(el.scrollHeight, body.scrollHeight) - win.innerHeight;
    if (full <= 0) return 100;
    return Math.max(0, Math.min(100, Math.round(((win.pageYOffset || el.scrollTop || 0) / full) * 100)));
  }
  function visibleNow() { return doc.visibilityState !== "hidden"; }
  function elapsed() {
    if (!page) return 0;
    return Math.round((page.ms + (page.since ? Date.now() - page.since : 0)) / 1000);
  }
  function flush() {
    if (!page) return;
    var d = elapsed();
    if (d === page.sentD && page.scroll === page.sentS) return;
    page.sentD = d; page.sentS = page.scroll;
    send({ t: "pe", p: page.id, path: page.path, d: Math.min(d, 3600), s: page.scroll });
  }
  function pageview() {
    if (page) flush();
    var v = currentVisit();
    page = { id: uuid(), path: path(), ms: 0, since: visibleNow() ? Date.now() : 0, scroll: 0, sentD: -1, sentS: -1, beats: 0 };
    send({ t: "pv", p: page.id, path: page.path, q: v.q || undefined, r: v.r || undefined });
    setTimeout(function () { if (page) page.scroll = Math.max(page.scroll, scrollPct()); }, 800);
  }
  var scrollTick = 0;
  win.addEventListener("scroll", function () {
    if (scrollTick) return;
    scrollTick = setTimeout(function () { scrollTick = 0; if (page) page.scroll = Math.max(page.scroll, scrollPct()); }, 250);
  }, { passive: true });
  doc.addEventListener("visibilitychange", function () {
    if (!page) return;
    if (visibleNow()) { page.since = Date.now(); }
    else { if (page.since) { page.ms += Date.now() - page.since; page.since = 0; } flush(); }
  });
  win.addEventListener("pagehide", function () {
    if (page && page.since) { page.ms += Date.now() - page.since; page.since = 0; }
    flush();
  });
  // présence : un signal par minute tant que l'onglet est visible (20 au plus par page)
  setInterval(function () { if (page && visibleNow() && page.beats < 20) { page.beats++; flush(); } }, 60000);

  // navigation sans rechargement (Next.js) : une page vue par changement de chemin
  var lastPath = null;
  function route() {
    var p = path();
    if (p === lastPath) return;
    lastPath = p;
    pageview();
  }
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    if (typeof original !== "function") return;
    history[name] = function () {
      var out = original.apply(this, arguments);
      setTimeout(route, 0);
      return out;
    };
  });
  win.addEventListener("popstate", function () { setTimeout(route, 0); });
  // page restaurée depuis le cache du navigateur (retour arrière)
  win.addEventListener("pageshow", function (e) { if (e.persisted) { lastPath = null; route(); } });

  // --- événements : clic vers la prise de rendez-vous, formulaire envoyé, rendez-vous confirmé ---
  var recent = {};
  function once(key, ms) {
    var now = Date.now();
    if (recent[key] && now - recent[key] < ms) return false;
    recent[key] = now;
    return true;
  }
  function text(el) { return String((el && (el.getAttribute("data-cely-label") || el.textContent)) || "").replace(/\s+/g, " ").trim().slice(0, 80); }
  function track(kind, opts) {
    opts = opts || {};
    if (kind !== "cta" && kind !== "form" && kind !== "booking") return;
    var data = { t: kind, e: uuid(), path: path(), label: opts.label ? String(opts.label).slice(0, 80) : undefined };
    if (kind === "form") {
      if (opts.declared) data.ds = String(opts.declared).slice(0, 60);
      if (opts.detail) data.dd = String(opts.detail).slice(0, 300);
      // l'adresse ne part que si le visiteur a consenti au suivi : sinon le formulaire reste anonyme ici
      if (opts.email && visitorId()) data.em = String(opts.email).slice(0, 254);
    }
    send(data);
  }
  function bookingLink(a) {
    try {
      var u = new URL(a.href, win.location.href);
      return u.origin === ORIGIN && /^\/rdv\//.test(u.pathname) ? u : null;
    } catch (e) { return null; }
  }
  doc.addEventListener("click", function (e) {
    var el = e.target && e.target.closest ? e.target.closest("a[href],button,[data-cely-rdv],[data-cely-track]") : null;
    if (!el) return;
    if (el.closest("[data-cely-consent]")) { e.preventDefault(); openBanner(); return; }
    var link = el.tagName === "A" ? bookingLink(el) : null;
    var marked = el.closest("[data-cely-rdv],[data-cely-track='rdv']");
    if (!link && !marked) return;
    if (link) {
      // la page de réservation reçoit la visite (et le visiteur s'il a consenti) pour y rattacher le rendez-vous
      var v = currentVisit(), u = visitorId();
      link.searchParams.set("sv", v.id);
      if (u) link.searchParams.set("su", u); else link.searchParams.delete("su");
      el.href = link.toString();
    }
    if (once("cta:" + path() + ":" + text(el), 1500)) track("cta", { label: text(el) || "Prendre rendez-vous" });
  }, true);
  doc.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM" || f.hasAttribute("data-cely-ignore")) return;
    var name = f.getAttribute("data-cely-form") || f.getAttribute("name") || f.id || "formulaire";
    if (once("form:" + path() + ":" + name, 10000)) track("form", { label: name });
  }, true);
  // cadre de réservation du CRM : il demande la visite en cours, puis annonce le rendez-vous confirmé
  win.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.celyRdv !== 1 || typeof d.type !== "string") return;
    if (d.type === "ready" || d.type === "step") {
      try { e.source.postMessage({ celyMesure: 1, visit: currentVisit().id, visitor: visitorId() }, ORIGIN); } catch (err) {}
    }
    if (d.type === "booked" && once("booking", 60000)) track("booking", { label: "Rendez-vous confirmé" });
  });

  // --- bandeau de consentement : sobre, deux boutons identiques, isolé dans un Shadow DOM ---
  var banner = null;
  function closeBanner() { if (banner) { banner.remove(); banner = null; } }
  function accept() {
    var now = Date.now(), had = visitorId();
    set("localStorage", "cely_consent", "oui|" + now);
    if (!had) set("localStorage", "cely_visiteur", uuid() + "|" + now);
    closeBanner();
    // le rattachement commence à l'acceptation : la visite en cours reçoit l'identifiant
    if (visitorId()) send({ t: "consent" });
  }
  function refuse() {
    var had = visitorId();
    if (had) send({ t: "withdraw" }); // part avec l'identifiant, qui est supprimé juste après
    del("localStorage", "cely_visiteur");
    set("localStorage", "cely_consent", "non|" + Date.now());
    closeBanner();
  }
  function openBanner() {
    if (banner || !doc.body) return;
    banner = doc.createElement("div");
    banner.setAttribute("data-cely-bandeau", "");
    var root;
    try { root = banner.attachShadow({ mode: "open" }); } catch (e) { root = banner; }
    var style = doc.createElement("style");
    style.textContent =
      ":host{all:initial}" +
      ".b{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;margin:0 auto;max-width:560px;box-sizing:border-box;" +
      "padding:16px 18px;border-radius:16px;background:#fff;color:#1a1128;border:1px solid #ddd3f0;box-shadow:0 12px 40px rgba(26,17,40,.16);" +
      "font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif}" +
      ".t{margin:0 0 4px;font-weight:700;font-size:15px}.p{margin:0 0 12px;color:#4b4359}.p a{color:#682dfe}" +
      ".a{display:flex;gap:10px}.a button{flex:1;min-height:42px;padding:8px 12px;border-radius:10px;border:1px solid #1a1128;background:#fff;color:#1a1128;" +
      "font:600 14px/1.2 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;cursor:pointer}" +
      ".a button:hover{background:#f4f0fb}.a button:focus-visible{outline:2px solid #682dfe;outline-offset:2px}" +
      "@media (prefers-color-scheme:dark){.b{background:#1d1630;color:#f3effa;border-color:#3a2f55}.p{color:#c9c1da}.p a{color:#b79bff}" +
      ".a button{background:#1d1630;color:#f3effa;border-color:#f3effa}.a button:hover{background:#2a2142}}";
    var box = doc.createElement("div");
    box.className = "b";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Mesure d'audience");
    var title = doc.createElement("p"); title.className = "t"; title.textContent = "Mesure d'audience";
    var copy = doc.createElement("p"); copy.className = "p";
    copy.appendChild(doc.createTextNode("Ce site compte ses visites de façon anonyme, sans cookie. Acceptez-vous qu'un identifiant, conservé 13 mois au plus, reconnaisse vos visites successives ? Aucune donnée n'est transmise à un tiers. "));
    var more = doc.createElement("a"); more.href = COOKIES_URL; more.textContent = "En savoir plus";
    copy.appendChild(more);
    var actions = doc.createElement("div"); actions.className = "a";
    var no = doc.createElement("button"); no.type = "button"; no.textContent = "Refuser"; no.addEventListener("click", refuse);
    var yes = doc.createElement("button"); yes.type = "button"; yes.textContent = "Accepter"; yes.addEventListener("click", accept);
    actions.appendChild(no); actions.appendChild(yes);
    box.appendChild(title); box.appendChild(copy); box.appendChild(actions);
    root.appendChild(style); root.appendChild(box);
    doc.body.appendChild(banner);
  }

  win.cely = {
    track: track,
    visit: function () { return currentVisit().id; },
    visitor: visitorId,
    consent: { open: openBanner, accept: accept, refuse: refuse, state: function () { return readConsent(); } }
  };

  function start() {
    route();
    if (readConsent() === null) openBanner();
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
})();
`;

export function siteScript(): string {
  return SOURCE;
}
