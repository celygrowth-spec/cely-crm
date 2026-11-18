// Carte des connecteurs : modèle pur (nœuds, liens, disposition), partagé serveur et navigateur.
// Il ne fait que réorganiser ce que l'espace Connecteurs sait déjà (états, dates) ; aucun jeton ni secret n'y passe.
// Les identifiants de clients MCP sont des identifiants publics de clients OAuth : seul un suffixe court s'affiche.
import { STATE_LABEL, type Connector, type ConnectorState } from "./types";

export type MapState = "connected" | "reconnect" | "not_connected";
export const MAP_STATE_LABEL: Record<MapState, string> = { connected: "Connecté", reconnect: "À reconnecter", not_connected: "Non connecté" };

/** Sens des échanges, vu du CRM. */
export type Direction = "in" | "out" | "both" | "none" | "declared";
export const DIRECTION_LABEL: Record<Direction, string> = {
  in: "Vers le CRM",
  out: "Depuis le CRM",
  both: "Dans les deux sens",
  none: "Aucun échange avec le CRM",
  declared: "Déclaré à la main : le CRM ne voit pas ces échanges",
};

export type MapIcon = "core" | "gmail" | "google_calendar" | "fireflies" | "claude" | "ubersuggest" | "lemlist" | "make" | "unknown" | "tool";

export type MapNode = {
  /** core · connector:<clé> · mcp:<client_id> · mcp:unknown · tool:<uuid> */
  id: string;
  kind: "core" | "connector" | "mcp" | "declared";
  label: string;
  sublabel: string | null;
  icon: MapIcon;
  state: MapState | null; // null : le CRM lui-même, ou un outil déclaré (état invisible)
  /** état précis de l'espace Connecteurs, quand il diffère des trois états de la carte */
  detail: string | null;
  lastActivity: { at: string; label: string } | null;
  direction: Direction;
  parent: string | null;
  href: string | null;
  /** lien actif dans les dernières 24 h */
  live: boolean;
  /** outil déclaré dont un parent n'est pas connecté : lien grisé */
  dimmed: boolean;
  feeds: string[];
  toolId: string | null;
  depth: number;
};

export type McpClientRow = { clientId: string; name: string | null; version: string | null; firstSeenAt: string; lastSeenAt: string; calls: number };
export type DeclaredTool = { id: string; parentKey: string | null; parentTool: string | null; name: string; createdAt: string };
export type LemlistSummary = { total: number; connected: number; reconnect: number; lastOkAt: string | null };

export type MapInput = {
  now: number;
  connectors: Connector[];
  /** null : lecture impossible */
  mcpClients: McpClientRow[] | null;
  /** dernière écriture de Claude antérieure au suivi des clients (aucune information de client) */
  unknownHistoryAt: string | null;
  lemlist: LemlistSummary | null;
  tools: DeclaredTool[];
};

export const LIVE_MS = 24 * 3600 * 1000;
export const MAX_DECLARED = 25;

const DIRECTION: Record<string, Direction> = {
  gmail: "out",
  google_calendar: "both",
  fireflies: "in",
  ubersuggest: "none",
  make: "both",
};
const ICONS: Record<string, MapIcon> = { gmail: "gmail", google_calendar: "google_calendar", fireflies: "fireflies", ubersuggest: "ubersuggest", make: "make" };

/** Les sept états de l'espace Connecteurs ramenés aux trois de la carte ; l'état précis reste dans `detail`. */
export function toMapState(s: ConnectorState): MapState {
  if (s === "connected") return "connected";
  if (s === "not_connected" || s === "claude") return "not_connected";
  return "reconnect";
}

const shortId = (id: string) => `…${id.replace(/[^A-Za-z0-9]/g, "").slice(-4)}`;
const isLive = (at: string | null | undefined, state: MapState | null, now: number) =>
  !!at && state === "connected" && now - Date.parse(at) >= -60_000 && now - Date.parse(at) < LIVE_MS;

function connectorActivity(c: Connector): MapNode["lastActivity"] {
  const ok = c.lastCheck?.ok ? { at: c.lastCheck.at, label: "Dernière vérification réussie" } : null;
  if (c.lastSuccess && (!ok || c.lastSuccess.at >= ok.at)) return c.lastSuccess;
  return ok;
}

