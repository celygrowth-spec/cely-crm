// Carte des connecteurs : modèle (nœuds, états, sens, outils déclarés) et disposition lisible avec une quinzaine
// de nœuds. Aucune donnée réelle : connecteurs et clients fictifs.
import { describe, expect, test } from "vitest";
import { SIZE, VIEW, buildMap, layout, type MapInput } from "@/lib/connectors/map-model";
import type { Connector, ConnectorKey, ConnectorState } from "@/lib/connectors/types";

const NOW = Date.parse("2026-11-18T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3600e3).toISOString();

function connector(key: ConnectorKey | string, state: ConnectorState, extra: Partial<Connector> = {}): Connector {
  return {
    key: key as ConnectorKey, name: String(key), usage: "", state, account: null, lastSuccess: null, problem: null, note: null,
    primary: { kind: "manage", label: "Gérer" }, lastCheck: null, feeds: [], permissions: [], settings: [], links: [], canVerify: false,
    reconnectHref: null, disconnect: null, external: null, ...extra,
  };
}

const grant = (clientId: string, name: string) => ({ clientId, name, scopes: [], grantedAt: hoursAgo(200) });
const claude = (grants: ReturnType<typeof grant>[] | null, state: ConnectorState = grants?.length ? "connected" : "not_connected") =>
  connector("claude_mcp", state, { mcp: { url: "", auth: "", grants, grantsError: null, lastWrite: null, shared: false } });

const base = (over: Partial<MapInput> = {}): MapInput => ({
  now: NOW,
  connectors: [
    connector("gmail", "connected", { lastSuccess: { at: hoursAgo(2), label: "Dernier envoi réussi" } }),
    connector("google_calendar", "reconnect"),
    connector("fireflies", "sync_error"),
    claude([grant("cid-ai-1111", "Claude"), grant("cid-code-2222", "Claude")]),
    connector("ubersuggest", "claude"),
  ],
  mcpClients: [
    { clientId: "cid-ai-1111", name: "claude-ai", version: "0.1.0", firstSeenAt: hoursAgo(100), lastSeenAt: hoursAgo(1), calls: 40 },
    { clientId: "cid-code-2222", name: "claude-code", version: null, firstSeenAt: hoursAgo(90), lastSeenAt: hoursAgo(72), calls: 3 },
  ],
  unknownHistoryAt: null,
  lemlist: { total: 0, connected: 0, reconnect: 0, lastOkAt: null },
  tools: [],
  ...over,
});

describe("buildMap", () => {
  test("le CRM au centre, un nœud par connecteur, trois états seulement, sens des échanges", () => {
    const nodes = buildMap(base());
    const by = (id: string) => nodes.find((n) => n.id === id)!;
    expect(nodes[0]).toMatchObject({ id: "core", kind: "core", state: null });
    expect(by("connector:gmail")).toMatchObject({ state: "connected", direction: "out", live: true });
    expect(by("connector:google_calendar")).toMatchObject({ state: "reconnect", direction: "both", detail: null });
    expect(by("connector:fireflies")).toMatchObject({ state: "reconnect", direction: "in", detail: "Erreur de synchronisation" });
    expect(by("connector:ubersuggest")).toMatchObject({ state: "not_connected", direction: "none", sublabel: "Via Claude, hors CRM" });
    expect(by("connector:lemlist")).toMatchObject({ state: "not_connected" });
    expect(nodes.every((n) => n.state === null || ["connected", "reconnect", "not_connected"].includes(n.state))).toBe(true);
    expect(nodes.find((n) => n.id === "connector:claude_mcp")).toBeUndefined();
  });

  test("deux Claude distincts : un nœud chacun, nom lisible, suffixe court, activité propre", () => {
    const mcp = buildMap(base()).filter((n) => n.kind === "mcp");
    expect(mcp.map((n) => n.label)).toEqual(["Claude …1111", "Claude …2222"]);
    expect(mcp[0]).toMatchObject({ sublabel: "claude-ai 0.1.0 · …1111", state: "connected", live: true });
    expect(mcp[1]).toMatchObject({ sublabel: "claude-code · …2222", state: "connected", live: false });
    // jamais l'identifiant complet affiché
    expect(mcp.every((n) => !n.label.includes("cid-") && !(n.sublabel ?? "").includes("cid-"))).toBe(true);
  });

  test("accès retiré : le client suivi reste visible, Non connecté", () => {
    const nodes = buildMap(base({ connectors: [claude([grant("cid-ai-1111", "Claude")])] }));
    expect(nodes.find((n) => n.id === "mcp:cid-code-2222")).toMatchObject({ state: "not_connected", detail: "Accès retiré", live: false });
  });

  test("historique MCP sans information de client : nœud « Client MCP inconnu »", () => {
    const nodes = buildMap(base({ unknownHistoryAt: hoursAgo(500) }));
    expect(nodes.find((n) => n.id === "mcp:unknown")).toMatchObject({ label: "Client MCP inconnu", state: "not_connected" });
  });

  test("aucun client ni accès : un nœud Claude · MCP, Non connecté", () => {
    const nodes = buildMap(base({ connectors: [claude([])], mcpClients: [] }));
    expect(nodes.filter((n) => n.icon === "claude")).toMatchObject([{ id: "connector:claude_mcp", state: "not_connected" }]);
  });

  test("connecteur jamais configuré : gris, Non connecté ; connecteur inconnu de la carte : affiché quand même", () => {
    const nodes = buildMap(base({ connectors: [connector("gmail", "not_connected"), connector("make", "connected")] }));
    expect(nodes.find((n) => n.id === "connector:gmail")).toMatchObject({ state: "not_connected", live: false });
    expect(nodes.find((n) => n.id === "connector:make")).toMatchObject({ icon: "make", direction: "both" });
  });

  test("Make → Tiime déclarés : pointillés, parent respecté ; parent déconnecté : lien grisé", () => {
    const tools = [
      { id: "11111111-1111-4111-8111-111111111111", parentKey: "connector:google_calendar", parentTool: null, name: "Make", createdAt: hoursAgo(5) },
      { id: "22222222-2222-4222-8222-222222222222", parentKey: null, parentTool: "11111111-1111-4111-8111-111111111111", name: "Tiime", createdAt: hoursAgo(4) },
      { id: "33333333-3333-4333-8333-333333333333", parentKey: "connector:gmail", parentTool: null, name: "Notion", createdAt: hoursAgo(3) },
      { id: "44444444-4444-4444-8444-444444444444", parentKey: "mcp:disparu", parentTool: null, name: "Orphelin", createdAt: hoursAgo(3) },
    ];
    const nodes = buildMap(base({ tools }));
    const tiime = nodes.find((n) => n.label === "Tiime")!;
    expect(tiime).toMatchObject({ kind: "declared", parent: "tool:11111111-1111-4111-8111-111111111111", direction: "declared", depth: 3, dimmed: true });
    expect(nodes.find((n) => n.label === "Make")).toMatchObject({ dimmed: true, depth: 2 }); // Google Agenda à reconnecter
    expect(nodes.find((n) => n.label === "Notion")).toMatchObject({ dimmed: false });
    expect(nodes.find((n) => n.label === "Orphelin")).toMatchObject({ parent: "core", sublabel: "Parent introuvable, rattaché au CRM" });
  });
});

describe("layout", () => {
  test("une quinzaine de nœuds : tous dans le cadre, sans chevauchement", () => {
    const tools = [
      { id: "11111111-1111-4111-8111-111111111111", parentKey: "mcp:cid-ai-1111", parentTool: null, name: "Make", createdAt: hoursAgo(5) },
      { id: "22222222-2222-4222-8222-222222222222", parentKey: null, parentTool: "11111111-1111-4111-8111-111111111111", name: "Tiime", createdAt: hoursAgo(4) },
      { id: "33333333-3333-4333-8333-333333333333", parentKey: null, parentTool: "11111111-1111-4111-8111-111111111111", name: "Qonto", createdAt: hoursAgo(4) },
      { id: "55555555-5555-4555-8555-555555555555", parentKey: "core", parentTool: null, name: "Notion", createdAt: hoursAgo(3) },
      { id: "66666666-6666-4666-8666-666666666666", parentKey: "connector:gmail", parentTool: null, name: "Zapier", createdAt: hoursAgo(2) },
    ];
    const nodes = buildMap(base({ tools, unknownHistoryAt: hoursAgo(500), connectors: [...base().connectors, connector("make", "connected")] }));
    expect(nodes.length).toBeGreaterThanOrEqual(14);
    const pos = layout(nodes);
    for (const n of nodes) {
      const p = pos.get(n.id)!;
      expect(p.x - SIZE.node.w / 2).toBeGreaterThanOrEqual(0);
      expect(p.x + SIZE.node.w / 2).toBeLessThanOrEqual(VIEW.w);
      expect(p.y - SIZE.node.h / 2).toBeGreaterThanOrEqual(0);
      expect(p.y + SIZE.node.h / 2).toBeLessThanOrEqual(VIEW.h);
    }
    const overlaps: string[] = [];
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = pos.get(nodes[i].id)!, b = pos.get(nodes[j].id)!;
        const w = (nodes[i].kind === "core" || nodes[j].kind === "core" ? (SIZE.core.w + SIZE.node.w) / 2 : SIZE.node.w);
        const h = (nodes[i].kind === "core" || nodes[j].kind === "core" ? (SIZE.core.h + SIZE.node.h) / 2 : SIZE.node.h);
        if (Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < h) overlaps.push(`${nodes[i].label} / ${nodes[j].label}`);
      }
    expect(overlaps).toEqual([]);
  });
});
