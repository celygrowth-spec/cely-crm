// Script chargé par les sites qui intègrent une page de réservation (voir embed.ts pour le code à coller).
// Version 1 du contrat : attributs data-cely-rdv / data-url / data-text. Toute évolution doit rester compatible.
//
// Principes :
// - aucun secret, aucune donnée de session : le script ne parle qu'à la page publique /rdv/<lien>/integre ;
// - la réservation se fait DANS le cadre servi par le CRM (même parcours, mêmes contrôles que la page publique) ;
// - isolation : tout l'affichage est dans un Shadow DOM fermé, les styles du site n'y entrent pas et le script
//   ne touche à rien d'autre sur le site (sauf le blocage du défilement pendant que la fenêtre est ouverte, rétabli
//   à la fermeture) ;
// - collé plusieurs fois : une seule initialisation, chaque emplacement fonctionne ;
// - échec ou lenteur : le lien de secours vers la page publique reste disponible.
//
// Écrit en JavaScript simple (pas de littéraux de gabarit) pour fonctionner tel quel dans tous les navigateurs récents.

const SOURCE = String.raw`/*! Cely Growth · widget de réservation · v1 */
(function () {
  "use strict";
  var doc = document, win = window;
  var me = doc.currentScript;
  var ORIGIN;
  try { ORIGIN = new URL(me && me.src ? me.src : "").origin; } catch (e) { return; }
  var KEY = "__celyRdv";
  var all = win[KEY] = win[KEY] || {};
  if (all[ORIGIN]) { all[ORIGIN].scan(); return; }

  var SLUG = /^\/rdv\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
  var TIMEOUT = 15000;
  var DEFAULT_TEXT = "Prendre rendez-vous";
  var seen = new WeakSet();
  var frames = [];
  var floating = false;
  var modal = null;
  var FONT = "font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;";
  var INK = "#1a1128", VIOLET = "#682dfe";

  function pageUrl(raw) {
    try {
      var u = new URL(raw || "", win.location.href);
      if (u.origin !== ORIGIN) return null;
      var m = SLUG.exec(u.pathname);
      return m ? ORIGIN + "/rdv/" + m[1] : null;
    } catch (e) { return null; }
  }
  function cleanText(t) {
    t = String(t || "").replace(/\s+/g, " ").trim().slice(0, 60);
    return t || DEFAULT_TEXT;
  }
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) {
      if (k === "text") el.textContent = attrs[k]; else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }
  function css(text) { return h("style", { text: text }); }
  function shadow(el) {
    try { return el.attachShadow({ mode: "closed" }); } catch (e) { return null; }
  }
  function fallbackLink(url) {
    return h("p", { "class": "fb", hidden: "" }, [
      doc.createTextNode("Le calendrier ne s'affiche pas ? "),
      h("a", { href: url, target: "_blank", rel: "noopener", text: "Ouvrir la page de réservation" })
    ]);
  }
  var COMMON = ".fb{margin:8px 0;font-size:14px;line-height:1.4;color:" + INK + "}.fb a{color:" + VIOLET + ";font-weight:600}" +
    ".ld{position:absolute;z-index:1;left:0;right:0;top:40px;text-align:center;font-size:14px;color:#6b6178}[hidden]{display:none!important}";

  // cadre servi par le CRM ; on n'écoute que ses messages techniques (prêt, hauteur, étape, fermeture)
  function frame(url, mode, handlers) {
    var iframe = h("iframe", {
      src: url + "/integre?mode=" + mode,
      title: "Prendre rendez-vous",
      allow: "clipboard-write",
      referrerpolicy: "strict-origin-when-cross-origin"
    });
    var f = { iframe: iframe, ready: false, on: handlers };
    f.timer = setTimeout(function () { if (!f.ready && handlers.timeout) handlers.timeout(); }, TIMEOUT);
    frames.push(f);
    return f;
  }
  function drop(f) {
    clearTimeout(f.timer);
    var i = frames.indexOf(f);
    if (i >= 0) frames.splice(i, 1);
  }
  win.addEventListener("message", function (e) {
    if (e.origin !== ORIGIN) return;
    var d = e.data;
    if (!d || d.celyRdv !== 1 || typeof d.type !== "string") return;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (f.iframe.contentWindow !== e.source) continue;
      if (d.type === "ready") { f.ready = true; clearTimeout(f.timer); }
      if (f.on[d.type]) f.on[d.type](d);
    }
  });

  function mountInline(el, url) {
    var root = shadow(el);
    if (!root) return;
    var loading = h("div", { "class": "ld", text: "Chargement du calendrier…" });
    var fb = fallbackLink(url);
    var f = frame(url, "inline", {
      ready: function () { loading.hidden = true; fb.hidden = true; f.iframe.style.display = ""; },
      resize: function (d) {
        var px = Math.round(Number(d.height));
        if (px >= 120 && px <= 20000) f.iframe.style.height = px + "px";
      },
      step: function () {
        var r = f.iframe.getBoundingClientRect();
        if (r.top < 0 || r.top > win.innerHeight * 0.6) f.iframe.scrollIntoView({ behavior: "smooth", block: "start" });
      },
      // cadre bloqué ou trop lent : on le replie pour ne pas laisser un grand vide sur le site
      timeout: function () { loading.hidden = true; fb.hidden = false; f.iframe.style.display = "none"; }
    });
    root.appendChild(css(":host{display:block}.w{all:initial;display:block;position:relative;box-sizing:border-box;width:100%;min-width:0;flex:1 1 100%;" + FONT + "}" +
      "iframe{display:block;width:100%;height:640px;border:0;background:transparent;color-scheme:light}" + COMMON));
    root.appendChild(h("div", { "class": "w" }, [fb, loading, f.iframe]));
  }

  var BUTTON = "all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;" +
    "min-height:44px;padding:0 20px;border-radius:999px;background:" + INK + ";color:#fff;cursor:pointer;" +
    FONT + "font-size:15px;font-weight:600;line-height:1.2;text-align:center;box-shadow:0 6px 20px rgba(26,17,40,.25);";

  function mountButton(el, url, text) {
    var root = shadow(el);
    if (!root) return;
    var b = h("button", { type: "button", "class": "b", text: text });
    b.addEventListener("click", function () { open(url, b); });
    root.appendChild(css(":host{display:inline-block}.b{" + BUTTON + "}.b:hover{background:" + VIOLET + "}.b:focus-visible{outline:3px solid " + VIOLET + ";outline-offset:2px}"));
    root.appendChild(b);
  }

  function mountFloating(el, url, text) {
    shadow(el); // masque le lien de secours à l'emplacement du code
    if (floating) return;
    floating = true;
    var host = h("div", { "data-cely-rdv-ui": "floating" });
    var root = shadow(host);
    if (!root) return;
    var b = h("button", { type: "button", "class": "b", text: text });
    b.addEventListener("click", function () { open(url, b); });
    root.appendChild(css(".b{" + BUTTON + "position:fixed;right:20px;bottom:20px;z-index:2147483000;max-width:calc(100vw - 40px)}" +
      ".b:hover{background:" + VIOLET + "}.b:focus-visible{outline:3px solid " + VIOLET + ";outline-offset:2px}" +
      "@media (max-width:480px){.b{right:12px;bottom:12px;max-width:calc(100vw - 24px)}}"));
    root.appendChild(b);
    (doc.body || doc.documentElement).appendChild(host);
  }

  function bindLink(el, url) {
    el.addEventListener("click", function (ev) {
      if (ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      open(url, el);
    });
  }

  // fenêtre unique, réutilisée ; fermer retire le cadre : une réservation non confirmée n'est jamais créée
  function buildModal() {
    var host = h("div", { "data-cely-rdv-ui": "popup" });
    show(host, false);
    var root = shadow(host);
    if (!root) return null;
    var close = h("button", { type: "button", "class": "x", "aria-label": "Fermer", text: "×" });
    var loading = h("div", { "class": "ld", text: "Chargement…" });
    var fbBox = h("div", { "class": "fbw" });
    var panel = h("div", { "class": "pn" }, [loading, fbBox, close]);
    var backdrop = h("div", { "class": "bd" });
    var ov = h("div", { "class": "ov", role: "dialog", "aria-modal": "true", "aria-label": "Prendre rendez-vous" }, [backdrop, panel]);
    root.appendChild(css(".ov{all:initial;position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" + FONT + "}" +
      ".bd{position:absolute;inset:0;background:rgba(26,17,40,.55)}" +
      ".pn{position:relative;width:min(1040px,calc(100vw - 32px));height:min(780px,calc(100% - 32px));background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 24px 64px rgba(26,17,40,.35)}" +
      ".pn iframe{position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;color-scheme:light}" +
      ".x{all:initial;position:absolute;top:10px;right:10px;z-index:2;width:36px;height:36px;border-radius:999px;background:#fff;color:" + INK + ";" +
      "box-shadow:0 1px 4px rgba(26,17,40,.25);cursor:pointer;" + FONT + "font-size:24px;line-height:36px;text-align:center}" +
      ".x:focus-visible{outline:3px solid " + VIOLET + ";outline-offset:2px}" +
      ".fbw{position:absolute;left:24px;right:56px;top:72px;z-index:1;text-align:center}" +
      "@media (max-width:640px){.pn{width:100%;height:100%;border-radius:0}}" + COMMON));
    root.appendChild(ov);
    (doc.body || doc.documentElement).appendChild(host);
    var m = { host: host, panel: panel, loading: loading, fbBox: fbBox, close: close, f: null, trigger: null, overflow: "" };
    close.addEventListener("click", hide);
    backdrop.addEventListener("click", hide);
    return m;
  }
  // style en ligne prioritaire : les règles du site (ex. div{display:flex}) ne réaffichent pas la fenêtre fermée
  function show(el, on) {
    if (on) el.style.removeProperty("display"); else el.style.setProperty("display", "none", "important");
  }
  function onKey(e) { if (e.key === "Escape") hide(); }
  function open(url, trigger) {
    if (modal && modal.f) return;
    modal = modal && modal.host.isConnected ? modal : buildModal();
    if (!modal) { win.open(url, "_blank", "noopener"); return; }
    var m = modal;
    m.trigger = trigger || null;
    m.loading.hidden = false;
    m.fbBox.textContent = "";
    var fb = fallbackLink(url);
    m.fbBox.appendChild(fb);
    m.f = frame(url, "popup", {
      ready: function () { m.loading.hidden = true; fb.hidden = true; },
      close: hide,
      timeout: function () { m.loading.hidden = true; fb.hidden = false; }
    });
    m.panel.insertBefore(m.f.iframe, m.close);
    m.overflow = doc.documentElement.style.overflow;
    doc.documentElement.style.overflow = "hidden";
    show(m.host, true);
    doc.addEventListener("keydown", onKey, true);
    m.close.focus();
  }
  function hide() {
    var m = modal;
    if (!m || !m.f) return;
    drop(m.f);
    if (m.f.iframe.parentNode) m.f.iframe.parentNode.removeChild(m.f.iframe);
    m.f = null;
    show(m.host, false);
    doc.documentElement.style.overflow = m.overflow;
    doc.removeEventListener("keydown", onKey, true);
    if (m.trigger && m.trigger.isConnected && m.trigger.focus) m.trigger.focus();
  }

  function scan() {
    var els = doc.querySelectorAll("[data-cely-rdv]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (seen.has(el)) continue;
      var url = pageUrl(el.getAttribute("data-url") || el.getAttribute("href"));
      if (!url) continue; // code d'une autre installation : laissé à son propre script
      seen.add(el);
      var kind = el.getAttribute("data-cely-rdv");
      var text = cleanText(el.getAttribute("data-text"));
      if (kind === "inline") mountInline(el, url);
      else if (kind === "floating") mountFloating(el, url, text);
      else if (kind === "button") mountButton(el, url, text);
      else if (kind === "popup") bindLink(el, url);
    }
  }

  all[ORIGIN] = { scan: scan, version: 1 };
  var pending = 0;
  function later() { if (!pending) pending = setTimeout(function () { pending = 0; scan(); }, 50); }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", scan); else scan();
  if (win.MutationObserver) new MutationObserver(later).observe(doc.documentElement, { childList: true, subtree: true });
})();
`;

export function widgetScript(): string {
  return SOURCE;
}
