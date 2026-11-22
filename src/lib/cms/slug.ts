// Slugs : générés à partir du titre (minuscules, sans accents, tirets), modifiables, uniques par type.
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const SLUG_MAX = 120;

export function slugify(input: string): string {
  const s = input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[œŒ]/g, "oe")
    .replace(/[æÆ]/g, "ae")
    .replace(/ß/g, "ss")
    .toLowerCase()
    .replace(/['’]/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.slice(0, SLUG_MAX).replace(/-+$/g, "");
}

export const isValidSlug = (s: string) => s.length > 0 && s.length <= SLUG_MAX && SLUG_RE.test(s);

/** Premier slug libre : « base », puis « base-2 », « base-3 »… */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const root = slugify(base) || "article";
  if (!used.has(root)) return root;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const candidate = `${root.slice(0, SLUG_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
