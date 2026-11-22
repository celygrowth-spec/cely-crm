// CMS : rendu Markdown sûr, import du frontmatter, aller-retour export → import.
import { describe, expect, test } from "vitest";
import { parseDate, parseMarkdownFile, parisIso, rewriteImages, splitFrontmatter, toMarkdownFile } from "@/lib/cms/frontmatter";
import { imageUrls, renderMarkdown } from "@/lib/cms/markdown";
import type { CmsDraft } from "@/lib/cms/types";

const html = (md: string) => renderMarkdown(md).html;

describe("rendu Markdown", () => {
  test("syntaxe courante", () => {
    expect(html("# Titre\n\nUn **gras**, un *italique*, du `code` et ~~barré~~.")).toBe(
      '<h1 id="titre">Titre</h1>\n<p class="art-lead">Un <strong>gras</strong>, un <em>italique</em>, du <code>code</code> et <del>barré</del>.</p>');
    expect(html("Intro\n\n- a\n- b\n  - b1\n\n1. un\n2. deux").replace('<p class="art-lead">Intro</p>\n', "")).toBe("<ul><li>a</li><li>b<ul><li>b1</li></ul></li></ul>\n<ol><li>un</li><li>deux</li></ol>");
    expect(html("[lien](https://exemple.fr \"t\") ![photo](https://img.test/a.png)")).toBe(
      '<p class="art-lead"><a href="https://exemple.fr" title="t" rel="noopener">lien</a> <img src="https://img.test/a.png" alt="photo" loading="lazy" /></p>');
    expect(html("```ts\nconst a = 1 < 2;\n```")).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
    expect(html("> citation\n\n---\n\n| a | b |\n|---|:-:|\n| 1 | 2 |")).toBe(
      '<blockquote><p>citation</p></blockquote>\n<hr />\n<div class="art-table-wrap"><table class="art-table"><thead><tr><th>a</th><th style="text-align:center">b</th></tr></thead><tbody><tr><td>1</td><td style="text-align:center">2</td></tr></tbody></table></div>');
    expect(renderMarkdown("## Étape 1\n## Étape 1").headings).toEqual([{ level: 2, text: "Étape 1", id: "etape-1" }, { level: 2, text: "Étape 1", id: "etape-1-2" }]);
  });

  test("aucun script ne passe (HTML brut, liens et images piégés)", () => {
    const attacks = [
      "<script>alert(1)</script>",
      "<img src=x onerror=alert(1)>",
      "[clic](javascript:alert(1))",
      "[clic](JaVaScRiPt:alert(1))",
      "[clic](  javascript:alert(1) )",
      "![x](javascript:alert(1))",
      "![x](data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+)",
      "[x](vbscript:msgbox)",
      '[x](https://ok.fr" onmouseover="alert(1))',
      "<a href=\"javascript:alert(1)\">x</a>",
      "<iframe src=https://evil.test></iframe>",
      "```\n</code></pre><script>alert(1)</script>\n```",
      "<svg onload=alert(1)>",
      "[x](//evil.test)",
    ];
    for (const a of attacks) {
      const out = html(a);
      // le texte échappé (&lt;script&gt;) est inoffensif : on cherche de vraies balises ou de vrais attributs
      expect(out, a).not.toMatch(/<(script|iframe|svg|object|embed)\b|<[^>]*\son\w+\s*=|<[a-z][^>]*\s(href|src)\s*=\s*"\s*(javascript:|vbscript:|data:|\/\/)/i);
    }
  });

  test("blocs du site : balisage exact des articles de celygrowth.com", () => {
    expect(html(":::reponse\nUne **réponse**.\n:::")).toBe('<div class="art-answer" id="reponse-directe"><span class="art-answer-label">Réponse directe</span><p>Une <strong>réponse</strong>.</p></div>');
    expect(html(":::retenir\n- un\n- deux\n:::")).toBe('<div class="art-tldr"><span class="art-tldr-label">À retenir</span><ul><li>un</li><li>deux</li></ul></div>');
    expect(html(":::conseil Pourquoi | Mon avis\nTexte\n:::")).toBe('<div class="art-callout art-callout-tip"><span class="art-callout-tag">Mon avis</span><p class="art-callout-title">Pourquoi</p><p>Texte</p></div>');
    expect(html(":::attention\nTexte\n:::")).toContain('<div class="art-callout art-callout-warning"><span class="art-callout-tag">Attention</span>');
    expect(html(":::citation\n100 contactés → 2 rendez-vous\n:::")).toBe('<div class="art-pull">100 contactés → 2 rendez-vous</div>');
    expect(html(":::postit\nLe saviez-vous ?\n:::")).toBe('<aside class="art-postit" aria-label="Culture générale"><p>Le saviez-vous ?</p></aside>');
    expect(html(":::definition\n**Le GEO**, c'est…\n:::")).toBe(`<p class="art-definition"><strong>Le GEO</strong>, c'est…</p>`);
    expect(html(":::faq\n### Question 1 ?\nRéponse 1\n### Question 2 ?\nRéponse 2\n:::")).toBe('<div class="art-faq hp-faq">'
      + '<details class="art-faq-item" open><summary><h3>Question 1 ?</h3><span class="art-faq-icon" aria-hidden="true"></span></summary><div class="art-faq-answer"><p>Réponse 1</p></div></details>'
      + '<details class="art-faq-item"><summary><h3>Question 2 ?</h3><span class="art-faq-icon" aria-hidden="true"></span></summary><div class="art-faq-answer"><p>Réponse 2</p></div></details></div>');
    expect(html(":::outil diagnostic-aarrr\n:::")).toBe('<div data-cms-outil="diagnostic-aarrr"></div>');
    expect(html(":::outil inconnu\n:::")).toBe("<p>[Outil inconnu : inconnu]</p>");
    expect(html('![Schéma](https://img.test/s.png "Le parcours")')).toBe('<figure class="art-figure"><img src="https://img.test/s.png" alt="Schéma" loading="lazy" /><figcaption class="art-figure-cap">Le parcours</figcaption></figure>');
    // l'accroche est le premier paragraphe de l'article, pas celui d'un bloc
    expect(html(":::reponse\nR\n:::\n\nPremier.\n\nSecond.")).toContain('<p class="art-lead">Premier.</p>\n<p>Second.</p>');
  });

  test("blocs : rien d'autre ne passe (classes, attributs, outils hors liste)", () => {
    // HTML saisi dans un bloc : rendu comme du texte
    expect(html(':::citation\n<div class="art-pull" onclick="x()" data-cms-outil="evil">a</div>\n:::')).toBe(
      '<div class="art-pull">&lt;div class="art-pull" onclick="x()" data-cms-outil="evil"&gt;a&lt;/div&gt;</div>');
    // argument piégé : reste une valeur d'attribut échappée
    expect(html(':::postit " onmouseover="alert(1)\nb\n:::')).toBe('<aside class="art-postit" aria-label="&quot; onmouseover=&quot;alert(1)"><p>b</p></aside>');
    // outil hors liste : jamais d'attribut data-cms-outil
    expect(html(':::outil diagnostic-aarrr" onload="alert(1)\n:::')).toBe('<p>[Outil inconnu : diagnostic-aarrr" onload="alert(1)]</p>');
    expect(html(":::faq\n### <img src=x onerror=alert(1)>\nok\n:::")).not.toMatch(/<img[^>]*onerror/i);
  });

  test("images citées", () => {
    expect(imageUrls("![a](https://x.test/1.png) et ![b](<./img/2.png>)")).toEqual(["https://x.test/1.png", "./img/2.png"]);
  });
});

describe("import du frontmatter", () => {
  test("format d'un autre outil : noms usuels, listes, guillemets, texte sur plusieurs lignes", () => {
    const md = `---
title: 'L''art de la relance'
description: >
  Un extrait
  sur deux lignes
date: 2026-12-01 09:30
image: ./images/Couverture.png
categories:
  - Prospection
  - Vente
tags: [relance, "B2B", email]
author: Cely
keywords: relance, prospection
draft: false
custom_field: x
---
# Corps

![schéma](images/schema.png)
`;
    const p = parseMarkdownFile(md, "relance.md");
    expect(p.draft).toMatchObject({
      title: "L'art de la relance", slug: "l-art-de-la-relance", excerpt: "Un extrait sur deux lignes", cover_image_url: "./images/Couverture.png",
      category: "Prospection", tags: ["relance", "B2B", "email"], author: "Cely", secondary_keywords: ["relance", "prospection"], noindex: false,
    });
    expect(p.status).toBe("published");
    expect(p.publish_at).toBe("2026-12-01T08:30:00.000Z"); // 9 h 30 à Paris en hiver
    expect(p.localImages).toEqual(["./images/Couverture.png", "images/schema.png"]);
    expect(p.warnings).toContain("Champ ignoré : custom_field");
    expect(p.missing).toEqual(expect.arrayContaining(["slug", "texte alternatif de la couverture", "mot-clé cible", "title tag (pré-rempli avec le titre)"]));
    expect(p.draft.body_md.startsWith("# Corps")).toBe(true);
  });

  test("sans frontmatter : titre depuis le premier # ; statut programmé sans date → brouillon", () => {
    const p = parseMarkdownFile("Intro\n\n# Mon titre\n\nTexte", "x.md");
    expect(p.draft.title).toBe("Mon titre");
    expect(p.status).toBe("draft");
    const q = parseMarkdownFile("---\ntitle: A\nstatus: scheduled\n---\nx");
    expect(q.status).toBe("draft");
    expect(q.warnings.join(" ")).toMatch(/sans date/);
  });

  test("dates : ISO, heure de Paris en été, jour seul", () => {
    expect(parseDate("2026-07-01T10:00:00+02:00")).toBe("2026-07-01T08:00:00.000Z");
    expect(parseDate("2026-07-01 10:00")).toBe("2026-07-01T08:00:00.000Z");
    expect(parseDate("2026-07-01")).toBe("2026-06-30T22:00:00.000Z");
    expect(parseDate("demain")).toBeNull();
    expect(parisIso("2026-07-01T08:00:00.000Z")).toBe("2026-07-01T10:00:00+02:00");
    expect(parisIso("2026-12-01T08:30:00.250Z")).toBe("2026-12-01T09:30:00.250+01:00");
  });

  test("images locales remplacées par leur adresse dans le stockage", () => {
    const p = parseMarkdownFile("---\ntitle: A\ncover_image: a.png\n---\n![x](a.png) ![y](b.png)");
    const r = rewriteImages(p, new Map([["a.png", "https://cdn.test/a.png"]]));
    expect(r.draft.cover_image_url).toBe("https://cdn.test/a.png");
    expect(r.draft.body_md).toBe("![x](https://cdn.test/a.png) ![y](b.png)");
    expect(r.localImages).toEqual(["b.png"]);
  });
});

describe("aller-retour export → import", () => {
  test("un article exporté puis réimporté est identique", () => {
    const e: CmsDraft & { status: "scheduled"; publish_at: string } = {
      title: "Titre \"avec\" guillemets : et deux-points", slug: "titre-avec-guillemets", excerpt: "Extrait\nsur deux lignes # pas un commentaire",
      body_md: "## Intro\n\n---\n\nTexte avec --- et un frontmatter factice :\n---\ntitle: piège\n---\n", cover_image_url: "https://cdn.test/a.png",
      cover_alt: "Alt 'simple'", category: "SEO", tags: ["a", "b, c"], author: "Moi", focus_keyword: "mot", secondary_keywords: ["x"],
      seo_title: "Title", seo_description: "Desc", og_title: "OG", og_image_url: "https://cdn.test/og.png", canonical_url: "https://www.celygrowth.com/blog/a",
      noindex: true, status: "scheduled", publish_at: "2026-03-29T01:30:00.000Z",
    };
    const file = toMarkdownFile(e);
    expect(splitFrontmatter(file).body).toBe(e.body_md);
    const back = parseMarkdownFile(file, "x.md");
    const { status, publish_at, ...draft } = e;
    expect(back.draft).toEqual(draft);
    expect(back.status).toBe(status);
    expect(back.publish_at).toBe(publish_at);
    expect(back.warnings).toEqual([]);
    // champs vides : non écrits, relus vides
    const empty = toMarkdownFile({ ...e, excerpt: null, tags: [], noindex: false, status: "scheduled" });
    const b2 = parseMarkdownFile(empty);
    expect(b2.draft.excerpt).toBeNull();
    expect(b2.draft.tags).toEqual([]);
    expect(b2.draft.noindex).toBe(false);
  });
});
