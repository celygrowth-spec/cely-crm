// Onboarding offre découverte : lien du site (question 4), « Je ne sais pas », captures du tuto lemlist.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LEMLIST_INVITE_DEFAULT, LEMLIST_TUTO, LINKEDIN_TUTO, OFFER_QUESTIONS, WEBSITE_FIELD } from "@/lib/discovery/content";
import { unknownQuestions, type DiscoveryView } from "@/lib/discovery/types";
import { WEBSITE_KEY, normalizeWebsite } from "@/lib/discovery/website";

describe("lien du site", () => {
  test("sans « https:// » : complété ; déjà propre : inchangé ; vide : accepté (champ facultatif)", () => {
    expect(normalizeWebsite("exemple.fr")).toBe("https://exemple.fr");
    expect(normalizeWebsite("  www.Exemple.FR/  ")).toBe("https://www.exemple.fr");
    expect(normalizeWebsite("http://exemple.fr/offre?x=1#haut")).toBe("http://exemple.fr/offre?x=1#haut");
    expect(normalizeWebsite("https://sous.domaine.exemple.co.uk/a/b")).toBe("https://sous.domaine.exemple.co.uk/a/b");
    expect(normalizeWebsite("exemple.fr:8080/page")).toBe("https://exemple.fr:8080/page");
    expect(normalizeWebsite("")).toBe("");
    expect(normalizeWebsite("   ")).toBe("");
  });
  test("invalide : refusé", () => {
    for (const bad of ["exemple", "mon site.fr", "https://", "ftp://exemple.fr", "javascript:alert(1)", "mailto:moi@exemple.fr", "moi@exemple.fr",
      "https://user:secret@exemple.fr", "http://localhost:3000", "192.168.1.10", "https://exemple.f", `exemple.fr/${"a".repeat(300)}`]) {
      expect(normalizeWebsite(bad), bad).toBeNull();
    }
  });
  test("ce que le navigateur accepte passe aussi le contrôle de la base", () => {
    // même expression que portal_discovery_answer (migration 20261128090000)
    const db = /^https?:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?([/?#][^\s]*)?$/i;
    for (const ok of ["exemple.fr", "www.exemple.fr/", "http://exemple.fr/offre?x=1#haut", "exemple.fr:8080/page", "café-des-sports.fr"]) {
      expect(db.test(normalizeWebsite(ok)!), ok).toBe(true);
    }
  });
  test("le champ est rattaché à la question 4 et sa clé ne remplace aucune question", () => {
    expect(OFFER_QUESTIONS[3].key).toBe(WEBSITE_FIELD.question);
    expect(WEBSITE_FIELD.label).toBe("Lien de votre site (si vous en avez un)");
    expect(OFFER_QUESTIONS.some((q) => q.key === WEBSITE_KEY)).toBe(false);
  });
});

describe("« Je ne sais pas »", () => {
  test("seules les questions cochées ressortent « à compléter avec le client »", () => {
    const answers = {
      offer_pitch: { value: "On fait X", rev: 1, by: null, mine: null, at: "" }, // réponse d'avant la migration : pas de champ unknown
      results: { value: "", unknown: true, rev: 1, by: null, mine: null, at: "" },
      objections: { value: "", unknown: false, rev: 1, by: null, mine: null, at: "" },
    } satisfies DiscoveryView["answers"];
    expect(unknownQuestions({ answers }).map((q) => q.key)).toEqual(["results"]);
  });
});

describe("tutos", () => {
  test("lemlist : chaque étape a sa capture (fichier présent), sa légende et sa source", () => {
    expect(LEMLIST_TUTO).toHaveLength(4);
    for (const s of LEMLIST_TUTO) {
      expect(s.capture.length).toBeGreaterThan(20);
      expect(s.source).toMatch(/^https:\/\/help\.lemlist\.com\/en\/articles\/\d+/);
      expect(s.image, s.title).toMatch(/^\/onboarding\/lemlist-\d-[a-z]+\.png$/);
      expect(existsSync(join(__dirname, "..", "..", "public", s.image!)), s.image).toBe(true);
    }
  });
  test("lemlist : une adresse à inviter est toujours affichée (adresse par défaut tant que le réglage est vide)", () => {
    expect(LEMLIST_INVITE_DEFAULT).toBe("celygrowth@gmail.com");
  });
  test("LinkedIn : chaque étape garde la légende de la capture à faire", () => {
    for (const s of LINKEDIN_TUTO) expect(s.capture.length).toBeGreaterThan(20);
  });
});
