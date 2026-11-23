// Lien du site saisi par le client dans l'onboarding (question 4, facultatif). Même règle dans le navigateur, dans
// la route du portail et en base (portal_discovery_answer) : http(s), un vrai nom de domaine, 300 caractères au plus.

/** Clé de la réponse en base (discovery_answers). Ne pas la changer : des liens sont déjà enregistrés sous ce nom. */
export const WEBSITE_KEY = "website_url";
export const WEBSITE_MAX = 300;
export const WEBSITE_ERROR = "Ce lien ne ressemble pas à une adresse de site. Exemple : https://www.exemple.fr";

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Remet un lien au propre : « exemple.fr » devient « https://exemple.fr ». Renvoie "" pour un champ vide,
 * null pour un lien invalide (espaces, autre protocole, pas de nom de domaine, identifiants dans l'adresse).
 */
export function normalizeWebsite(raw: string): string | null {
  const s = raw.trim();
  if (!s) return "";
  if (/\s/.test(s) || s.length > WEBSITE_MAX) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^/:]+:\d/.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  // un nom de domaine avec une extension en lettres : ni « localhost », ni adresse IP, ni « site » tout court
  if (!HOST.test(host) || !/[a-z]{2,}$/.test(host.slice(host.lastIndexOf(".") + 1))) return null;
  const out = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname}${url.search}${url.hash}`;
  return out.length > WEBSITE_MAX ? null : out;
}
