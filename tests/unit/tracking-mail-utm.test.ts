// Tracking site · lot 2 : les liens vers celygrowth.com reçoivent leurs UTM dans les mails et les messages de campagne.
import { describe, expect, test } from "vitest";
import { MAIL_UTM, prospectionUtm, tagHtmlLinks, tagTextLinks } from "@/lib/tracking/mail-utm";
import { renderEmailHtml } from "@/lib/mail/render";
import { preparedMessage } from "@/lib/prospection/workspace";

const Q = "utm_source=email&utm_medium=email&utm_campaign=mail-direct";

describe("mail", () => {
  test("HTML : seuls les liens vers le site sont marqués, le reste du message est intact", () => {
    const html = renderEmailHtml('<p>Voir <a href="https://www.celygrowth.com/services">nos offres</a>, <a href="https://exemple.fr/a?b=1&amp;c=2">un autre site</a> et <a href="mailto:lea@example.test">écrire</a>.</p>', "Célien");
    const out = tagHtmlLinks(html, MAIL_UTM);
    expect(out).toContain(`href="https://www.celygrowth.com/services?${Q.replace(/&/g, "&amp;")}"`);
    expect(out).toContain('href="https://exemple.fr/a?b=1&amp;c=2"');
    expect(out).toContain('href="mailto:lea@example.test"');
    expect(out.replace(/\?utm_source[^"]*/, "")).toBe(html);
  });
  test("un lien qui a déjà des UTM reste tel quel ; les paramètres existants sont conservés", () => {
    const own = '<a href="https://celygrowth.com/?utm_source=linkedin&amp;utm_campaign=lancement">x</a>';
    expect(tagHtmlLinks(own, MAIL_UTM)).toBe(own);
    expect(tagHtmlLinks('<a href="https://celygrowth.com/contact?sujet=audit#formulaire">x</a>', MAIL_UTM))
      .toBe(`<a href="https://celygrowth.com/contact?sujet=audit&amp;${Q.replace(/&/g, "&amp;")}#formulaire">x</a>`);
  });
  test("texte brut : adresse avec ou sans https, ponctuation finale préservée, autres domaines ignorés", () => {
    expect(tagTextLinks("Détails : https://www.celygrowth.com/services.", MAIL_UTM)).toBe(`Détails : https://www.celygrowth.com/services?${Q}.`);
    expect(tagTextLinks("Voir (celygrowth.com/growth) et exemple.fr", MAIL_UTM)).toBe(`Voir (https://celygrowth.com/growth?${Q}) et exemple.fr`);
    // une simple mention du domaine (signature) n'est pas transformée en longue adresse
    expect(tagTextLinks("Célien\ncelygrowth.com", MAIL_UTM)).toBe("Célien\ncelygrowth.com");
    expect(tagTextLinks("www.celygrowth.com", MAIL_UTM)).toBe(`https://www.celygrowth.com/?${Q}`);
    expect(tagTextLinks("moi@celygrowth.com", MAIL_UTM)).toBe("moi@celygrowth.com");
    expect(tagTextLinks("https://moncelygrowth.com/x", MAIL_UTM)).toBe("https://moncelygrowth.com/x");
    expect(tagTextLinks("https://www.celygrowth.com/?utm_source=x", MAIL_UTM)).toBe("https://www.celygrowth.com/?utm_source=x");
  });
});

describe("campagne de prospection", () => {
  const step = { id: "s", position: 1, version: 1, name: "Premier message", step_type: "linkedin_message", channel: "linkedin", delay_days: 0, subject: null, message: "Bonjour {{prenom}}, un aperçu : https://www.celygrowth.com/growth", instructions: null } as never;
  test("le lien porte le nom de la campagne (normalisé) et le canal de l'étape", () => {
    expect(prospectionUtm("Dirigeants PME · Été 2026", "linkedin")).toEqual({ utm_source: "prospection", utm_medium: "linkedin", utm_campaign: "dirigeants-pme-ete-2026" });
    const msg = preparedMessage(step, null, { first_name: "Léa" } as never, "Dirigeants PME · Été 2026");
    expect(msg.body).toBe("Bonjour Léa, un aperçu : https://www.celygrowth.com/growth?utm_source=prospection&utm_medium=linkedin&utm_campaign=dirigeants-pme-ete-2026");
  });
  test("sans campagne connue, le message n'est pas modifié", () => {
    expect(preparedMessage(step, null, { first_name: "Léa" } as never).body).toBe("Bonjour Léa, un aperçu : https://www.celygrowth.com/growth");
  });
});
