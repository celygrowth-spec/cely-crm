// Point de collecte public de la mesure d'audience de celygrowth.com.
// - accepte uniquement les requêtes dont l'origine est le site (ou une origine de SITE_TRACKING_ORIGINS) ;
// - valide la forme et la taille, limite les abus (en base, par empreinte) et n'écrit que des événements ;
// - ne renvoie jamais de donnée : 204 dans tous les cas acceptés, pour ne rien révéler à l'appelant.
import { allowedOrigins } from "@/lib/tracking/config";
import { clientIp, collect, MAX_BODY } from "@/lib/tracking/collect";

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
    "Cache-Control": "no-store",
  };
}

function allowed(req: Request): string | null {
  const origin = req.headers.get("origin");
  return origin && allowedOrigins().includes(origin) ? origin : null;
}

export function OPTIONS(req: Request) {
  const origin = allowed(req);
  if (!origin) return new Response(null, { status: 403 });
  return new Response(null, { status: 204, headers: cors(origin) });
}

export async function POST(req: Request) {
  const origin = allowed(req);
  if (!origin) return new Response(null, { status: 403 });
  const headers = cors(origin);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return new Response(null, { status: 413, headers });
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return new Response(null, { status: 400, headers });
  }
  try {
    const outcome = await collect(raw, {
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent") ?? "",
      country: req.headers.get("x-vercel-ip-country")?.toUpperCase() ?? null,
    });
    if (outcome === "invalid") return new Response(null, { status: 400, headers });
    if (outcome === "rate_limited") return new Response(null, { status: 429, headers });
    return new Response(null, { status: 204, headers });
  } catch {
    // jamais de détail : ni l'événement ni l'erreur ne sont journalisés
    return new Response(null, { status: 503, headers });
  }
}
