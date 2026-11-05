import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { AppointmentsNotConfigured } from "@/lib/appointments/secrets";
import { PortalError, PortalSessionError } from "./portal";

const NO_STORE = { "Cache-Control": "private, no-store" };

export const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

/** Écritures du portail : même origine obligatoire (protection CSRF en plus du cookie SameSite=Lax). */
export function sameOrigin(req: NextRequest) {
  return req.headers.get("origin") === req.nextUrl.origin;
}

export function portalFailure(e: unknown) {
  if (e instanceof PortalSessionError) return reply({ error: "Votre session a expiré. Reconnectez-vous avec votre code.", session: false }, 401);
  if (e instanceof PortalError) return reply({ error: e.message }, e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "invalid" ? 400 : 503);
  if (e instanceof AppointmentsNotConfigured) return reply({ error: "Le portail n'est pas encore configuré." }, 503);
  console.error("[portail]", e);
  return reply({ error: "Une erreur est survenue. Réessayez." }, 500);
}