export function buildMap(input: MapInput): MapNode[] {
  const { now } = input;
  const nodes: MapNode[] = [{
    id: "core", kind: "core", label: "Cely Growth", sublabel: "CRM", icon: "core", state: null, detail: null, lastActivity: null,
    direction: "none", parent: null, href: null, live: false, dimmed: false, feeds: [], toolId: null, depth: 0,
  }];

  for (const c of input.connectors) {
    if (c.key === "claude_mcp") continue; // remplacé par un nœud par client MCP
    const state = toMapState(c.state);
    const lastActivity = connectorActivity(c);
    nodes.push({
      id: `connector:${c.key}`, kind: "connector", label: c.name, sublabel: c.state === "claude" ? "Via Claude, hors CRM" : c.account, icon: ICONS[c.key] ?? "unknown",
      state, detail: STATE_LABEL[c.state] !== MAP_STATE_LABEL[state] ? STATE_LABEL[c.state] : null,
      lastActivity, direction: DIRECTION[c.key] ?? "both", parent: "core", href: `/parametres/connecteurs?gerer=${c.key}`,
      live: isLive(lastActivity?.at, state, now), dimmed: false, feeds: c.feeds, toolId: null, depth: 1,
    });
  }

  if (input.lemlist) {
    const l = input.lemlist;
    const state: MapState = l.connected > 0 && l.reconnect === 0 ? "connected" : l.reconnect > 0 ? "reconnect" : "not_connected";
    const lastActivity = l.lastOkAt ? { at: l.lastOkAt, label: "Dernière lecture réussie" } : null;
    nodes.push({
      id: "connector:lemlist", kind: "connector", label: "lemlist", sublabel: l.total ? `${l.total} compte${l.total > 1 ? "s" : ""} client` : null, icon: "lemlist",
      state, detail: l.reconnect && l.connected ? `${l.reconnect} compte(s) à reconnecter sur ${l.total}` : null, lastActivity,
      direction: "both", parent: "core", href: "/parametres/connecteurs#lemlist", live: isLive(l.lastOkAt, state, now), dimmed: false,
      feeds: ["Conversations des campagnes lemlist des clients", "Réponses envoyées depuis le CRM"], toolId: null, depth: 1,
    });
  }

  nodes.push(...mcpNodes(input));

  // outils déclarés : le parent doit exister, sinon ils se rattachent au CRM (jamais perdus de vue)
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const pending = [...input.tools].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let guard = pending.length + 1;
  while (pending.length && guard-- > 0) {
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      const parentId = t.parentTool ? `tool:${t.parentTool}` : (t.parentKey ?? "core");
      const parent = byId.get(parentId);
      if (!parent && t.parentTool && pending.some((p) => p.id === t.parentTool)) continue; // parent pas encore placé
      const p = parent ?? byId.get("core")!;
      const dimmed = p.dimmed || (p.kind !== "core" && p.kind !== "declared" && p.state !== "connected");
      const n: MapNode = {
        id: `tool:${t.id}`, kind: "declared", label: t.name, sublabel: parent ? `Relié à ${p.label}` : "Parent introuvable, rattaché au CRM", icon: "tool",
        state: null, detail: null, lastActivity: null, direction: "declared", parent: p.id, href: null, live: false, dimmed,
        feeds: [], toolId: t.id, depth: p.depth + 1,
      };
      nodes.push(n);
      byId.set(n.id, n);
      pending.splice(i--, 1);
    }
  }
  return nodes;
}

