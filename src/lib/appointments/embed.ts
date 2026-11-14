// Codes d'intégration des pages de réservation (widgets).
// Contrat public, à ne pas casser : les codes déjà collés sur des sites doivent continuer de fonctionner.
//   <script src="{APP}/api/rdv/widget.js" async></script>
//   data-cely-rdv="inline" | "floating" | "popup" | "button"  (+ data-url, data-text)
// Le code ne contient aucun secret : seulement l'adresse publique de la page de réservation.

export type EmbedKind = "inline" | "floating" | "popup" | "button";

export const EMBED_PATH = "integre";
export const WIDGET_SCRIPT_PATH = "/api/rdv/widget.js";
export const DEFAULT_BUTTON_TEXT = "Prendre rendez-vous";
export const MAX_BUTTON_TEXT = 60;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function cleanButtonText(text: string | null | undefined): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_BUTTON_TEXT);
  return t || DEFAULT_BUTTON_TEXT;
}

/** Code à coller. `baseUrl` = adresse publique du CRM, `slug` = lien du type de rendez-vous. */
export function embedCode(kind: EmbedKind, p: { baseUrl: string; slug: string; text?: string }): string {
  const base = p.baseUrl.replace(/\/+$/, "");
  const url = `${base}/rdv/${encodeURIComponent(p.slug)}`;
  const text = escapeHtml(cleanButtonText(p.text));
  const script = `<script src="${base}${WIDGET_SCRIPT_PATH}" async></script>`;
  const u = escapeHtml(url);
  switch (kind) {
    case "inline":
      // le lien reste visible si le script ne se charge pas
      return `<!-- Réservation Cely Growth : calendrier dans la page -->\n<div data-cely-rdv="inline" data-url="${u}"><a href="${u}">Prendre rendez-vous</a></div>\n${script}`;
    case "floating":
      return `<!-- Réservation Cely Growth : bouton flottant -->\n<div data-cely-rdv="floating" data-url="${u}" data-text="${text}"><a href="${u}">${text}</a></div>\n${script}`;
    case "button":
      return `<!-- Réservation Cely Growth : bouton -->\n<div data-cely-rdv="button" data-url="${u}" data-text="${text}" style="display:inline-block"><a href="${u}">${text}</a></div>\n${script}`;
    case "popup":
      // lien texte : garde le style du site ; sans script, il ouvre simplement la page de réservation
      return `<!-- Réservation Cely Growth : lien -->\n<a href="${u}" data-cely-rdv="popup">${text}</a>\n${script}`;
  }
}
