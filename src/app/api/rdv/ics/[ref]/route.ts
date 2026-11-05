// Fichier .ics du rendez-vous (lien privé). UID stable : le fichier d'un report remplace l'ancien.
import { buildIcs } from "@/lib/appointments/ics";
import { appUrl } from "@/lib/appointments/config";
import { getPublicBooking, locationText } from "@/lib/appointments/server";
import { publicError, requestOrigin } from "@/lib/appointments/http";

export async function GET(req: Request, ctx: { params: Promise<{ ref: string }> }) {
  const { ref } = await ctx.params;
  try {
    const b = await getPublicBooking(ref);
    if (!b) return new Response("Lien invalide", { status: 404 });
    const manage = `${appUrl(requestOrigin(req))}/rdv/gerer/${ref}`;
    const ics = buildIcs({
      uid: `${b.id}@cely-growth`,
      sequence: b.version,
      start: b.starts_at,
      end: b.ends_at,
      summary: `${b.event.name} — ${b.display_name}`,
      description: [b.event.description, `Annuler ou reporter : ${manage}`].filter(Boolean).join("\n\n"),
      location: locationText(b),
      url: b.meeting_url ?? manage,
      cancelled: b.status === "cancelled",
    });
    return new Response(ics, {
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `attachment; filename="rendez-vous-${b.event.slug}.ics"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    return publicError(e);
  }
}
