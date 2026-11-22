// CMS : types et règles partagés (interface, actions, accès du site). Aucune dépendance serveur.

export type CmsType = "article";
export const CMS_TYPE_LABEL: Record<CmsType, string> = { article: "Article" };

export type CmsStatus = "draft" | "scheduled" | "published" | "unpublished";
export const STATUS_LABEL: Record<CmsStatus, string> = {
  draft: "Brouillon",
  scheduled: "Programmé",
  published: "Publié",
  unpublished: "Dépublié",
};
export const STATUS_TONE: Record<CmsStatus, "neutral" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  scheduled: "warning",
  published: "success",
  unpublished: "danger",
};

export type CmsEntry = {
  id: string;
  type: CmsType;
  title: string;
  slug: string;
  excerpt: string | null;
  body_md: string;
  cover_image_url: string | null;
  cover_alt: string | null;
  category: string | null;
  tags: string[];
  author: string | null;
  focus_keyword: string | null;
  secondary_keywords: string[];
  seo_title: string | null;
  seo_description: string | null;
  og_title: string | null;
  og_image_url: string | null;
  canonical_url: string | null;
  noindex: boolean;
  status: CmsStatus;
  publish_at: string | null;
  first_published_at: string | null;
  content_updated_at: string;
  reading_minutes: number;
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** Champs modifiables d'un contenu (le statut et la date passent par les actions dédiées). */
export const EDITABLE_FIELDS = [
  "title", "slug", "excerpt", "body_md", "cover_image_url", "cover_alt", "category", "tags", "author",
  "focus_keyword", "secondary_keywords", "seo_title", "seo_description", "og_title", "og_image_url", "canonical_url", "noindex",
] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
export type CmsDraft = Pick<CmsEntry, EditableField>;

/** Visible sur le site : programmé ou publié, et date passée. Miroir de cms_private.is_visible. */
export function isVisible(e: Pick<CmsEntry, "status" | "publish_at">, now: number = Date.now()): boolean {
  return (e.status === "scheduled" || e.status === "published") && !!e.publish_at && Date.parse(e.publish_at) <= now;
}

/** Statut affiché : un programmé dont la date est passée est déjà publié (la base le rattrape au passage suivant). */
export function effectiveStatus(e: Pick<CmsEntry, "status" | "publish_at">, now: number = Date.now()): CmsStatus {
  return e.status === "scheduled" && isVisible(e, now) ? "published" : e.status;
}

/** Repères de longueur affichés sous les champs SEO. */
export const SEO_LIMITS = { title: 60, description: 155 } as const;

/** Title tag et meta description effectifs : un champ vide est pré-rempli à partir du titre ou de l'extrait. */
export function seoDefaults(e: Pick<CmsEntry, "title" | "excerpt" | "seo_title" | "seo_description" | "og_title">) {
  const title = e.seo_title?.trim() || e.title.trim();
  const description = e.seo_description?.trim() || truncate(e.excerpt?.trim() ?? "", SEO_LIMITS.description);
  return { title, description, ogTitle: e.og_title?.trim() || title };
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Temps de lecture (miroir de cms_private.reading_minutes) : 200 mots par minute, une au moins. */
export function readingMinutes(md: string): number {
  const words = md.trim() ? md.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 200));
}
