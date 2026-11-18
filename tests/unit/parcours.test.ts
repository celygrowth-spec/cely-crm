// Parcours client : une seule prochaine action principale par état, et les actions datées d'Aujourd'hui.
import { describe, expect, test } from "vitest";
import { actionHref, journeyTodos, nextAction, type JourneyRow } from "@/lib/journey/rules";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const row = (p: Partial<JourneyRow>): JourneyRow => ({
  company_id: "c1", name: "[TEST] Acme", deal_status: "open", last_call_at: null,
  diagnostic_id: null, diagnostic_status: null, diagnostic_at: null, diagnostic_ready_at: null, diagnostic_validated_at: null,
  proposal_id: null, proposal_at: null, proposal_version: null, proposal_slides: null, proposal_ready_at: null, proposal_validated_at: null, proposal_sent_at: null, proposal_signed_at: null,
  project_id: null, onboarding_id: null, onboarding_at: null, onboarding_version: null, onboarding_slides: null, onboarding_ready_at: null, onboarding_validated_at: null, ...p,
});
const act = (p: Partial<JourneyRow>) => { const a = nextAction(row(p), NOW); return a ? [a.step, a.label, a.todo?.title ?? null] : null; };
const D = "2026-11-12T09:00:00Z";

describe("prochaine action principale", () => {
  test("les états se suivent : appel fait, diagnostic, diagnostic validé, proposition, envoyée, signée, onboarding", () => {
    expect(act({})).toBeNull();
    expect(act({ last_call_at: D })).toEqual(["appel_fait", "Générer un diagnostic", "Diagnostic à générer pour Acme"]);
    expect(act({ last_call_at: D, diagnostic_id: "d", diagnostic_status: "researching" })).toEqual(["diagnostic", "Voir le diagnostic", null]);
    expect(act({ diagnostic_id: "d", diagnostic_status: "questions_ready", diagnostic_at: D })).toEqual(["diagnostic", "Voir le diagnostic", "Questions du diagnostic à compléter pour Acme"]);
    expect(act({ diagnostic_id: "d", diagnostic_status: "version_ready", diagnostic_ready_at: D })).toEqual(["diagnostic", "Voir le diagnostic", "Diagnostic à valider pour Acme"]);
    expect(act({ diagnostic_id: "d", diagnostic_ready_at: D, diagnostic_validated_at: D })).toEqual(["diagnostic_valide", "Générer la proposition", "Proposition à préparer pour Acme"]);
    const p = { diagnostic_id: "d", diagnostic_validated_at: D, proposal_id: "p", proposal_at: D };
    expect(act(p)).toEqual(["proposition", "Voir la proposition", "Proposition à préparer pour Acme"]);
    expect(act({ ...p, proposal_version: 1, proposal_slides: "pending" })).toEqual(["proposition", "Voir la proposition", null]);
    expect(act({ ...p, proposal_version: 1, proposal_slides: "failed" })).toEqual(["proposition", "Voir la proposition", "Proposition à relancer pour Acme"]);
    expect(act({ ...p, proposal_version: 1, proposal_slides: "ready", proposal_ready_at: D })).toEqual(["proposition", "Voir la proposition", "Proposition à relire pour Acme"]);
    expect(act({ ...p, proposal_version: 1, proposal_slides: "ready", proposal_validated_at: D })).toEqual(["proposition", "Envoyer la proposition", "Proposition à envoyer à Acme"]);
    const sent = { ...p, proposal_version: 1, proposal_slides: "ready" as const, proposal_validated_at: D, proposal_sent_at: D };
    expect(act(sent)).toEqual(["proposition_envoyee", "Voir la proposition", null]);
    expect(act({ ...sent, proposal_signed_at: D })).toEqual(["signee", "Passer en client", "Passage en client à confirmer pour Acme"]);
    const client = { ...sent, proposal_signed_at: D, deal_status: "won" as const, project_id: "pr" };
    expect(act(client)).toEqual(["signee", "Générer l'onboarding", "Onboarding à préparer pour Acme"]);
    expect(act({ ...client, onboarding_id: "o", onboarding_at: D })).toEqual(["onboarding", "Voir l'onboarding", "Onboarding à préparer pour Acme"]);
    expect(act({ ...client, onboarding_id: "o", onboarding_version: 1, onboarding_slides: "ready", onboarding_ready_at: D })).toEqual(["onboarding", "Voir l'onboarding", "Onboarding à relire pour Acme"]);
    expect(act({ ...client, onboarding_id: "o", onboarding_version: 1, onboarding_slides: "ready", onboarding_validated_at: D })).toEqual(["onboarding", "Voir l'onboarding", null]);
  });

  test("données anciennes : proposition sans diagnostic ; client gagné sans proposition signée ; opportunité perdue", () => {
    expect(act({ proposal_id: "p", proposal_at: D })).toEqual(["proposition", "Voir la proposition", "Proposition à préparer pour Acme"]);
    expect(act({ deal_status: "won", last_call_at: D, project_id: "pr" })).toBeNull();
    expect(act({ deal_status: "lost", last_call_at: D, diagnostic_id: "d" })).toBeNull();
  });

  test("un vieil appel garde son bouton, sans revenir indéfiniment dans Aujourd'hui", () => {
    expect(act({ last_call_at: "2026-09-01T09:00:00Z" })).toEqual(["appel_fait", "Générer un diagnostic", null]);
  });

  test("liens : « Générer » ouvre l'onglet et lance, « Voir » ouvre seulement ; l'onboarding mène au projet", () => {
    const href = (p: Partial<JourneyRow>) => actionHref("c1", nextAction(row(p), NOW)!);
    expect(href({ last_call_at: D })).toBe("/fiches/c1?onglet=diagnostic&lancer=1");
    expect(href({ diagnostic_id: "d", diagnostic_validated_at: D })).toBe("/fiches/c1?onglet=proposition&lancer=1");
    expect(href({ proposal_id: "p" })).toBe("/fiches/c1?onglet=proposition");
    expect(href({ proposal_id: "p", proposal_signed_at: D, deal_status: "won", project_id: "pr" })).toBe("/projets/pr");
  });

  test("Aujourd'hui : une action datée par fiche, la plus ancienne d'abord, rien pour ce qui n'attend pas de moi", () => {
    const lines = journeyTodos([
      row({ company_id: "a", name: "Zeta", diagnostic_id: "d", diagnostic_validated_at: "2026-11-15T09:00:00Z" }),
      row({ company_id: "b", name: "Alpha", proposal_id: "p", proposal_version: 1, proposal_slides: "ready", proposal_validated_at: "2026-11-10T09:00:00Z" }),
      row({ company_id: "c", name: "Attente", proposal_id: "p", proposal_version: 1, proposal_slides: "pending" }),
    ], NOW);
    expect(lines.map((l) => [l.title, l.label, l.since.slice(0, 10)])).toEqual([
      ["Proposition à envoyer à Alpha", "Envoyer la proposition", "2026-11-10"],
      ["Proposition à préparer pour Zeta", "Générer la proposition", "2026-11-15"],
    ]);
  });
});
