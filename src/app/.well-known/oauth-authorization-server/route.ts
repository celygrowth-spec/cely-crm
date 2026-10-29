// Compatibilité avec les clients qui cherchent les métadonnées OAuth sur l'origine du
// serveur MCP : on renvoie celles de Supabase Auth (le vrai serveur d'autorisation).
export async function GET() {
  const url = (process.env.SUPABASE_URL ?? "").replace(/\/+$/, "");
  const res = await fetch(`${url}/.well-known/oauth-authorization-server/auth/v1`, { cache: "no-store" });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
