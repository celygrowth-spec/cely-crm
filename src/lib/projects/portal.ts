import "server-only";
// Accès aux données du portail : toujours via les fonctions portal_* (clé serveur + session du client).
// Aucune lecture directe de table : la base refuse le rôle anon.
import { cookies } from "next/headers";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { PORTAL_COOKIE, sessionHash } from "./portal-auth";

export class PortalSessionError extends Error {}
export class PortalError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "invalid" | "server") {
    super(message);
  }
}

export async function portalSessionHash(): Promise<string | null> {
  const token = (await cookies()).get(PORTAL_COOKIE)?.value;
  return token && token.length >= 40 && token.length <= 64 ? sessionHash(token) : null;
}

/** Appelle une fonction du portail pour la session courante. */
export async function portalRpc<T>(fn: string, args: Record<string, unknown> = {}, hash?: string | null): Promise<T> {
  const h = hash ?? (await portalSessionHash());
  if (!h) throw new PortalSessionError("Session absente");
  const { data, error } = await publicClient().rpc(fn, { p_server_key: serverRpcKey(), p_session_hash: h, ...args });
  if (error) {
    if (error.code === "28000") throw new PortalSessionError("Session expirée");
    if (error.code === "P0002") throw new PortalError(error.message, "not_found");
    if (error.code === "42501") throw new PortalError(/archivé|autoris|réservé/i.test(error.message) ? error.message : "Action non autorisée.", "forbidden");
    if (error.code === "22023") throw new PortalError(error.message, "invalid");
    console.error("[portail]", fn, error.message);
    throw new PortalError("Le service est momentanément indisponible. Réessayez.", "server");
  }
  return data as T;
}
