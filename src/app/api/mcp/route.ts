// Connecteur MCP (Streamable HTTP) pour Claude. Authentification : jeton OAuth 2.1 émis
// par Supabase Auth pour le compte propriétaire. Les requêtes s'exécutent avec ce jeton,
// donc sous les mêmes règles RLS que l'application. Aucune clé de service n'est utilisée.
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

async function verifyToken(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
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
  return {
    token: bearer,
    clientId,
    scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
    expiresAt: claims.exp,
    extra: { userId: claims.sub },
  };
}

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
});

export { authed as GET, authed as POST, authed as DELETE };
