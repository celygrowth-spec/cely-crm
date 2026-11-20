// Passage d'un robot (moteur de recherche ou IA) signalé par le serveur du site, qui voit les robots que le
// script de mesure ne voit pas (ils n'exécutent pas JavaScript). Authentifié par un secret partagé
// (SITE_TRACKING_SECRET) ; l'adresse transmise sert à contrôler l'origine du robot et n'est pas conservée.
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { identifyBot } from "@/lib/tracking/bots";
import { botSecret } from "@/lib/tracking/config";

const schema = z.object({
  ua: z.string().min(1).max(600),
  path: z.string().min(1).max(300).regex(/^\/[^\s?#]*$/),
  ip: z.string().max(60).nullish(),
});

function authorized(req: Request) {
  const secret = botSecret();
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function POST(req: Request) {
  if (!authorized(req)) return new Response(null, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response(null, { status: 400 });
  const verdict = await identifyBot(parsed.data.ua, parsed.data.ip ?? null);
  // agent inconnu : rien n'est enregistré (ce point d'entrée ne compte que les robots reconnus)
  if (!verdict) return new Response(null, { status: 204 });
  const { data, error } = await publicClient().rpc("site_bot_hit", {
    p_server_key: serverRpcKey(), p_bot: verdict.bot, p_kind: verdict.kind, p_status: verdict.status, p_path: parsed.data.path,
  });
  if (error) return new Response(null, { status: 503 });
  return new Response(null, { status: data === "rate_limited" ? 429 : 204 });
}
