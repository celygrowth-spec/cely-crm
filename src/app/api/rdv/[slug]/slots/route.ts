// Créneaux libres d'un type de rendez-vous (public). Un agenda connecté qui ne répond pas
// renvoie une erreur 503 : ses créneaux ne sont jamais présentés comme libres.
import type { NextRequest } from "next/server";
import { json, publicError } from "@/lib/appointments/http";
import { parseManageRef } from "@/lib/appointments/secrets";
import { getSlots } from "@/lib/appointments/server";

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const from = Date.parse(sp.get("from") ?? "");
  const to = Date.parse(sp.get("to") ?? "");
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 45 * 86400_000) {
    return json({ error: "Période invalide" }, 400);
  }
  try {
    // report depuis un lien privé : le rendez-vous concerné ne bloque pas ses propres créneaux
    const ref = sp.get("ref");
    const exclude = ref ? parseManageRef(ref)?.id ?? null : null;
    const slots = await getSlots({ slug, from: new Date(Math.max(from, Date.now())).toISOString(), to: new Date(to).toISOString(), exclude });
    return json({ slots });
  } catch (e) {
    return publicError(e);
  }
}
