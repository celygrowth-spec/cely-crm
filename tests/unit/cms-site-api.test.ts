// CMS lot 5 : contrôle de la clé du site et format renvoyé (SEO pré-rempli, HTML nettoyé).
import { afterEach, expect, test, vi } from "vitest";
import { keyMatches, publicEntry, siteKey } from "@/lib/cms/site-api";

afterEach(() => vi.unstubAllEnvs());
const KEY = "k".repeat(40);

test("clé du site : exacte, en Bearer, 32 caractères au moins", () => {
  vi.stubEnv("CMS_SITE_API_KEY", "trop-courte");
  expect(siteKey()).toBeNull();
  vi.stubEnv("CMS_SITE_API_KEY", KEY);
  expect(siteKey()).toBe(KEY);
  expect(keyMatches(`Bearer ${KEY}`, KEY)).toBe(true);
  for (const h of [null, "", KEY, `Bearer ${KEY}x`, `Bearer ${KEY.slice(1)}`, `Basic ${KEY}`, `Bearer ${"K".repeat(40)}`, "Bearer "]) {
    expect(keyMatches(h, KEY), String(h)).toBe(false);
  }
  expect(keyMatches(`Bearer ${KEY}`, null)).toBe(false);
});

test("format : SEO pré-rempli, image de partage = couverture, HTML sans script", () => {
  const raw = {
    type: "article", slug: "a", title: "Titre", excerpt: "Extrait", body_md: "## Partie\n\n<script>alert(1)</script> [x](javascript:alert(1))",
    cover_image_url: "https://cdn.test/c.png", cover_alt: "Alt", tags: ["t"], secondary_keywords: ["k2"], focus_keyword: "k1", noindex: false,
    published_at: "2026-12-01T08:00:00Z", updated_at: "2026-12-01T08:00:00Z", reading_minutes: 1, extra: {},
  };
  const full = publicEntry(raw, true) as ReturnType<typeof publicEntry> & { content_html: string; headings: unknown[] };
  expect(full.seo).toEqual({ title: "Titre", description: "Extrait", og_title: "Titre", og_image: "https://cdn.test/c.png", canonical: null, noindex: false });
  expect(full.cover_image).toEqual({ url: "https://cdn.test/c.png", alt: "Alt" });
  expect(full.keywords).toEqual(["k1", "k2"]);
  expect(full.content_html).not.toMatch(/<script|href="javascript/i);
  expect(full.headings).toEqual([{ level: 2, text: "Partie", id: "partie" }]);
  expect(publicEntry(raw, false)).not.toHaveProperty("content_html");
});
