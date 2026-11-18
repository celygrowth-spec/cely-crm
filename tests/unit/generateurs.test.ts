// Générateurs : contenu des questions (fichiers modifiables sans toucher à la logique) et règles communes.
import { describe, expect, test } from "vitest";
import { QUESTIONS } from "@/content/generators";
import { answerProblem, answerText, dossierState, generatorPrompt, generatorRoutineText, linesTotal, missingRequired, provenanceLabel, versionState, type Answers, type GeneratorVersion, type Question } from "@/lib/generators/rules";

const version = (p: Partial<GeneratorVersion>): GeneratorVersion => ({ id: "v", version: 1, slides_status: "pending", slides_error: null, file_id: null, feedback: null, created_at: "", ready_at: null, validated_at: null, sent_at: null, answers: {}, ...p });
const q = (kind: "proposal" | "onboarding", key: string) => QUESTIONS[kind].find((x) => x.key === key)!;

describe("fichiers de questions", () => {
  test.each(["proposal", "onboarding"] as const)("%s : clés uniques et bien formées, choix complets", (kind) => {
    const list = QUESTIONS[kind];
    expect(new Set(list.map((x) => x.key)).size).toBe(list.length);
    for (const x of list) {
      expect(x.key).toMatch(/^[a-z0-9_]{2,60}$/);
      expect(x.label.trim().length).toBeGreaterThan(3);
      expect(x.section.trim()).not.toBe("");
      if (x.type === "choice") expect(x.options?.length).toBeGreaterThan(1);
    }
  });

  test("la proposition couvre tout ce qui doit être demandé", () => {
    const keys = QUESTIONS.proposal.map((x) => x.key);
    for (const k of ["offre", "objectifs", "indicateurs", "canaux", "perimetre", "exclusions", "volume_horaire", "lignes_devis", "options", "date_demarrage", "duree_mois", "signataire", "adresse_facturation", "conditions_particulieres", "ton", "points_sensibles"])
      expect(keys).toContain(k);
    expect(q("proposal", "offre").options?.map((o) => o.value)).toEqual(expect.arrayContaining(["growth_part_time", "decouverte", "audit"]));
    // les montants et le signataire partent à Make ; les coordonnées de facturation ne partent pas à l'IA
    expect(QUESTIONS.proposal.filter((x) => x.make).map((x) => x.key)).toEqual(expect.arrayContaining(["lignes_devis", "signataire", "date_demarrage", "adresse_facturation"]));
    expect(q("proposal", "adresse_facturation").internal).toBe(true);
    expect(q("proposal", "lignes_devis").internal).toBeUndefined();
  });

  test("l'onboarding couvre interlocuteurs, accès, outils, lancement, rituels, premières actions, vigilance", () => {
    expect(QUESTIONS.onboarding.map((x) => x.key)).toEqual(["interlocuteurs", "acces", "outils", "date_lancement", "rituels", "premieres_actions", "vigilance"]);
  });
});

describe("états visibles", () => {
  test("à préparer, en génération, à relire, validée, envoyée, échec", () => {
    expect(dossierState({ versions: [], prefill_state: "requested", last_error: null })).toBe("a_preparer");
    expect(dossierState({ versions: [], prefill_state: "failed", last_error: "Claude injoignable" })).toBe("echec");
    expect(versionState(version({ slides_status: "pending" }))).toBe("en_generation");
    expect(versionState(version({ slides_status: "uploading" }))).toBe("en_generation");
    expect(versionState(version({ slides_status: "failed" }))).toBe("echec");
    expect(versionState(version({ slides_status: "ready" }))).toBe("a_relire");
    expect(versionState(version({ slides_status: "ready", validated_at: "2026-11-20" }))).toBe("validee");
    expect(versionState(version({ slides_status: "ready", validated_at: "2026-11-20", sent_at: "2026-11-21" }))).toBe("envoyee");
    // l'état du dossier est celui de sa dernière version, les précédentes restent consultables
    expect(dossierState({ prefill_state: "done", last_error: null, versions: [version({ version: 1, slides_status: "ready", validated_at: "x", sent_at: "y" }), version({ version: 2 })] })).toBe("en_generation");
  });
});

describe("réponses", () => {
  const answers = (o: Record<string, unknown>): Answers => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value: value as never, provenance: null, origin: "owner" as const }]));

  test("questions obligatoires manquantes : une réponse vide ou une liste vide ne compte pas", () => {
    const list: Question[] = [{ key: "a", section: "S", label: "A ?", type: "text", required: true }, { key: "b", section: "S", label: "B ?", type: "lines", required: true }, { key: "c", section: "S", label: "C ?", type: "long" }];
    expect(missingRequired(list, answers({ a: "  ", b: [] })).map((x) => x.key)).toEqual(["a", "b"]);
    expect(missingRequired(list, answers({ a: "oui", b: [{ label: "x" }] }))).toEqual([]);
  });

  test("forme des réponses : choix connu, date réelle, lignes de devis complètes", () => {
    expect(answerProblem(q("proposal", "offre"), "audit")).toBeNull();
    expect(answerProblem(q("proposal", "offre"), "gratuit")).toMatch(/inconnu/);
    expect(answerProblem(q("proposal", "date_demarrage"), "2026-12-01")).toBeNull();
    expect(answerProblem(q("proposal", "date_demarrage"), "01/12/2026")).toMatch(/Date/);
    expect(answerProblem(q("proposal", "duree_mois"), -1)).toMatch(/Nombre/);
    expect(answerProblem(q("proposal", "signataire"), { first_name: "", last_name: "" })).toMatch(/prénom/);
    const line = { label: "Growth Part-Time", quantity: 3, unit: "mois", unit_price: 2500, vat_rate: 20, recurrence: "monthly" };
    expect(answerProblem(q("proposal", "lignes_devis"), [line])).toBeNull();
    expect(answerProblem(q("proposal", "lignes_devis"), [{ ...line, unit_price: -5 }])).toMatch(/Prix/);
    expect(answerProblem(q("proposal", "lignes_devis"), [{ ...line, quantity: 0 }])).toMatch(/Quantité/);
    expect(answerProblem(q("proposal", "lignes_devis"), [{ ...line, recurrence: "annuel" }])).toMatch(/mensuel ou ponctuel/);
    expect(answerProblem(q("proposal", "lignes_devis"), "")).toBeNull();
    expect(linesTotal([line as never, { ...line, quantity: 1, unit_price: 499.99 } as never])).toBe(7999.99);
  });

  test("provenance affichée, sauf pour ce que j'ai saisi moi-même", () => {
    expect(provenanceLabel({ value: "x", provenance: "repris de l'appel du 12/11", origin: "claude" })).toBe("repris de l'appel du 12/11");
    expect(provenanceLabel({ value: "x", provenance: null, origin: "crm" })).toBe("Repris du CRM");
    expect(provenanceLabel({ value: "x", provenance: "ancienne", origin: "owner" })).toBeNull();
    expect(answerText(q("proposal", "offre"), "decouverte")).toBe("Offre découverte");
    expect(answerText(q("proposal", "date_demarrage"), "2026-12-01")).toBe("01/12/2026");
  });

  test("les messages pour Claude ne portent que l'identifiant du dossier", () => {
    expect(generatorRoutineText("proposal", "slides", "ID")).toBe("proposition:slides:ID");
    expect(generatorPrompt("proposal", "preremplissage", "ID")).toContain("open_proposal");
    expect(generatorPrompt("proposal", "slides", "ID")).not.toMatch(/@|€|\d{5}/);
  });
});
