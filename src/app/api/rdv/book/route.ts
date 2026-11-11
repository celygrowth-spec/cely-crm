// Réservation publique. Toute la validation est refaite côté serveur et en base.
import { json, publicError, requestOrigin } from "@/lib/appointments/http";
import { bookPublic } from "@/lib/appointments/server";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "Requête invalide" }, 400);
  try {
    // première adresse de x-forwarded-for : celle du visiteur derrière le proxy Vercel
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip");
    const r = await bookPublic(body, requestOrigin(req), { ip });
    return json(r, r.status === "error" ? (r.retryable ? 503 : 400) : r.status === "unavailable" ? 409 : 200);
  } catch (e) {
    return publicError(e);
  }
}
