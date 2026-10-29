import { getPublicOrigin, metadataCorsOptionsRequestHandler, protectedResourceHandler } from "mcp-handler";

// Variante RFC 9728 avec chemin : /.well-known/oauth-protected-resource/api/mcp décrit la
// ressource https://<domaine>/api/mcp (l'URL exacte du connecteur).
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  return protectedResourceHandler({
    authServerUrls: [`${url}/auth/v1`],
    resourceUrl: `${getPublicOrigin(req)}/${path.map(encodeURIComponent).join("/")}`,
  })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
