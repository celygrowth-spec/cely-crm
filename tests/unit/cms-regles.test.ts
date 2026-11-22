// CMS : règles partagées (slugs, visibilité, SEO pré-rempli, fuseau de Paris).
import { describe, expect, test } from "vitest";
import { fromParisInput, toParisInput } from "@/lib/cms/dates";
import { isValidSlug, slugify, uniqueSlug } from "@/lib/cms/slug";
import { effectiveStatus, isVisible, readingMinutes, seoDefaults } from "@/lib/cms/types";

describe("slugs", () => {
  test("générés à partir du titre", () => {
    expect(slugify("  L'été : 5 leçons d'œuvre à Noël !  ")).toBe("l-ete-5-lecons-d-oeuvre-a-noel");
    expect(slugify("Été 2026 — Croissance B2B")).toBe("ete-2026-croissance-b2b");
    expect(slugify("!!!")).toBe("");
    expect(slugify("a".repeat(200))).toHaveLength(120);
  });
  test("uniques : suffixe numérique", () => {
    expect(uniqueSlug("Mon article", [])).toBe("mon-article");
    expect(uniqueSlug("Mon article", ["mon-article", "mon-article-2"])).toBe("mon-article-3");
    expect(uniqueSlug("???", [])).toBe("article");
  });
  test("format", () => {
    expect(isValidSlug("mon-article-2")).toBe(true);
    for (const bad of ["", "Mon-article", "mon--article", "-mon", "mon_article", "a/b"]) expect(isValidSlug(bad)).toBe(false);
  });
});

describe("visibilité", () => {
  const now = Date.parse("2026-12-01T10:00:00Z");
  test("programmé ou publié, et date passée", () => {
    expect(isVisible({ status: "draft", publish_at: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(isVisible({ status: "unpublished", publish_at: "2026-11-01T00:00:00Z" }, now)).toBe(false);
    expect(isVisible({ status: "scheduled", publish_at: "2026-12-01T10:00:01Z" }, now)).toBe(false);
    expect(isVisible({ status: "scheduled", publish_at: "2026-12-01T10:00:00Z" }, now)).toBe(true);
    expect(isVisible({ status: "published", publish_at: null }, now)).toBe(false);
    expect(effectiveStatus({ status: "scheduled", publish_at: "2026-12-01T09:00:00Z" }, now)).toBe("published");
    expect(effectiveStatus({ status: "scheduled", publish_at: "2026-12-01T11:00:00Z" }, now)).toBe("scheduled");
  });
});

describe("SEO pré-rempli", () => {
  test("title tag et meta description vides : titre et extrait", () => {
    const d = seoDefaults({ title: "Titre", excerpt: "Un extrait ".repeat(30), seo_title: "", seo_description: null, og_title: null });
    expect(d.title).toBe("Titre");
    expect(d.description.length).toBeLessThanOrEqual(155);
    expect(d.description.endsWith("…")).toBe(true);
    expect(d.ogTitle).toBe("Titre");
    expect(seoDefaults({ title: "T", excerpt: null, seo_title: "Mon title", seo_description: "Ma desc", og_title: null })).toEqual({ title: "Mon title", description: "Ma desc", ogTitle: "Mon title" });
  });
  test("temps de lecture", () => {
    expect(readingMinutes("")).toBe(1);
    expect(readingMinutes(Array(401).fill("mot").join(" "))).toBe(3);
  });
});

describe("heure de Paris (été comme hiver)", () => {
  test("saisie ↔ UTC", () => {
    expect(fromParisInput("2026-07-01T09:30")).toBe("2026-07-01T07:30:00.000Z"); // heure d'été (UTC+2)
    expect(fromParisInput("2026-12-01T09:30")).toBe("2026-12-01T08:30:00.000Z"); // heure d'hiver (UTC+1)
    expect(toParisInput("2026-07-01T07:30:00.000Z")).toBe("2026-07-01T09:30");
    expect(fromParisInput("n'importe quoi")).toBeNull();
  });
});
