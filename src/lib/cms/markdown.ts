// Markdown → HTML sûr, pour l'aperçu de l'éditeur et pour le site (content_html de l'accès en lecture).
// Deux protections indépendantes contre l'injection de script :
//  1. le rendu échappe TOUT le HTML saisi (le HTML brut n'est pas pris en charge) et n'accepte que des liens
//     http(s), mailto, tel, relatifs ou ancres ;
//  2. le résultat passe par sanitize-html avec une liste fermée de balises, d'attributs et de schémas.
// Syntaxe prise en charge : titres #, paragraphes, gras, italique, barré, code (en ligne et blocs ```), citations,
// listes (à puces, numérotées, imbriquées, cases à cocher), liens, images, règles horizontales, tableaux,
// retours à la ligne (deux espaces ou « \ » en fin de ligne).
// Blocs du site (« :::nom arguments » … « ::: ») rendus avec le balisage exact des articles de celygrowth.com :
// reponse, retenir, conseil, attention, resume, citation, postit, definition, faq, outil (voir docs/cms-modele-article.md).
// Une image seule dans son paragraphe avec un titre (« ![alt](url "légende") ») devient une figure légendée ;
// le premier paragraphe de l'article est l'accroche (art-lead).
import sanitizeHtml from "sanitize-html";
import { slugify } from "./slug";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Adresse acceptée dans un lien ou une image (jamais javascript:, data:, vbscript:…). */
export function safeUrl(raw: string, kind: "link" | "image"): string | null {
  const u = raw.trim().replace(/^<|>$/g, "");
  if (!u || /[\s<>"'`\\]/.test(u)) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (kind === "link" && /^(mailto:|tel:)/i.test(u)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null; // tout autre schéma est refusé
  if (u.startsWith("//")) return null;
  return u; // relatif ou ancre
}

// ---------------------------------------------------------------------------
// En ligne
// ---------------------------------------------------------------------------
function inline(src: string): string {
  const slots: string[] = [];
  const keep = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src;
  // échappements Markdown (\* \_ …)
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, c: string) => keep(esc(c)));
  // code en ligne
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, code: string) => keep(`<code>${esc(code.trim())}</code>`));
  // images puis liens : ![alt](url "titre") / [texte](url "titre")
  const target = /\(\s*(<[^>]*>|[^\s()]*(?:\([^\s()]*\)[^\s()]*)*)(?:\s+"([^"]*)")?\s*\)/.source;
  s = s.replace(new RegExp(`!\\[([^\\]]*)\\]${target}`, "g"), (m, alt: string, url: string, title?: string) => {
    const u = safeUrl(url, "image");
    if (!u) return keep(esc(alt));
    return keep(`<img src="${esc(u)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy" />`);
  });
  s = s.replace(new RegExp(`\\[([^\\]]+)\\]${target}`, "g"), (m, text: string, url: string, title?: string) => {
    const u = safeUrl(url, "link");
    const label = inline(text);
    if (!u) return keep(label);
    const ext = /^https?:\/\//i.test(u);
    return keep(`<a href="${esc(u)}"${title ? ` title="${esc(title)}"` : ""}${ext ? ' rel="noopener"' : ""}>${label}</a>`);
  });
  // liens automatiques <https://…>
  s = s.replace(/<((?:https?:\/\/|mailto:)[^\s<>]+)>/gi, (_, u: string) => keep(`<a href="${esc(u)}">${esc(u)}</a>`));
  s = esc(s);
  s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  s = s.replace(/( {2,}|\\)\n/g, "<br />\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => slots[Number(i)]);
}

// ---------------------------------------------------------------------------
// Blocs
// ---------------------------------------------------------------------------
type Heading = { level: number; text: string; id: string };

/** Outils interactifs du site insérables avec « :::outil nom » (le site injecte leur code). */
export const CMS_OUTILS = ["simulateur-inbound-outbound", "generateur-prompts", "audit-geo", "diagnostic-aarrr", "generateur-lead-magnet"] as const;

/** Blocs reconnus (« :::nom »). */
export const CMS_BLOCS = ["reponse", "retenir", "conseil", "attention", "resume", "citation", "postit", "definition", "faq", "outil"] as const;

