// Webhook Fireflies V2 (route publique, protégée par la signature). La tâche est enregistrée en base
// AVANT la réponse : une erreur renvoie 503 et Fireflies retentera sa livraison.
import { after, NextResponse } from "next/server";
import { z } from "zod";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { publicClient } from "@/lib/appointments/server";
import { firefliesWebhookSecret } from "@/lib/fireflies/config";
import { verifySignature } from "@/lib/fireflies/signature";
import { drainImports } from "@/lib/fireflies/worker";

export const maxDuration = 60;

const MAX_BODY = 64 * 1024;
const IMPORT_EVENTS = new Set(["meeting.transcribed", "meeting.summarized"]);

const payloadSchema = z.object({
  event: z.string().max(64),
  meeting_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  timestamp: z.number().optional(),
  reprocessed_at: z.number().int().nonnegative().optional(),
});

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const secret = firefliesWebhookSecret();
  if (!secret) {
    console.error("[fireflies] webhook : FIREFLIES_WEBHOOK_SECRET absent");
    return reply({ error: "Non configuré" }, 503);
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY) return reply({ error: "Requête trop volumineuse" }, 413);
  if (!verifySignature(raw, req.headers.get("x-hub-signature"), secret)) return reply({ error: "Signature invalide" }, 401);

  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(raw));
  } catch {
    return reply({ error: "Contenu invalide" }, 400);
  }
  if (!IMPORT_EVENTS.has(payload.event)) return reply({ ok: true, ignored: true }); // meeting.bot_joined, etc.

  const sb = publicClient();
  try {
    const { error } = await sb.rpc("fireflies_enqueue", {
      p_server_key: serverRpcKey(),
      p_meeting_id: payload.meeting_id,
      p_event: payload.event,
      p_reprocessed_at: payload.reprocessed_at ?? null,
    });
    if (error) throw new Error(error.code ?? "rpc");
  } catch (e) {
    console.error(`[fireflies] webhook : tâche non enregistrée (${e instanceof Error ? e.message.slice(0, 60) : "inconnu"})`);
    return reply({ error: "Enregistrement impossible" }, 503);
  }

  after(async () => {
    try {
      await drainImports(sb);
    } catch {
      console.error("[fireflies] traitement interrompu, reprise au prochain passage");
    }
  });
  return reply({ ok: true });
}
