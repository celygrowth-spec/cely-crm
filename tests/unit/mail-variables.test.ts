// Variables d'email : résolution avec le contact de référence, valeurs absentes signalées (jamais
// remplacées en silence), formule collective, remplacement / retrait, et nettoyage pour un modèle.
import { describe, expect, test } from "vitest";
import { htmlToText } from "@/lib/mail/render";
import { replaceVariable, resolveVariables, scrubProspect, tokensToSpans, usedVariables, varSpan } from "@/lib/mail/variables";

const claire = { first_name: "Claire", last_name: "Démo", title: "CEO", company: "Studio Démo", website: "studio-demo.fr" };
const body = `<p>Bonjour ${varSpan("prenom")},</p><p>Chez ${varSpan("entreprise")} (${varSpan("site")}) …</p>`;

describe("variables", () => {
  test("résolues avec le bon interlocuteur, objet compris", () => {
    const r = resolveVariables(body, "Proposition pour {{entreprise}}", claire, false);
    expect(r.missing).toEqual([]);
    expect(htmlToText(r.html)).toBe("Bonjour Claire,\n\nChez Studio Démo (studio-demo.fr) …");
    expect(r.subject).toBe("Proposition pour Studio Démo");
  });

  test("valeur absente : signalée, la pastille reste ; formule collective : prénom non résolu", () => {
    const r = resolveVariables(body, "", { ...claire, first_name: null }, false);
    expect(r.missing).toEqual(["prenom"]);
    expect(r.html).toContain('data-variable="prenom"');
    expect(resolveVariables(body, "Bonjour {{prenom}}", claire, true).missing).toEqual(["prenom"]);
  });

  test("remplacer ou retirer une variable ; jetons {{x}} convertis en pastilles", () => {
    expect(replaceVariable(body, "Bonjour {{prenom}}", "prenom", "à tous")).toMatchObject({ subject: "Bonjour à tous" });
    expect(htmlToText(replaceVariable(body, "", "prenom", "à tous").html)).toContain("Bonjour à tous,");
    expect(tokensToSpans("<p>Bonjour {{ Prenom }} et {{inconnue}}</p>")).toBe(`<p>Bonjour ${varSpan("prenom")} et {{inconnue}}</p>`);
    expect(usedVariables(body, "Pour {{poste}}")).toEqual(["prenom", "entreprise", "site", "poste"]);
  });

  test("enregistrer comme modèle : les informations du prospect deviennent des variables, jamais dans les balises", () => {
    const html = '<p>Bonjour Claire,</p><p>Studio Démo mérite mieux : <a href="https://studio-demo.fr">studio-demo.fr</a>. Claire, la CEO, est d\'accord.</p>';
    const s = scrubProspect(html, "Proposition Studio Démo", claire);
    expect(Object.fromEntries(s.found.map((f) => [f.key, f.count]))).toEqual({ entreprise: 2, site: 1, prenom: 2, poste: 1 });
    expect(s.html).toContain('href="https://studio-demo.fr"'); // l'attribut n'est pas touché
    expect(s.html).toContain(`Bonjour ${varSpan("prenom")},`);
    expect(s.subject).toBe("Proposition {{entreprise}}");
    const partial = scrubProspect(html, "", claire, ["prenom"]);
    expect(partial.html).toContain("Studio Démo mérite");
  });
});
