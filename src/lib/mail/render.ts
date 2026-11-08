// Rendu d'un email à partir du HTML de l'éditeur (Tiptap) : HTML compatible avec les clients mail
// (styles en ligne, aucune feuille de style, largeur fluide pour le mobile) et version texte.
// Pur et sans dépendance : utilisé par l'aperçu (navigateur) ET par l'envoi (serveur), donc un seul rendu.
// Le HTML reçu est déjà limité au schéma de l'éditeur et nettoyé côté serveur (safeHtml) avant envoi.

const FONT = "font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1a1128";
const STYLES: Record<string, string> = {
  p: "margin:0 0 12px 0",
  ul: "margin:0 0 12px 0;padding-left:24px",
  ol: "margin:0 0 12px 0;padding-left:24px",
  li: "margin:0 0 4px 0",
  a: "color:#682dfe;text-decoration:underline",
  blockquote: "margin:0 0 12px 0;padding-left:12px;border-left:3px solid #ddd3f0;color:#555",
};

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Texte brut → HTML de l'éditeur (paragraphes, sauts de ligne). Sert aux anciens brouillons en texte. */
export function textToHtml(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return "";
  return t.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Ajoute les styles en ligne aux balises produites par l'éditeur. */
export function inlineStyles(html: string): string {
  return html
    // dans une liste, le paragraphe d'un élément ne doit pas ajouter d'espace
    .replace(/<li>\s*<p>/g, "<li>").replace(/<\/p>\s*<\/li>/g, "</li>")
    .replace(/<(p|ul|ol|li|blockquote)(\s[^>]*)?>/g, (_m, tag: string, attrs = "") => `<${tag}${String(attrs).replace(/\sstyle="[^"]*"/g, "")} style="${STYLES[tag]}">`)
    .replace(/<a\s([^>]*?)>/g, (_m, attrs: string) => `<a ${attrs.replace(/\s?style="[^"]*"/g, "").replace(/\s?(target|rel)="[^"]*"/g, "")} style="${STYLES.a}" target="_blank" rel="noopener">`)
    // variable restée sans valeur (aperçu seulement : l'envoi est bloqué tant qu'il en reste)
    .replace(/<span([^>]*data-variable="[^"]*"[^>]*)>/g, '<span$1 style="background:#fef3c7;color:#92400e;border-radius:4px;padding:0 3px">')
    // paragraphe vide de l'éditeur → ligne vide visible partout
    .replace(/<p style="[^"]*"><\/p>/g, `<p style="${STYLES.p}">&nbsp;</p>`);
}

export function signatureHtml(signature: string): string {
  const s = signature.trim();
  if (!s) return "";
  return `<div style="margin-top:20px;color:#555555;font-size:13px;line-height:1.5">-- <br>${escapeHtml(s).replace(/\n/g, "<br>")}</div>`;
}

/** Document HTML complet envoyé : corps + signature, une seule fois, dans un conteneur fluide. */
export function renderEmailHtml(bodyHtml: string, signature: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head>",
    `<body style="margin:0;padding:0"><div style="${FONT};max-width:640px;word-wrap:break-word">`,
    inlineStyles(bodyHtml),
    signatureHtml(signature),
    "</div></body></html>",
  ].join("");
}

const decode = (s: string) =>
  s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Version texte : paragraphes séparés d'une ligne vide, puces, numéros, liens « texte (adresse) ». */
export function htmlToText(html: string): string {
  let out = html.replace(/\r?\n/g, "").replace(/<li([^>]*)>\s*<p[^>]*>/g, "<li$1>").replace(/<\/p>\s*<\/li>/g, "</li>").replace(/<\/li>/g, "");
  // listes numérotées : numéroter chaque élément
  out = out.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/g, (_m, inner: string) => {
    let n = 0;
    return `\n${inner.replace(/<li[^>]*>/g, () => `\n${++n}. `)}\n\n`;
  });
  out = out.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/g, (_m, inner: string) => `\n${inner.replace(/<li[^>]*>/g, "\n• ")}\n\n`);
  out = out
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, "");
      const h = decode(href).replace(/^mailto:/, "");
      return t && decode(t) !== h ? `${t} (${h})` : t || h;
    })
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<\/(p|blockquote|div)>/g, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decode(out)
    .split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/** Le contenu de l'éditeur est-il vide (aucun texte visible) ? */
export const isEmptyHtml = (html: string | null | undefined) => !html || !htmlToText(html).trim();
