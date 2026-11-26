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

/** Lien d'invitation expiré, déjà utilisé, remplacé ou inventé : un seul message, sans détail technique. */
export const INVALID_LINK = "Ce lien n'est plus valable : il a expiré, a déjà été utilisé ou a été remplacé par un plus récent. Contactez votre interlocuteur Cely Growth pour recevoir une nouvelle invitation.";

/** Jeton d'invitation lu dans le corps de la requête (base64url, 43 caractères pour 256 bits). */
export function readToken(body: unknown): string | null {
  const t = body && typeof body === "object" && "token" in body ? (body as { token: unknown }).token : null;
  return typeof t === "string" && /^[A-Za-z0-9_-]{20,100}$/.test(t.trim()) ? t.trim() : null;
}

export function portalFailure(e: unknown) {
  if (e instanceof PortalSessionError) return reply({ error: "Votre session a expiré. Reconnectez-vous.", session: false }, 401);
  if (e instanceof PortalError) return reply({ error: e.message }, e.code === "not_found" ? 404 : e.code === "forbidden" ? 403 : e.code === "invalid" ? 400 : 503);
  if (e instanceof AppointmentsNotConfigured) return reply({ error: "Le portail n'est pas encore configuré." }, 503);
  console.error("[portail]", e);
  return reply({ error: "Une erreur est survenue. Réessayez." }, 500);
}
