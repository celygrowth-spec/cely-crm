// Rendu des emails : HTML compatible clients mail (styles en ligne, signature une seule fois) et texte.
import { describe, expect, test } from "vitest";
import { htmlToText, inlineStyles, isEmptyHtml, renderEmailHtml, textToHtml } from "@/lib/mail/render";

const EDITOR = '<p>Bonjour <strong>Claire</strong>,</p><p></p><ul><li><p>Audit SEO</p></li><li><p>Campagnes</p></li></ul><ol><li><p>Un</p></li><li><p>Deux</p></li></ol><p>Voir <a target="_blank" rel="noopener noreferrer nofollow" href="https://cely.fr/offre">notre offre</a> ou <a href="mailto:c@cely.fr">c@cely.fr</a>.<br>Ligne suivante</p>';

describe("rendu email", () => {
  test("styles en ligne, listes sans marge parasite, lien conservé, paragraphe vide visible", () => {
    const h = inlineStyles(EDITOR);
    expect(h).toContain('<p style="margin:0 0 12px 0">Bonjour <strong>Claire</strong>,</p>');
    expect(h).toContain('<li style="margin:0 0 4px 0">Audit SEO</li>');
    expect(h).toContain('href="https://cely.fr/offre"');
    expect(h).not.toContain("nofollow");
    expect(h).toContain(">&nbsp;</p>");
  });

  test("document complet : signature une seule fois, échappée, largeur fluide", () => {
    const doc = renderEmailHtml(EDITOR, "Célien\nCely Growth <growth>");
    expect(doc.match(/-- <br>/g)).toHaveLength(1);
    expect(doc).toContain("Célien<br>Cely Growth &lt;growth&gt;");
    expect(doc).toContain("max-width:640px");
    expect(doc).toContain('name="viewport"');
  });

  test("version texte : paragraphes, puces, numéros, liens, sauts de ligne", () => {
    expect(htmlToText(EDITOR)).toBe(
      "Bonjour Claire,\n\n• Audit SEO\n• Campagnes\n\n1. Un\n2. Deux\n\nVoir notre offre (https://cely.fr/offre) ou c@cely.fr.\nLigne suivante",
    );
  });

  test("texte brut → HTML, et contenu vide", () => {
    expect(textToHtml("Bonjour <Paul>,\n\nLigne 1\nLigne 2")).toBe("<p>Bonjour &lt;Paul&gt;,</p><p>Ligne 1<br>Ligne 2</p>");
    expect(isEmptyHtml("<p></p><p> </p>")).toBe(true);
    expect(isEmptyHtml("<p>x</p>")).toBe(false);
  });
});
