// Widgets de réservation : codes à coller, script d'intégration, et seule exception à l'interdiction d'encadrement.
import { describe, expect, test } from "vitest";
import vm from "node:vm";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { buildCustomRoute } = require("next/dist/lib/build-custom-route") as {
  buildCustomRoute: (type: "header", route: { source: string; headers: { key: string; value: string }[] }) => { regex: string };
};
import nextConfig from "../../next.config";
import { DEFAULT_BUTTON_TEXT, embedCode, cleanButtonText } from "@/lib/appointments/embed";
import { widgetScript } from "@/lib/appointments/widget-script";

const BASE = "https://crm.example.test";

describe("codes d'intégration", () => {
  test("les trois formats pointent vers la page publique et le script, sans aucun secret", () => {
    for (const kind of ["inline", "floating", "button", "popup"] as const) {
      const code = embedCode(kind, { baseUrl: BASE + "/", slug: "appel-decouverte", text: "Réserver" });
      expect(code).toContain(`data-cely-rdv="${kind}"`);
      expect(code).toContain(`${BASE}/rdv/appel-decouverte`);
      expect(code).toContain(`<script src="${BASE}/api/rdv/widget.js" async></script>`);
      // lien de secours toujours présent : sans script, on arrive sur la page publique
      expect(code).toMatch(/<a href="https:\/\/crm\.example\.test\/rdv\/appel-decouverte"/);
      expect(code).not.toMatch(/key|token|secret|session|cookie/i);
    }
  });

  test("le texte du bouton est échappé, nettoyé et limité", () => {
    const code = embedCode("floating", { baseUrl: BASE, slug: "a", text: `"><img src=x onerror=alert(1)>` });
    expect(code).not.toContain("<img");
    expect(code).toContain("&quot;&gt;&lt;img");
    expect(cleanButtonText("   ")).toBe(DEFAULT_BUTTON_TEXT);
    expect(cleanButtonText("a".repeat(200))).toHaveLength(60);
    expect(embedCode("inline", { baseUrl: BASE, slug: "a" })).not.toContain("data-text");
  });
});

describe("encadrement par un autre site", () => {
  async function frameHeader(path: string): Promise<string | null> {
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[];
    let value: string | null = null;
    for (const r of rules) {
      const { regex } = buildCustomRoute("header", r);
      if (!new RegExp(regex, "i").test(path)) continue;
      for (const h of r.headers) if (h.key === "X-Frame-Options") value = h.value;
    }
    return value;
  }

  test("seule la page de réservation intégrable peut s'afficher dans un autre site", async () => {
    expect(await frameHeader("/rdv/appel-decouverte/integre")).toBeNull();
    for (const p of [
      "/", "/login", "/rendez-vous", "/rendez-vous/types", "/prospection", "/fiches/123", "/portail", "/portail/x",
      "/rdv/appel-decouverte", "/rdv/gerer/abc", "/rdv/appel-decouverte/integre/autre", "/rdv/integre",
      "/api/rdv/book", "/api/rdv/widget.js", "/api/mcp", "/oauth/authorize", "/rdv/a/integre-x",
    ]) {
      expect(await frameHeader(p), p).toBe("DENY");
    }
  });

  test("la page intégrable garde les autres protections", async () => {
    const rules = (await nextConfig.headers!()) as { source: string; headers: { key: string; value: string }[] }[];
    const keys = rules
      .filter((r) => new RegExp(buildCustomRoute("header", r).regex, "i").test("/rdv/a/integre"))
      .flatMap((r) => r.headers.map((h) => h.key));
    expect(keys).toEqual(expect.arrayContaining(["X-Content-Type-Options", "Referrer-Policy"]));
  });
});

// Mini-document : suffisant pour vérifier le chargement unique et le filtrage des adresses.
function fakeWindow(elements: { attrs: Record<string, string> }[]) {
  const listeners: Record<string, number> = {};
  const els = elements.map((e) => ({
    getAttribute: (k: string) => e.attrs[k] ?? null,
    attachShadow: () => { (e as { mounted?: boolean }).mounted = true; return { appendChild() {} }; },
    addEventListener: () => { (e as { bound?: boolean }).bound = true; },
  }));
  const node = () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: { setProperty() {}, removeProperty() {} }, textContent: "" });
  const document = {
    currentScript: { src: `${BASE}/api/rdv/widget.js` },
    readyState: "complete",
    querySelectorAll: () => els,
    createElement: node,
    createTextNode: () => ({}),
    addEventListener() {},
    documentElement: { style: {}, appendChild() {} },
    body: { appendChild() {} },
  };
  const window: Record<string, unknown> = {
    location: { href: "https://site-client.example.test/contact" },
    addEventListener: (t: string) => { listeners[t] = (listeners[t] ?? 0) + 1; },
  };
  return { ctx: vm.createContext({ window, document, URL, WeakSet, setTimeout, clearTimeout, Math, Number, String, Object }), listeners, elements };
}

describe("script d'intégration", () => {
  test("collé deux fois : une seule initialisation, chaque emplacement monté une fois", () => {
    const elements: { attrs: Record<string, string> }[] = [
      { attrs: { "data-cely-rdv": "inline", "data-url": `${BASE}/rdv/a` } },
      { attrs: { "data-cely-rdv": "popup", href: `${BASE}/rdv/a` } },
      // autre installation, adresse étrangère ou page autre que /rdv/<lien> : ignorés
      { attrs: { "data-cely-rdv": "inline", "data-url": "https://autre.example.test/rdv/a" } },
      { attrs: { "data-cely-rdv": "inline", "data-url": `${BASE}/rendez-vous` } },
    ];
    const { ctx, listeners } = fakeWindow(elements);
    vm.runInContext(widgetScript(), ctx);
    vm.runInContext(widgetScript(), ctx);
    expect(listeners.message).toBe(1);
    const state = elements as { mounted?: boolean; bound?: boolean }[];
    expect(state[0].mounted).toBe(true);
    expect(state[1].bound).toBe(true);
    expect(state[2].mounted).toBeUndefined();
    expect(state[3].mounted).toBeUndefined();
  });

  test("n'écoute que les messages du CRM et ne lit ni cookies ni stockage", () => {
    const src = widgetScript();
    expect(src).toContain("e.origin !== ORIGIN");
    expect(src).not.toMatch(/document\.cookie|localStorage|sessionStorage|fetch\(|XMLHttpRequest|innerHTML|eval\(/);
    expect(() => new vm.Script(src)).not.toThrow();
  });
});
