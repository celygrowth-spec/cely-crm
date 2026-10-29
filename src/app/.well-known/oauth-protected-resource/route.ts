import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from "mcp-handler";

// Métadonnées RFC 9728 : indiquent à Claude que le serveur d'autorisation est Supabase Auth.
function handler(req: Request) {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  return protectedResourceHandler({ authServerUrls: [`${url}/auth/v1`] })(req);
}

const options = metadataCorsOptionsRequestHandler();
export { handler as GET, options as OPTIONS };
