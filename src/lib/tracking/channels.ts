// Couleur et libellé de chaque source : les mêmes partout (courbes, répartitions, fiches, listes).
// Ordre fixe = ordre d'empilement des graphiques. Palette catégorielle validée (daltonisme, contraste) pour les
// deux surfaces ; la variante sombre est choisie, pas calculée. Une source garde sa couleur quel que soit le filtre.
import { CHANNEL_LABEL, type Channel } from "./sources";

export const CHANNEL_ORDER: Channel[] = ["direct", "campaign", "organic", "social", "email", "referral", "ai", "paid"];

export const CHANNEL_COLOR: Record<Channel, { light: string; dark: string }> = {
  direct: { light: "#2a78d6", dark: "#3987e5" },
  campaign: { light: "#eb6834", dark: "#d95926" },
  organic: { light: "#1baf7a", dark: "#199e70" },
  social: { light: "#eda100", dark: "#c98500" },
  email: { light: "#e87ba4", dark: "#d55181" },
  referral: { light: "#008300", dark: "#0ca30c" },
  ai: { light: "#6250d6", dark: "#9085e9" },
  paid: { light: "#e34948", dark: "#e66767" },
};

/** Couleur d'une source dans l'espace Tracking site (suit le mode clair ou sombre par variable CSS). */
export const channelVar = (c: string) => `var(--trk-c-${c in CHANNEL_COLOR ? c : "direct"})`;

export const channelLabel = (c: string | null | undefined) => (c && c in CHANNEL_LABEL ? CHANNEL_LABEL[c as Channel] : "Inconnue");

const SOURCE_NAMES: Record<string, string> = {
  google: "Google", bing: "Bing", duckduckgo: "DuckDuckGo", yahoo: "Yahoo", ecosia: "Ecosia", qwant: "Qwant", brave: "Brave", yandex: "Yandex",
  chatgpt: "ChatGPT", perplexity: "Perplexity", claude: "Claude", gemini: "Gemini", copilot: "Copilot", mistral: "Le Chat (Mistral)", deepseek: "DeepSeek", grok: "Grok", "meta-ai": "Meta AI",
  linkedin: "LinkedIn", facebook: "Facebook", instagram: "Instagram", x: "X (Twitter)", youtube: "YouTube", tiktok: "TikTok", whatsapp: "WhatsApp",
};
/** Nom lisible d'une source précise (google → Google) ; un domaine ou une valeur UTM restent tels quels. */
export const sourceName = (s: string | null | undefined) => (s ? SOURCE_NAMES[s] ?? s : null);

/** « Campagne · linkedin / lancement », « Recherche organique · Google », « Direct » */
export function touchLabel(t: { channel?: string | null; source?: string | null; campaign?: string | null } | null | undefined): string {
  if (!t?.channel) return "Inconnue";
  const detail = t.channel === "campaign" ? [t.source, t.campaign].filter(Boolean).join(" / ") : sourceName(t.source);
  return detail ? `${channelLabel(t.channel)} · ${detail}` : channelLabel(t.channel);
}