const RE = {
  block: /^ {0,3}:::\s*([a-z][a-z-]*)\s*(.*?)\s*$/,
  blockEnd: /^ {0,3}:::\s*$/,
  fence: /^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/,
  heading: /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^ {0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^ {0,3}>\s?/,
  item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
};

function splitRow(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function unwrapP(html: string): string {
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html.trim());
  return m && !m[1].includes("<p>") ? m[1] : html;
}

/** Bloc « :::nom » : balisage des articles du site. Un nom inconnu rend simplement son contenu. */
function renderDirective(name: string, args: string, body: string[], headings: Heading[], ids: Map<string, number>): string {
  const inner = () => renderBlocks(body, headings, ids, false);
  const [title, label] = args.split("|").map((x) => x.trim());
  switch (name) {
    case "reponse":
      return `<div class="art-answer" id="reponse-directe"><span class="art-answer-label">${esc(title || "Réponse directe")}</span>${inner()}</div>`;
    case "retenir":
      return `<div class="art-tldr"><span class="art-tldr-label">${esc(title || "À retenir")}</span>${inner()}</div>`;
    case "conseil":
    case "attention":
    case "resume": {
      const kind = { conseil: "tip", attention: "warning", resume: "summary" }[name];
      const tag = label || { conseil: "Conseil Cély", attention: "Attention", resume: "En résumé" }[name];
      return `<div class="art-callout art-callout-${kind}"><span class="art-callout-tag">${esc(tag)}</span>${title ? `<p class="art-callout-title">${inline(title)}</p>` : ""}${inner()}</div>`;
    }
    case "citation":
      return `<div class="art-pull">${unwrapP(inner())}</div>`;
    case "postit":
      return `<aside class="art-postit" aria-label="${esc(title || "Culture générale")}">${inner()}</aside>`;
    case "definition":
      return `<p class="art-definition">${unwrapP(inner())}</p>`;
    case "faq": {
      // « ### Question » puis la réponse, jusqu'à la question suivante ; la première est ouverte
      const items: { q: string; a: string[] }[] = [];
      for (const l of body) {
        const q = /^ {0,3}#{2,4}\s+(.*?)\s*#*\s*$/.exec(l);
        if (q) items.push({ q: q[1], a: [] });
        else if (items.length) items[items.length - 1].a.push(l);
      }
      return `<div class="art-faq hp-faq">${items.map((it, k) => `<details class="art-faq-item"${k === 0 ? " open" : ""}><summary><h3>${inline(it.q)}</h3><span class="art-faq-icon" aria-hidden="true"></span></summary><div class="art-faq-answer">${renderBlocks(it.a, headings, ids, false)}</div></details>`).join("")}</div>`;
    }
    case "outil":
      return (CMS_OUTILS as readonly string[]).includes(title) ? `<div data-cms-outil="${title}"></div>` : `<p>[Outil inconnu : ${esc(title)}]</p>`;
    default:
      return inner();
  }
}

function renderBlocks(lines: string[], headings: Heading[], ids: Map<string, number>, top = true): string {
  const out: string[] = [];
  let i = 0;
  let lead = top;
  const isBlank = (l: string | undefined) => l === undefined || l.trim() === "";
  const startsBlock = (l: string) => RE.block.test(l) || RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.item.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const dir = RE.block.exec(line);
    if (dir && !RE.blockEnd.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !RE.blockEnd.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(renderDirective(dir[1], dir[2], body, headings, ids));
      continue;
    }
    if (RE.blockEnd.test(line)) { i++; continue; } // « ::: » orphelin

    const fence = RE.fence.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++]);
      i++;
      const lang = fence[2] ? ` class="language-${esc(fence[2].toLowerCase())}"` : "";
      out.push(`<pre><code${lang}>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }

    const h = RE.heading.exec(line);
    if (h) {
      const level = h[1].length;
      const html = inline(h[2]);
      const plain = h[2].replace(/[*_`~[\]()!]/g, "").trim();
      let id = slugify(plain) || "section";
      const n = ids.get(id) ?? 0;
      ids.set(id, n + 1);
      if (n) id = `${id}-${n + 1}`;
      headings.push({ level, text: plain, id });
      out.push(`<h${level} id="${id}">${html}</h${level}>`);
      i++;
      continue;
    }

    if (RE.hr.test(line)) { out.push("<hr />"); i++; continue; }

    if (RE.quote.test(line)) {
      const body: string[] = [];
      while (i < lines.length && !isBlank(lines[i]) && (RE.quote.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(RE.quote, ""));
      out.push(`<blockquote>${renderBlocks(body, headings, ids, false)}</blockquote>`);
      continue;
    }

    const item = RE.item.exec(line);
    if (item) {
      const baseIndent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const start = ordered ? parseInt(item[2], 10) : 1;
      const items: string[][] = [];
      while (i < lines.length) {
        const m = RE.item.exec(lines[i]);
        if (m && m[1].length <= baseIndent + 1 && /\d/.test(m[2]) === ordered) {
          items.push([m[3]]);
          i++;
          continue;
        }
        if (!items.length) break;
        if (isBlank(lines[i])) {
          // une ligne vide ne termine la liste que si la suivante n'en fait plus partie
          const next = lines[i + 1];
          const nm = next === undefined ? null : RE.item.exec(next);
          const sameList = !!nm && nm[1].length <= baseIndent + 1 && /\d/.test(nm[2]) === ordered;
          if (next !== undefined && (sameList || /^\s{2,}\S/.test(next))) { i++; continue; }
          break;
        }
        if (/^\s{2,}\S/.test(lines[i]) || (!startsBlock(lines[i]) && !RE.item.test(lines[i]))) {
          items[items.length - 1].push(lines[i].replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ""));
          i++;
          continue;
        }
        break;
      }
      const lis = items.map((parts) => {
        let first = parts[0];
        let check = "";
        const task = /^\[( |x|X)\]\s+(.*)$/.exec(first);
        if (task) { check = `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""} /> `; first = task[2]; }
        const rest = parts.slice(1);
        const nested = rest.length ? renderBlocks(rest, headings, ids, false) : "";
        return `<li>${check}${inline(first)}${nested}</li>`;
      });
      out.push(ordered ? `<ol${start !== 1 ? ` start="${start}"` : ""}>${lis.join("")}</ol>` : `<ul>${lis.join("")}</ul>`);
      continue;
    }

    if (line.includes("|") && lines[i + 1] !== undefined && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (tag: string, c: string, k: number) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
      out.push(`<div class="art-table-wrap"><table class="art-table"><thead><tr>${head.map((c, k) => cell("th", c, k)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++]);
    const fig = para.length === 1 ? /^\s*!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?\s+"([^"]+)"\s*\)\s*$/.exec(para[0]) : null;
    const src = fig ? safeUrl(fig[2], "image") : null;
    if (fig && src) {
      out.push(`<figure class="art-figure"><img src="${esc(src)}" alt="${esc(fig[1])}" loading="lazy" /><figcaption class="art-figure-cap">${inline(fig[3])}</figcaption></figure>`);
      continue;
    }
    out.push(`<p${lead ? ' class="art-lead"' : ""}>${inline(para.join("\n"))}</p>`);
    lead = false;
  }
  return out.join("\n");
}

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ["h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "input",
    "div", "span", "aside", "details", "summary", "figure", "figcaption"],
  allowedAttributes: {
    a: ["href", "title", "rel"], img: ["src", "alt", "title", "loading"], code: ["class"], ol: ["start"],
    h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"], th: ["style"], td: ["style"], input: ["type", "checked", "disabled"],
    div: [{ name: "id", multiple: false, values: ["reponse-directe"] }, { name: "data-cms-outil", multiple: false, values: [...CMS_OUTILS] }],
    span: [{ name: "aria-hidden", multiple: false, values: ["true"] }], aside: ["aria-label"], details: ["open"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  allowProtocolRelative: false,
  allowedStyles: { th: { "text-align": [/^(left|right|center)$/] }, td: { "text-align": [/^(left|right|center)$/] } },
  allowedClasses: {
    code: [/^language-[\w+-]+$/],
    div: ["art-answer", "art-tldr", "art-callout", "art-callout-tip", "art-callout-warning", "art-callout-summary", "art-pull", "art-faq", "hp-faq", "art-table-wrap", "art-faq-answer"],
    span: ["art-answer-label", "art-tldr-label", "art-callout-tag", "art-faq-icon"],
    p: ["art-callout-title", "art-definition", "art-lead"],
    aside: ["art-postit"], details: ["art-faq-item"], figure: ["art-figure"], figcaption: ["art-figure-cap"], table: ["art-table"],
  },
  disallowedTagsMode: "escape",
  exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox",
};

/** Rend le Markdown en HTML sûr ; renvoie aussi les titres (sommaire). */
export function renderMarkdown(md: string): { html: string; headings: Heading[] } {
  const headings: Heading[] = [];
  const raw = renderBlocks(md.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), headings, new Map());
  return { html: sanitizeHtml(raw, SANITIZE), headings };
}

/** Adresses des images citées dans le Markdown (corps d'un article). */
export function imageUrls(md: string): string[] {
  return [...md.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g)].map((m) => m[1]);
}
