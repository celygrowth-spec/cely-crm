// Marquage automatique des liens vers celygrowth.com dans les messages préparés ou envoyés par le CRM.
// Un lien qui porte déjà des UTM, un lien vers un autre site et tout le reste du message restent tels quels.
import { slugUtm, tagSiteUrl, type Utm } from "./utm";

/** Mail envoyé depuis le module Mail. */
export const MAIL_UTM: Utm = { utm_source: "email", utm_medium: "email", utm_campaign: "mail-direct" };

/** Message d'une campagne de prospection : support = canal de l'étape, campagne = nom de la campagne. */
export function prospectionUtm(campaignName: string, channel: string): Utm {
  return {
    utm_source: "prospection",
    utm_medium: channel === "linkedin" ? "linkedin" : channel === "email" ? "email" : "message",
    utm_campaign: slugUtm(campaignName) || "prospection",
  };
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
const encode = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** HTML : seuls les attributs href des liens sont réécrits. */
export function tagHtmlLinks(html: string, utm: Utm): string {
  return html.replace(/(<a\s[^>]*?href=")([^"]*)(")/gi, (_m, before: string, href: string, after: string) => {
    const original = decode(href);
    const tagged = tagSiteUrl(original, utm);
    return tagged === original ? `${before}${href}${after}` : `${before}${encode(tagged)}${after}`;
  });
}

// adresse du site écrite en clair, avec ou sans « https:// » ; la ponctuation finale n'en fait pas partie
const TEXT_URL = /(^|[\s(<«"'])((?:https?:\/\/)?(?:www\.)?celygrowth\.com(?:[/?#][^\s<>»"')\]]*)?)/gi;

/** Texte brut (mail sans mise en forme, message LinkedIn copié) : les adresses du site reçoivent leurs UTM. */
export function tagTextLinks(text: string, utm: Utm): string {
  return text.replace(TEXT_URL, (_m, before: string, url: string) => {
    const trail = /[.,;:!?…]+$/.exec(url)?.[0] ?? "";
    const core = trail ? url.slice(0, -trail.length) : url;
    const tagged = tagSiteUrl(/^https?:\/\//i.test(core) ? core : `https://${core}`, utm);
    return `${before}${tagged}${trail}`;
  });
}
