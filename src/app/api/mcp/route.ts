// Connecteur MCP (Streamable HTTP) pour Claude. Authentification : jeton OAuth 2.1 émis
// par Supabase Auth pour le compte propriétaire. Les requêtes s'exécutent avec ce jeton,
// donc sous les mêmes règles RLS que l'application. Aucune clé de service n'est utilisée.
import { after } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { env } from "@/lib/env";
import { createSupabaseForToken } from "@/lib/supabase/server";
import { MCP_INSTRUCTIONS, registerTools } from "@/lib/mcp/tools";

export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    registerTools(server, (ctx) => {
      const token = ctx.http?.authInfo?.token;
      if (!token) throw new Error("Jeton manquant");
      return createSupabaseForToken(token);
    });
  },
  { serverInfo: { name: "cely-crm", version: "1.0.0" }, instructions: MCP_INSTRUCTIONS },
);

async function verifyToken(req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const auth = createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
  // getClaims vérifie la signature (JWKS) et l'expiration du jeton
  const { data, error } = await auth.auth.getClaims(bearer);
  const claims = data?.claims as (Record<string, unknown> & { sub?: string; exp?: number }) | undefined;
  if (error || !claims?.sub) return undefined;
  // seuls les jetons OAuth (émis pour un client MCP) sont acceptés : ils portent client_id
  const clientId = typeof claims.client_id === "string" ? claims.client_id : "";
  if (!clientId) return undefined;
  // le compte doit être le propriétaire du CRM
  const { data: owner } = await createSupabaseForToken(bearer).from("app_owner").select("user_id").eq("user_id", claims.sub).maybeSingle();
  if (!owner) return undefined;
  trackClient(req, bearer);
  return {
    token: bearer,
    clientId,
    scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
    expiresAt: claims.exp,
    extra: { userId: claims.sub },
  };
}

/**
 * Carte des connecteurs : note l'activité du client MCP (client_id lu dans le jeton, côté base) et, au message
 * « initialize », le nom et la version qu'il annonce. Après la réponse, sans jamais la bloquer ni la faire échouer.
 * Rien du jeton ni du contenu des requêtes n'est conservé ou journalisé.
 */
function trackClient(req: Request, bearer: string) {
  const len = req.headers.get("content-length");
  const small = req.method === "POST" && len !== null && Number(len) <= 16 * 1024;
  const peek = small ? req.clone() : null;
  try {
    after(async () => {
      try {
        let info: { name?: unknown; version?: unknown } | undefined;
        if (peek) {
          const body = (await peek.json().catch(() => null)) as unknown;
          const msgs = Array.isArray(body) ? body : [body];
          const init = msgs.find((m) => m && typeof m === "object" && (m as { method?: unknown }).method === "initialize") as { params?: { clientInfo?: typeof info } } | undefined;
          info = init?.params?.clientInfo;
        }
        await createSupabaseForToken(bearer).rpc("touch_mcp_client", {
          p_name: typeof info?.name === "string" ? info.name.slice(0, 80) : null,
          p_version: typeof info?.version === "string" ? info.version.slice(0, 40) : null,
        });
      } catch (e) {
        console.error("mcp : suivi du client", e instanceof Error ? e.name : "erreur");
      }
    });
  } catch {
    // hors contexte de requête (tests) : le suivi est facultatif
  }
}

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
});

export { authed as GET, authed as POST, authed as DELETE };
