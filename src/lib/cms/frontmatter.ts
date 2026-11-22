// Fichiers Markdown d'import et d'export (le CMS fait foi ; le fichier n'est qu'un transport).
// Export : frontmatter YAML dont chaque valeur est écrite en JSON (texte entre guillemets, listes entre crochets),
// ce qui reste du YAML valide et se relit sans perte : export puis réimport redonnent un article identique.
// Import : sous-ensemble YAML courant (valeurs simples, entre guillemets simples ou doubles, listes en ligne ou
// à tirets, textes sur plusieurs lignes « | » et « > »), avec les noms de champs usuels d'autres outils
// (description, date, image, categories, draft…). Les champs manquants sont signalés.
import { CMS_TZ, fromParisInput } from "./dates";
import { slugify } from "./slug";
import type { CmsDraft, CmsEntry, CmsStatus } from "./types";

export type ParsedFile = {
  /** Champs reconnus, prêts à enregistrer. */
  draft: CmsDraft;
  status: CmsStatus;
  publish_at: string | null;
  /** Champs attendus mais absents (libellés lisibles). */
  missing: string[];
  /** Remarques : champ inconnu, date illisible, statut sans date… */
  warnings: string[];
  /** Images citées par une adresse relative (à fournir avec le fichier). */
  localImages: string[];
};

const ORDER: [keyof CmsDraft | "status" | "publish_at", string][] = [
  ["title", "title"], ["slug", "slug"], ["excerpt", "excerpt"], ["cover_image_url", "cover_image"], ["cover_alt", "cover_alt"],
  ["category", "category"], ["tags", "tags"], ["author", "author"], ["focus_keyword", "focus_keyword"],
  ["secondary_keywords", "secondary_keywords"], ["seo_title", "seo_title"], ["seo_description", "seo_description"],
  ["og_title", "og_title"], ["og_image_url", "og_image"], ["canonical_url", "canonical"], ["noindex", "noindex"],
  ["status", "status"], ["publish_at", "publish_at"],
];

