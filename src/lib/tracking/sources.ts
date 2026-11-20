// Classement d'une visite par source, à partir de ses UTM, de son référent et des identifiants de clic publicitaire.
// Fonctions pures : utilisées par le point de collecte et testées seules.
import { hasUtm, isSiteHost, type Utm } from "./utm";

export const CHANNELS = ["campaign", "organic", "ai", "social", "email", "paid", "referral", "direct"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = {
  campaign: "Campagne",
  organic: "Recherche organique",
  ai: "IA générative",
  social: "Réseaux sociaux",
  email: "Email",
  paid: "Payant",
  referral: "Site référent",
  direct: "Direct",
};

type Rule = { name: string; test: RegExp };

// l'ordre compte : la première règle qui reconnaît le domaine l'emporte
const AI: Rule[] = [
  { name: "chatgpt", test: /(^|\.)(chatgpt\.com|chat\.openai\.com|openai\.com)$/ },
  { name: "perplexity", test: /(^|\.)perplexity\.ai$/ },
  { name: "claude", test: /(^|\.)claude\.ai$/ },
  { name: "gemini", test: /^(gemini|bard)\.google\.com$/ },
  { name: "copilot", test: /^copilot\.microsoft\.com$|(^|\.)copilot\.com$/ },
  { name: "mistral", test: /^chat\.mistral\.ai$/ },
  { name: "deepseek", test: /(^|\.)deepseek\.com$/ },
  { name: "grok", test: /(^|\.)grok\.com$|^x\.ai$/ },
  { name: "meta-ai", test: /(^|\.)meta\.ai$/ },
  { name: "you", test: /(^|\.)you\.com$/ },
  { name: "poe", test: /(^|\.)poe\.com$/ },
  { name: "phind", test: /(^|\.)phind\.com$/ },
];
const SEARCH: Rule[] = [
  { name: "google", test: /(^|\.)google\.[a-z.]{2,6}$/ },
  { name: "bing", test: /(^|\.)bing\.com$/ },
  { name: "duckduckgo", test: /(^|\.)duckduckgo\.com$/ },
  { name: "yahoo", test: /(^|\.)search\.yahoo\.com$|^yahoo\.com$/ },
  { name: "ecosia", test: /(^|\.)ecosia\.org$/ },
  { name: "qwant", test: /(^|\.)qwant\.com$/ },
  { name: "brave", test: /^search\.brave\.com$/ },
  { name: "startpage", test: /(^|\.)startpage\.com$/ },
  { name: "yandex", test: /(^|\.)yandex\.[a-z.]{2,6}$/ },
  { name: "baidu", test: /(^|\.)baidu\.com$/ },
  { name: "lilo", test: /(^|\.)lilo\.org$/ },
];
const SOCIAL: Rule[] = [
  { name: "linkedin", test: /(^|\.)linkedin\.com$|^lnkd\.in$|^com\.linkedin\.android$/ },
  { name: "facebook", test: /(^|\.)facebook\.com$|^fb\.me$|(^|\.)messenger\.com$/ },
  { name: "instagram", test: /(^|\.)instagram\.com$/ },
  { name: "x", test: /^t\.co$|(^|\.)twitter\.com$|^x\.com$/ },
  { name: "youtube", test: /(^|\.)youtube\.com$|^youtu\.be$/ },
  { name: "tiktok", test: /(^|\.)tiktok\.com$/ },
  { name: "pinterest", test: /(^|\.)pinterest\.[a-z.]{2,6}$/ },
  { name: "reddit", test: /(^|\.)reddit\.com$/ },
  { name: "threads", test: /(^|\.)threads\.(net|com)$/ },
  { name: "bluesky", test: /^bsky\.app$/ },
  { name: "whatsapp", test: /(^|\.)whatsapp\.com$|^wa\.me$/ },
  { name: "telegram", test: /^t\.me$|(^|\.)telegram\.org$/ },
];
const WEBMAIL = /^mail\.google\.com$|^outlook\.(live|office|office365)\.com$|^mail\.yahoo\.com$|^mail\.proton\.me$|^webmail\.|^mail\.(ovh|orange|free|laposte)\.|^messagerie\./;
/** identifiants de clic posés par les régies publicitaires (fbclid est exclu : Facebook l'ajoute aussi aux liens gratuits) */
const AD_CLICK_IDS: [string, string][] = [["gclid", "google"], ["gbraid", "google"], ["wbraid", "google"], ["msclkid", "bing"], ["li_fat_id", "linkedin"], ["ttclid", "tiktok"]];

const find = (rules: Rule[], host: string) => rules.find((r) => r.test.test(host))?.name ?? null;

/** Domaine d'un référent, en minuscules et sans « www. » ; nul s'il est absent, illisible ou interne au site. */
export function referrerHost(referrer: string | null | undefined, extraSiteHosts: string[] = []): string | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    // application Android (android-app://com.linkedin.android) : le « domaine » est le nom du paquet
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    if (!host || isSiteHost(host) || extraSiteHosts.includes(host)) return null;
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export type Classified = { channel: Channel; source: string | null; referrer_host: string | null };

/**
 * Priorité : Campagne (UTM), Payant (identifiant de clic), puis le référent (IA, recherche, réseaux sociaux, email,
 * autre site), sinon Direct. Exception : les IA ajoutent elles-mêmes « utm_source=chatgpt.com » à leurs liens ;
 * sans nom de campagne, ce n'est pas une campagne à moi mais une visite venue d'une IA.
 */
export function classifyVisit(input: { utm: Utm; referrer?: string | null; clickIds?: string[]; extraSiteHosts?: string[] }): Classified {
  const host = referrerHost(input.referrer, input.extraSiteHosts);
  const { utm } = input;
  if (hasUtm(utm)) {
    const aiFromUtm = utm.utm_source ? find(AI, utm.utm_source.replace(/-/g, ".")) : null;
    if (aiFromUtm && !utm.utm_campaign) return { channel: "ai", source: aiFromUtm, referrer_host: host };
    return { channel: "campaign", source: utm.utm_source ?? utm.utm_medium ?? null, referrer_host: host };
  }
  const ad = AD_CLICK_IDS.find(([id]) => input.clickIds?.includes(id));
  if (ad) return { channel: "paid", source: ad[1], referrer_host: host };
  if (!host) return { channel: "direct", source: null, referrer_host: null };
  const ai = find(AI, host);
  if (ai) return { channel: "ai", source: ai, referrer_host: host };
  // avant la recherche : mail.google.com est une messagerie, pas un moteur
  if (WEBMAIL.test(host)) return { channel: "email", source: host, referrer_host: host };
  const search = find(SEARCH, host);
  if (search) return { channel: "organic", source: search, referrer_host: host };
  const social = find(SOCIAL, host);
  if (social) return { channel: "social", source: social, referrer_host: host };
  return { channel: "referral", source: host, referrer_host: host };
}

export const AD_CLICK_ID_NAMES = AD_CLICK_IDS.map(([id]) => id);

// ---------------------------------------------------------------------------
// Appareil et navigateur (lecture simple de l'agent utilisateur, rien n'est conservé d'autre)
// ---------------------------------------------------------------------------
export function deviceOf(ua: string): "desktop" | "mobile" | "tablet" {
  if (/ipad|tablet|kindle|silk|playbook|android(?!.*mobile)/i.test(ua)) return "tablet";
  if (/mobi|iphone|ipod|android|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

export function browserOf(ua: string): string {
  if (/edg(e|a|ios)?\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/chrome|crios|chromium/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  return "Autre";
}
