// Retour de Make (route publique). Protégée par un secret partagé (`Authorization: Bearer`, variable
// MAKE_CALLBACK_SECRET), contenu validé strictement, au plus 60 retours par minute, et idempotente :
// un même retour (demande + événement) reçu deux fois ne produit qu'un effet. Rien du contenu n'est écrit dans les logs.
import { NextResponse } from "next/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { publicClient } from "@/lib/appointments/server";
import { returnSchema } from "@/lib/make/rules";
import { bearerMatches, makeCallbackSecret } from "@/lib/make/service";

const MAX_BODY = 16 * 1024;
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const secret = makeCallbackSecret();
  let key: string;
  try {
    key = serverRpcKey();
  } catch {
    return reply({ error: "Non configuré" }, 503);
  }
  if (!secret) return reply({ error: "Non configuré" }, 503);

  const raw = await req.text();
  const sb = publicClient();
  const record = async (args: Record<string, unknown>) => {
    const { data, error } = await sb.rpc("make_return", { p_server_key: key, ...args });
    if (error) throw new Error(error.code ?? "rpc");
    return data as string;
  };

  try {
    if (!bearerMatches(req.headers.get("authorization"), secret)) {
      return (await record({ p_outcome: "refused" })) === "rate_limited" ? reply({ error: "Trop d'appels" }, 429) : reply({ error: "Secret refusé" }, 401);
    }
    let parsed: ReturnType<typeof returnSchema.safeParse> | null = null;
    if (raw.length <= MAX_BODY) {
      try {
        parsed = returnSchema.safeParse(JSON.parse(raw));
      } catch {
        parsed = null;
      }
    }
    if (!parsed?.success) {
      return (await record({ p_outcome: "invalid" })) === "rate_limited" ? reply({ error: "Trop d'appels" }, 429) : reply({ error: "Contenu invalide" }, 400);
    }
    const p = parsed.data;
    const outcome = await record({
      p_outcome: "valid", p_event: p.event, p_request_id: p.request_id,
      p_quote_number: p.quote?.number ?? null, p_quote_url: p.quote?.url ?? null, p_signed_on: p.quote?.signed_at ?? null,
      p_error: p.error?.message ?? null,
    });
    if (outcome === "rate_limited") return reply({ error: "Trop d'appels" }, 429);
    if (outcome === "invalid") return reply({ error: "Contenu invalide" }, 400);
    return reply({ ok: true, duplicate: outcome === "duplicate", ignored: outcome === "ignored" });
  } catch (e) {
    console.error(`[make] retour non enregistré (${e instanceof Error ? e.message.slice(0, 40) : "inconnu"})`);
    return reply({ error: "Enregistrement impossible" }, 503); // Make peut réessayer : le retour est idempotent
  }
}