/** Date ISO avec le décalage de Paris (« 2026-12-01T09:30:00+01:00 »), lisible et exacte (millisecondes si besoin). */
export function parisIso(iso: string): string {
  const d = new Date(iso);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: CMS_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
  const g = (k: string) => p.find((x) => x.type === k)!.value;
  const ms = d.getUTCMilliseconds();
  const local = `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${ms ? `.${String(ms).padStart(3, "0")}` : ""}`;
  const off = Math.round((Date.UTC(+g("year"), +g("month") - 1, +g("day"), +g("hour"), +g("minute"), +g("second"), ms) - d.getTime()) / 60000);
  const a = Math.abs(off);
  return `${local}${off >= 0 ? "+" : "-"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Fichier .md d'un contenu : frontmatter puis contenu Markdown tel quel. */
export function toMarkdownFile(e: Pick<CmsEntry, keyof CmsDraft | "status" | "publish_at">): string {
  const lines = ["---"];
  for (const [field, key] of ORDER) {
    let v: unknown = e[field as keyof typeof e];
    if (field === "publish_at" && typeof v === "string") v = parisIso(v);
    if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
    if (field === "noindex" && v === false) continue;
    lines.push(`${key}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n${e.body_md}`;
}

export const exportFileName = (slug: string) => `${slug}.md`;

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------
type Value = string | number | boolean | null | Value[];

function scalar(raw: string): Value {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return null;
  if (v.startsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v.slice(1, v.endsWith('"') ? -1 : undefined); }
  }
  if (v.startsWith("'")) return v.slice(1, v.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  if (v.startsWith("[")) {
    try { return JSON.parse(v) as Value[]; } catch {
      return v.replace(/^\[|\]$/g, "").split(",").map((x) => scalar(x)).filter((x) => x !== null);
    }
  }
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off)$/i.test(v)) return false;
  // un commentaire en fin de ligne n'est retiré que s'il est précédé d'une espace
  return v.replace(/\s+#.*$/, "");
}

/** Sépare frontmatter et contenu. Sans frontmatter, tout est contenu. */
export function splitFrontmatter(text: string): { data: Record<string, Value>; body: string; hasFrontmatter: boolean } {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src, hasFrontmatter: false };
  const data: Record<string, Value> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const rest = kv[2].trim();
    if (rest === "" || rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      // liste à tirets ou texte sur plusieurs lignes (indenté)
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || /^-\s/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        if (lines[i + 1].trim() === "" && !(i + 2 < lines.length && /^\s+\S/.test(lines[i + 2]))) break;
        block.push(lines[++i]);
      }
      if (block.length && block.every((b) => /^\s*-\s/.test(b) || !b.trim())) data[key] = block.filter((b) => b.trim()).map((b) => scalar(b.replace(/^\s*-\s/, "")));
      else if (block.length) data[key] = rest.startsWith(">") ? block.map((b) => b.trim()).join(" ").trim() : block.map((b) => b.replace(/^\s{2}/, "")).join("\n").trimEnd();
      else data[key] = null;
    } else data[key] = scalar(rest);
  }
  return { data, body: src.slice(m[0].length), hasFrontmatter: true };
}

const str = (v: Value | undefined): string | null => {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.length ? String(v[0]) : null;
  const s = String(v).trim();
  return s || null;
};
const arr = (v: Value | undefined): string[] => {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v).split(",").map((x) => x.trim()).filter(Boolean);
};
const first = (d: Record<string, Value>, ...keys: string[]) => {
  for (const k of keys) if (d[k] !== undefined && d[k] !== null && d[k] !== "") return { key: k, value: d[k] };
  return null;
};

/** Date du frontmatter : ISO avec décalage, ou heure de Paris (« 2026-12-01 09:30 », « 2026-12-01 » = minuit). */
export function parseDate(v: Value | undefined): string | null {
  const s = str(v);
  if (!s) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && Number.isFinite(Date.parse(s))) return new Date(s).toISOString();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (!m) return null;
  return fromParisInput(`${m[1]}T${(m[2] ?? "00").padStart(2, "0")}:${m[3] ?? "00"}`);
}

const KNOWN = new Set(["title", "slug", "excerpt", "description", "summary", "cover_image", "cover", "image", "heroimage", "hero_image",
  "featured_image", "thumbnail", "cover_alt", "image_alt", "alt", "category", "categories", "tags", "author", "authors", "focus_keyword",
  "keyword", "secondary_keywords", "keywords", "seo_title", "meta_title", "seo_description", "meta_description", "og_title", "og_image",
  "canonical", "canonical_url", "noindex", "robots", "status", "draft", "publish_at", "date", "pubdate", "published_at", "published",
  "updated", "lastmod", "updated_at", "reading_time", "layout", "lang"]);

const isUrl = (s: string | null) => !!s && /^https?:\/\//i.test(s);

/** Lit un fichier .md : champs du contenu, statut, date, champs manquants et images à fournir. */
export function parseMarkdownFile(text: string, fileName = "article.md"): ParsedFile {
  const { data: d, body, hasFrontmatter } = splitFrontmatter(text);
  const warnings: string[] = [];
  if (!hasFrontmatter) warnings.push("Aucun frontmatter : seuls le titre (premier titre # ou nom du fichier) et le contenu sont repris.");
  for (const k of Object.keys(d)) if (!KNOWN.has(k)) warnings.push(`Champ ignoré : ${k}`);

  const bodyMd = body;
  let title = str(first(d, "title")?.value);
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(body);
    title = h1 ? h1[1].trim() : fileName.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "Sans titre";
  }
  const cover = str(first(d, "cover_image", "cover", "image", "heroimage", "hero_image", "featured_image", "thumbnail")?.value);
  const og = str(d.og_image);
  const robots = str(d.robots);
  const draft: CmsDraft = {
    title,
    slug: slugify(str(d.slug) ?? title) || "article",
    excerpt: str(first(d, "excerpt", "description", "summary")?.value),
    body_md: bodyMd,
    cover_image_url: cover,
    cover_alt: str(first(d, "cover_alt", "image_alt", "alt")?.value),
    category: str(first(d, "category", "categories")?.value),
    tags: arr(d.tags),
    author: str(first(d, "author", "authors")?.value),
    focus_keyword: str(first(d, "focus_keyword", "keyword")?.value),
    secondary_keywords: arr(first(d, "secondary_keywords", "keywords")?.value ?? null),
    seo_title: str(first(d, "seo_title", "meta_title")?.value),
    seo_description: str(first(d, "seo_description", "meta_description")?.value),
    og_title: str(d.og_title),
    og_image_url: og,
    canonical_url: str(first(d, "canonical", "canonical_url")?.value),
    noindex: d.noindex === true || (!!robots && /noindex/i.test(robots)),
  };
  if (str(d.slug) && slugify(str(d.slug)!) !== str(d.slug)) warnings.push(`Slug corrigé : « ${str(d.slug)} » devient « ${draft.slug} »`);

  const dateField = first(d, "publish_at", "date", "pubdate", "published_at");
  const publishAt = dateField ? parseDate(dateField.value) : null;
  if (dateField && !publishAt) warnings.push(`Date illisible (${dateField.key}) : « ${str(dateField.value)} »`);
  let status: CmsStatus = "draft";
  const st = str(d.status)?.toLowerCase();
  const STATUS: Record<string, CmsStatus> = { draft: "draft", brouillon: "draft", scheduled: "scheduled", "programmé": "scheduled", programme: "scheduled",
    published: "published", "publié": "published", publie: "published", unpublished: "unpublished", "dépublié": "unpublished", depublie: "unpublished" };
  if (st) {
    if (STATUS[st]) status = STATUS[st];
    else warnings.push(`Statut inconnu « ${st} » : l'article est importé en brouillon`);
  } else if (d.draft === false || d.published === true) status = publishAt ? "published" : "draft";
  if ((status === "scheduled" || status === "published") && !publishAt) {
    warnings.push("Statut publié ou programmé sans date : l'article est importé en brouillon");
    status = "draft";
  }
  if (draft.canonical_url && !isUrl(draft.canonical_url)) {
    warnings.push(`URL canonique ignorée (adresse complète attendue) : ${draft.canonical_url}`);
    draft.canonical_url = null;
  }

  const missing: string[] = [];
  if (!str(d.title)) missing.push("titre");
  if (!str(d.slug)) missing.push("slug");
  if (!draft.excerpt) missing.push("extrait");
  if (!draft.cover_image_url) missing.push("image de couverture");
  if (draft.cover_image_url && !draft.cover_alt) missing.push("texte alternatif de la couverture");
  if (!draft.category) missing.push("catégorie");
  if (!draft.author) missing.push("auteur");
  if (!draft.focus_keyword) missing.push("mot-clé cible");
  if (!draft.seo_title) missing.push("title tag (pré-rempli avec le titre)");
  if (!draft.seo_description) missing.push("meta description (pré-remplie avec l'extrait)");
  if (!publishAt) missing.push("date de publication");
  if (!bodyMd.trim()) missing.push("contenu");

  const local = new Set<string>();
  for (const u of [draft.cover_image_url, draft.og_image_url]) if (u && !isUrl(u)) local.add(u);
  for (const m of bodyMd.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?/g)) if (!isUrl(m[1])) local.add(m[1]);
  return { draft, status, publish_at: status === "draft" && !publishAt ? null : publishAt, missing, warnings, localImages: [...local] };
}

/** Remplace les adresses d'images locales par leurs adresses dans le stockage. */
export function rewriteImages(p: ParsedFile, map: Map<string, string>): ParsedFile {
  const swap = (u: string | null) => (u && map.has(u) ? map.get(u)! : u);
  const body = p.draft.body_md.replace(/(!\[[^\]]*\]\(\s*<?)([^\s)>]+)/g, (all, pre: string, u: string) => (map.has(u) ? pre + map.get(u) : all));
  return { ...p, draft: { ...p.draft, body_md: body, cover_image_url: swap(p.draft.cover_image_url), og_image_url: swap(p.draft.og_image_url) },
    localImages: p.localImages.filter((u) => !map.has(u)) };
}

/** Nom de fichier d'une adresse locale (« ./images/photo.png » → « photo.png »). */
export const baseName = (path: string) => decodeURIComponent(path.split(/[\\/]/).pop() ?? path).toLowerCase();
