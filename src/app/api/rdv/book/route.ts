// Réservation publique. Toute la validation est refaite côté serveur et en base.
import { json, publicError, requestOrigin } from "@/lib/appointments/http";
import { bookPublic } from "@/lib/appointments/server";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Requête invalide" }, 400);
  try {
    const r = await bookPublic(body, requestOrigin(req));
    return json(r, r.status === "error" ? (r.retryable ? 503 : 400) : r.status === "unavailable" ? 409 : 200);
  } catch (e) {
    return publicError(e);
  }
}
