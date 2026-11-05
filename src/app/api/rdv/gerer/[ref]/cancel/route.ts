// Annulation depuis le lien privé (jeton limité à ce rendez-vous)
import { json, publicError, requestOrigin } from "@/lib/appointments/http";
import { parseManageRef } from "@/lib/appointments/secrets";
import { cancelBooking, publicClient } from "@/lib/appointments/server";

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  try {
    const parsed = parseManageRef(ref);
    if (!parsed) return json({ error: "Ce lien n'est pas valide." }, 404);
    const body = (await req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) || null : null;
    const r = await cancelBooking({ kind: "invitee", sb: publicClient(), tokenHash: parsed.tokenHash }, parsed.id, reason, requestOrigin(req));
    return json(r);
  } catch (e) {
    return publicError(e);
  }
}
