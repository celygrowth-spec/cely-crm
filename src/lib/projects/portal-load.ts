import "server-only";
import { notFound, redirect } from "next/navigation";
import { PortalError, PortalSessionError, portalRpc } from "./portal";

/** Lecture commune des pages du portail : session expirée → connexion ; contenu non partagé → 404. */
export async function portalLoad<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await portalRpc<T>(fn, args);
  } catch (e) {
    if (e instanceof PortalSessionError) redirect("/portail");
    if (e instanceof PortalError && e.code === "not_found") notFound();
    throw e;
  }
}

