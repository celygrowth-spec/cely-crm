// Convention de nommage des UTM : minuscules, sans accents, tirets. Utilisée à la collecte (regroupement des
// variantes) comme dans le Générateur de liens UTM et le marquage automatique des mails : une seule règle partout.

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

/** Sources réutilisables proposées par le générateur (la saisie libre reste possible, normalisée). */
export const UTM_SOURCES = ["linkedin", "email", "prospection", "signature", "newsletter", "google", "bing", "partenaire", "evenement", "qr-code"] as const;
/** Supports réutilisables. */
export const UTM_MEDIUMS = ["social", "email", "message", "post", "commentaire", "profil", "cpc", "referral", "print"] as const;

// variantes courantes ramenées à la valeur de référence
const ALIASES: Record<string, string> = {
  "linked-in": "linkedin", linkedln: "linkedin", lnkd: "linkedin", li: "linkedin", "linkedin-com": "linkedin",
  mail: "email", "e-mail": "email", emails: "email", courriel: "email", mailing: "email", emailing: "email",
  "news-letter": "newsletter", nl: "newsletter", infolettre: "newsletter",
  fb: "facebook", "facebook-com": "facebook", ig: "instagram", insta: "instagram", yt: "youtube",
  twitter: "x", "x-com": "x", "t-co": "x",
  adwords: "google", "google-ads": "google", googleads: "google",
  ppc: "cpc", paid: "cpc", "paid-search": "cpc", sea: "cpc",
  "social-media": "social", socials: "social", "reseaux-sociaux": "social", "organic-social": "social",
  prospect: "prospection", outbound: "prospection", "cold-email": "prospection",
  sig: "signature", "signature-mail": "signature", "email-signature": "signature",
};
const KNOWN = [...UTM_SOURCES, ...UTM_MEDIUMS, "facebook", "instagram", "youtube", "chatgpt", "perplexity"] as string[];

/** minuscules, sans accents, tirets ; chaîne vide si rien d'exploitable */
export function slugUtm(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Source ou support : normalisé, variantes et fautes de frappe ramenées à la valeur de référence. */
export function canonicalUtmValue(raw: string | null | undefined): string {
  const s = slugUtm(raw);
  if (!s) return "";
  if (ALIASES[s]) return ALIASES[s];
  if (KNOWN.includes(s)) return s;
  // faute de frappe : une lettre d'écart pour un mot de 5 à 7 lettres, deux au-delà
  if (s.length >= 5) {
    const max = s.length >= 8 ? 2 : 1;
    const near = KNOWN.filter((k) => k.length >= 5 && distance(s, k, max) <= max);
    if (near.length === 1) return near[0];
  }
  return s;
}

export type NormalizedUtm = { utm: Utm; raw: Utm | null };

/**
 * Lit les UTM d'une adresse : valeurs normalisées pour le regroupement, valeurs d'origine conservées à part quand
 * elles diffèrent. Les noms de paramètres sont acceptés en majuscules (UTM_Source).
 */
export function readUtm(params: URLSearchParams | Record<string, string | null | undefined>): NormalizedUtm {
  const get = (k: string) => {
    if (params instanceof URLSearchParams) {
      for (const [name, value] of params) if (name.toLowerCase() === k) return value;
      return null;
    }
    const hit = Object.keys(params).find((name) => name.toLowerCase() === k);
    return hit ? params[hit] ?? null : null;
  };
  const utm: Utm = {};
  const raw: Utm = {};
  let differs = false;
  for (const k of UTM_KEYS) {
    const value = get(k)?.trim().slice(0, 200);
    if (!value) continue;
    const norm = k === "utm_source" || k === "utm_medium" ? canonicalUtmValue(value) : slugUtm(value);
    if (!norm) continue;
    utm[k] = norm;
    raw[k] = value;
    if (norm !== value) differs = true;
  }
  return { utm, raw: differs ? raw : null };
}

export const hasUtm = (u: Utm) => !!(u.utm_source || u.utm_medium || u.utm_campaign);

/** Domaines du site suivi (les liens vers eux reçoivent des UTM, leurs référents sont internes). */
export const SITE_HOSTS = ["celygrowth.com", "www.celygrowth.com"];
export const SITE_URL = "https://www.celygrowth.com";

export function isSiteHost(host: string): boolean {
  return SITE_HOSTS.includes(host.toLowerCase().replace(/\.$/, ""));
}

/** Construit un lien du site avec ses UTM (valeurs normalisées, paramètres vides omis). */
export function buildUtmUrl(pathOrUrl: string, utm: Utm): string {
  const url = new URL(pathOrUrl, SITE_URL);
  for (const k of UTM_KEYS) {
    const v = k === "utm_source" || k === "utm_medium" ? canonicalUtmValue(utm[k]) : slugUtm(utm[k]);
    if (v) url.searchParams.set(k, v);
    else url.searchParams.delete(k);
  }
  return url.toString();
}

/**
 * Ajoute des UTM à un lien vers le site s'il n'en porte aucun. Un lien déjà marqué, un lien vers un autre site ou
 * une adresse illisible sont rendus tels quels.
 */
export function tagSiteUrl(href: string, utm: Utm): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  if (!/^https?:$/.test(url.protocol) || !isSiteHost(url.hostname)) return href;
  for (const name of url.searchParams.keys()) if (name.toLowerCase().startsWith("utm_")) return href;
  for (const k of UTM_KEYS) {
    const v = k === "utm_source" || k === "utm_medium" ? canonicalUtmValue(utm[k]) : slugUtm(utm[k]);
    if (v) url.searchParams.set(k, v);
  }
  return url.toString();
}
