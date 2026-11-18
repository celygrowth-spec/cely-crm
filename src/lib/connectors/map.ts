import "server-only";
// Carte des connecteurs : ce que le CRM a déjà enregistré, sans appel aux fournisseurs. Les états des connecteurs
// viennent de loadConnectors (mêmes règles que la liste) ; s'ajoutent ici l'activité des clients MCP, lemlist et
// les outils déclarés. Chaque lecture est indépendante : une lecture en échec n'empêche pas d'afficher le reste.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Connector } from "./types";
import type { DeclaredTool, LemlistSummary, MapInput, McpClientRow } from "./map-model";

type Row = Record<string, unknown>;

export async function loadMapInput(sb: SupabaseClient, connectors: Connector[]): Promise<MapInput> {
  const [clients, tools, lemlist] = await Promise.all([
    sb.from("mcp_clients").select("client_id, client_name, client_version, first_seen_at, last_seen_at, calls").order("first_seen_at"),
    sb.from("connector_map_tools").select("id, parent_key, parent_tool, name, created_at").order("created_at"),
    sb.from("lemlist_accounts").select("status, last_ok_at"),
  ]);
  const mcpClients: McpClientRow[] | null = clients.error ? null : ((clients.data ?? []) as Row[]).map((r) => ({
    clientId: String(r.client_id), name: (r.client_name as string) ?? null, version: (r.client_version as string) ?? null,
    firstSeenAt: String(r.first_seen_at), lastSeenAt: String(r.last_seen_at), calls: Number(r.calls ?? 0),
  }));

  // écritures de Claude antérieures au suivi des clients : aucune information de client, nœud « inconnu »
  let unknownHistoryAt: string | null = null;
  if (mcpClients) {
    const firstTracked = mcpClients[0]?.firstSeenAt ?? null;
    let q = sb.from("activity_log").select("created_at").eq("actor", "claude");
    if (firstTracked) q = q.lt("created_at", firstTracked);
    const { data } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    unknownHistoryAt = (data?.created_at as string | undefined) ?? null;
  }

  let lemlistSummary: LemlistSummary | null = null;
  if (!lemlist.error) {
    const rows = ((lemlist.data ?? []) as Row[]).filter((r) => r.status !== "disconnected");
    lemlistSummary = {
      total: rows.length,
      connected: rows.filter((r) => r.status === "connected").length,
      reconnect: rows.filter((r) => r.status === "needs_reconnect").length,
      lastOkAt: rows.map((r) => (r.last_ok_at as string) ?? "").filter(Boolean).sort().at(-1) ?? null,
    };
  }

  return {
    now: Date.now(),
    connectors,
    mcpClients,
    unknownHistoryAt,
    lemlist: lemlistSummary,
    tools: tools.error ? [] : ((tools.data ?? []) as Row[]).map((r): DeclaredTool => ({
      id: String(r.id), parentKey: (r.parent_key as string) ?? null, parentTool: (r.parent_tool as string) ?? null, name: String(r.name), createdAt: String(r.created_at),
    })),
  };
}
