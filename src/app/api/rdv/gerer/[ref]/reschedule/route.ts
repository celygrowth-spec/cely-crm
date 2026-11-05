// Report depuis le lien privé : le nouveau créneau est vérifié et retenu avant toute libération de l'ancien
import { json, publicError, requestOrigin } from "@/lib/appointments/http";
import { parseManageRef } from "@/lib/appointments/secrets";
import { getPublicBooking, publicClient, rescheduleBooking } from "@/lib/appointments/server";

export async function POST(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  try {
    const parsed = parseManageRef(ref);
    const booking = parsed ? await getPublicBooking(ref) : null;
    if (!parsed || !booking) return json({ error: "Ce lien n'est pas valide." }, 404);
    if (!booking.event_active) return json({ error: "Ce type de rendez-vous n'est plus proposé : contactez-nous pour convenir d'un autre horaire." }, 409);
    const body = (await req.json().catch(() => ({}))) as { starts_at?: unknown };
    if (typeof body.starts_at !== "string" || !Number.isFinite(Date.parse(body.starts_at))) return json({ error: "Créneau invalide" }, 400);
    const r = await rescheduleBooking({ kind: "invitee", sb: publicClient(), tokenHash: parsed.tokenHash }, parsed.id, booking.slug, body.starts_at, requestOrigin(req));
    return json(r, r.status === "unavailable" ? 409 : r.status === "error" ? 503 : 200);
  } catch (e) {
    return publicError(e);
  }
}
