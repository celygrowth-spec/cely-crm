import "server-only";
import { SITE_HOSTS } from "./utm";

/**
 * Origines autorisées à envoyer des événements : le site, plus celles de SITE_TRACKING_ORIGINS (séparées par des
 * virgules ; pour une preview du site ou un test local). Toute autre origine est refusée.
 */
export function allowedOrigins(): string[] {
  const extra = (process.env.SITE_TRACKING_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter((s) => /^https?:\/\/[^/\s]+$/.test(s));
  return [...SITE_HOSTS.map((h) => `https://${h}`), ...extra];
}

export function extraSiteHosts(): string[] {
  return allowedOrigins().map((o) => new URL(o).hostname);
}

/** Secret partagé avec le serveur du site pour signaler les passages de robots (24 caractères au moins). */
export function botSecret(): string | null {
  const s = process.env.SITE_TRACKING_SECRET ?? "";
  return s.length >= 24 ? s : null;
}