function mcpNodes(input: MapInput): MapNode[] {
  const { now } = input;
  const claude = input.connectors.find((c) => c.key === "claude_mcp");
  const grants = claude?.mcp?.grants ?? null;
  const tracked = new Map((input.mcpClients ?? []).map((m) => [m.clientId, m]));
  const ids = [...new Set([...(grants ?? []).map((g) => g.clientId), ...tracked.keys()])];
  const feeds = claude?.feeds ?? [];
  const href = "/parametres/connecteurs?gerer=claude_mcp";
  const out: MapNode[] = [];

  for (const id of ids) {
    const g = grants?.find((x) => x.clientId === id) ?? null;
    const m = tracked.get(id) ?? null;
    const state: MapState = grants === null ? (claude ? toMapState(claude.state) : "reconnect") : g ? "connected" : "not_connected";
    const detail = grants === null ? "Accès non vérifiables pour le moment" : g ? null : "Accès retiré";
    const lastActivity = m ? { at: m.lastSeenAt, label: "Dernier appel MCP" } : g?.grantedAt ? { at: g.grantedAt, label: "Autorisé (aucun appel suivi depuis)" } : null;
    const client = m?.name ? `${m.name}${m.version ? ` ${m.version}` : ""}` : null;
    out.push({
      id: `mcp:${id}`, kind: "mcp", label: g?.name || m?.name || "Client MCP", sublabel: [client, shortId(id)].filter(Boolean).join(" · "), icon: "claude",
      state, detail, lastActivity, direction: "both", parent: "core", href, live: isLive(m?.lastSeenAt, state, now), dimmed: false, feeds, toolId: null, depth: 1,
    });
  }
  // deux clients au même nom : le suffixe d'identifiant les distingue aussi dans le titre
  const seen = new Map<string, number>();
  for (const n of out) seen.set(n.label, (seen.get(n.label) ?? 0) + 1);
  for (const n of out) if ((seen.get(n.label) ?? 0) > 1) n.label = `${n.label} ${shortId(n.id.slice(4))}`;
  out.sort((a, b) => a.label.localeCompare(b.label, "fr"));

  if (input.unknownHistoryAt) {
    out.push({
      id: "mcp:unknown", kind: "mcp", label: "Client MCP inconnu", sublabel: "Historique sans information de client", icon: "claude",
      state: "not_connected", detail: "Écritures de Claude antérieures au suivi des clients",
      lastActivity: { at: input.unknownHistoryAt, label: "Dernière écriture non attribuée" }, direction: "both", parent: "core", href,
      live: false, dimmed: false, feeds, toolId: null, depth: 1,
    });
  }
  if (!out.length) {
    const state = claude ? toMapState(claude.state) : "not_connected";
    out.push({
      id: "connector:claude_mcp", kind: "connector", label: "Claude · MCP", sublabel: claude?.note ?? null, icon: "claude", state,
      detail: claude && STATE_LABEL[claude.state] !== MAP_STATE_LABEL[state] ? STATE_LABEL[claude.state] : null,
      lastActivity: claude?.lastSuccess ?? null, direction: "both", parent: "core", href, live: false, dimmed: false, feeds, toolId: null, depth: 1,
    });
  }
  return out;
}

/** Parents proposés pour « Ajouter un outil relié » (profondeur limitée pour garder la carte lisible). */
export function parentOptions(nodes: MapNode[]) {
  return nodes.filter((n) => n.depth <= 2).map((n) => ({ id: n.id, label: n.kind === "core" ? "Cely Growth (le CRM)" : n.label }));
}

// ---------------------------------------------------------------------------
// Disposition radiale : le CRM au centre, les nœuds de premier rang sur une ellipse, les outils déclarés
// rejetés vers l'extérieur dans l'axe de leur parent.
// ---------------------------------------------------------------------------

export const VIEW = { w: 1000, h: 680 };
export const SIZE = { core: { w: 176, h: 64 }, node: { w: 184, h: 54 } };
export type Point = { x: number; y: number };

