import "server-only";
import { NextResponse } from "next/server";
import { AppointmentsNotConfigured } from "./secrets";
import { BookingError } from "./server";

const NO_STORE = { "Cache-Control": "private, no-store" };

export function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE });
}

/** Réponse d'erreur publique : jamais de détail interne, jamais de faux succès. */
export function publicError(e: unknown) {
  if (e instanceof AppointmentsNotConfigured) return json({ error: "La réservation en ligne n'est pas encore configurée." }, 503);
  if (e instanceof BookingError) {
    const status = e.code === "invalid" ? 400 : e.code === "not_found" ? 404 : e.code === "calendar" ? 503 : e.code === "config" ? 403 : 500;
    return json({ error: e.message, code: e.code }, status);
  }
  console.error("[rendez-vous]", e);
  return json({ error: "Une erreur inattendue est survenue. Réessayez." }, 500);
}

export function requestOrigin(req: Request): string | null {
  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}