export function layout(nodes: MapNode[]): Map<string, Point> {
  const pos = new Map<string, Point>();
  const cx = VIEW.w / 2, cy = VIEW.h / 2;
  pos.set("core", { x: cx, y: cy });
  const children = (id: string) => nodes.filter((n) => n.parent === id);
  const first = children("core");
  // connecteurs, puis clients MCP, puis outils déclarés : chaque famille reste groupée
  const rank = (n: MapNode) => (n.kind === "connector" ? 0 : n.kind === "mcp" ? 1 : 2);
  first.sort((a, b) => rank(a) - rank(b));
  // les branches qui portent des outils déclarés reçoivent plus d'angle
  const weight = (n: MapNode): number => 1 + children(n.id).reduce((s, c) => s + 0.6 * weight(c), 0);
  const total = first.reduce((s, n) => s + weight(n), 0) || 1;
  const rx = 330, ry = 220;
  let acc = -Math.PI / 2 - (Math.PI * weight(first[0] ?? nodes[0])) / total;
  const angle = new Map<string, number>();
  for (const n of first) {
    const span = (2 * Math.PI * weight(n)) / total;
    const a = acc + span / 2;
    acc += span;
    angle.set(n.id, a);
    pos.set(n.id, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  const place = (parent: MapNode) => {
    const kids = children(parent.id);
    const pa = angle.get(parent.id) ?? 0;
    const pp = pos.get(parent.id)!;
    const spread = 0.42;
    kids.forEach((k, i) => {
      const a = pa + (i - (kids.length - 1) / 2) * spread;
      const d = 150;
      const p = { x: pp.x + d * Math.cos(a) * 1.15, y: pp.y + d * Math.sin(a) * 0.8 };
      angle.set(k.id, a);
      pos.set(k.id, clamp(p));
      place(k);
    });
  };
  first.forEach(place);
  relax(nodes, pos);
  return pos;
}

/** Écarte les nœuds qui se chevauchent (surtout les outils déclarés, les nœuds de premier rang bougent peu). */
function relax(nodes: MapNode[], pos: Map<string, Point>) {
  const box = (n: MapNode) => (n.kind === "core" ? SIZE.core : SIZE.node);
  const mobility = (n: MapNode) => (n.kind === "core" ? 0 : n.depth >= 2 ? 1 : 0.25);
  const gap = 10;
  for (let it = 0; it < 400; it++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const pa = pos.get(a.id)!, pb = pos.get(b.id)!;
        const ox = (box(a).w + box(b).w) / 2 + gap - Math.abs(pa.x - pb.x);
        const oy = (box(a).h + box(b).h) / 2 + gap - Math.abs(pa.y - pb.y);
        if (ox <= 0 || oy <= 0) continue;
        const ma = mobility(a), mb = mobility(b);
        if (!ma && !mb) continue;
        const share = (m: number) => m / (ma + mb);
        // l'axe le moins coûteux, sauf si les deux nœuds sont bloqués contre un bord dans cet axe
        const alongX = ox / VIEW.w < oy / VIEW.h;
        if (alongX) {
          const s = (pa.x - pb.x || (i % 2 ? 1 : -1)) > 0 ? 1 : -1;
          pos.set(a.id, clamp({ x: pa.x + s * ox * share(ma), y: pa.y }));
          pos.set(b.id, clamp({ x: pb.x - s * ox * share(mb), y: pb.y }));
        } else {
          const s = (pa.y - pb.y || (i % 2 ? 1 : -1)) > 0 ? 1 : -1;
          pos.set(a.id, clamp({ x: pa.x, y: pa.y + s * oy * share(ma) }));
          pos.set(b.id, clamp({ x: pb.x, y: pb.y - s * oy * share(mb) }));
        }
        // bloqués par le bord : on tente l'autre axe au tour suivant
        const na = pos.get(a.id)!, nb = pos.get(b.id)!;
        if (na.x === pa.x && na.y === pa.y && nb.x === pb.x && nb.y === pb.y) {
          const s = (pa.x - pb.x || 1) > 0 ? 1 : -1;
          const t = (pa.y - pb.y || 1) > 0 ? 1 : -1;
          pos.set(a.id, clamp({ x: pa.x + s * ox * share(ma), y: pa.y + t * oy * share(ma) * 0.5 }));
          pos.set(b.id, clamp({ x: pb.x - s * ox * share(mb), y: pb.y - t * oy * share(mb) * 0.5 }));
        }
        moved = true;
      }
    if (!moved) break;
  }
}

function clamp(p: Point): Point {
  const mx = SIZE.node.w / 2 + 6, my = SIZE.node.h / 2 + 6;
  return { x: Math.min(VIEW.w - mx, Math.max(mx, p.x)), y: Math.min(VIEW.h - my, Math.max(my, p.y)) };
}

/** Point où le segment centre→cible sort du rectangle (pour que les flèches touchent le bord du nœud). */
export function edgePoint(from: Point, to: Point, half: { w: number; h: number }): Point {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (!dx && !dy) return from;
  const t = Math.min(dx ? half.w / Math.abs(dx) : Infinity, dy ? half.h / Math.abs(dy) : Infinity);
  return { x: from.x + dx * t, y: from.y + dy * t };
}
