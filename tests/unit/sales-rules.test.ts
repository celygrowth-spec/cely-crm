import { describe, expect, test } from "vitest";
import { amountLine, board, inPeriod, metrics, missingItems, needsCompletion, onboardingPrompt, periodStart, type SaleRow } from "@/lib/sales/rules";

const row = (x: Partial<SaleRow>): SaleRow => ({
  company_id: Math.random().toString(36), name: "Client", deal_status: "won", deal_closed_at: null, closed_on: "2026-11-05", lost_reason: null,
  deal_amount: null, archived_at: null, pipeline_name: null, stage_name: null, primary_person_name: null, sale_id: "s", sale_state: "won",
  signed_on: null, revenue_mode: null, documents_ready: false, prep_state: null, prep: null, prep_error: null, mission_id: null, mission_kind: null,
  mission_amount: null, mission_start: null, mission_end: null, mission_status: null, invoiced_ttc: null, received: null, remaining: null,
  project_id: null, project_name: null, project_status: null, candidate_mission_id: null, candidate_project_id: null, billing: "a_renseigner", stage: null, ...x,
});
const TODAY = "2026-11-10";
const sp = (s: string | null) => s?.replace(/[\u00a0\u202f]/g, " ") ?? null;

describe("période", () => {
  test("débuts de période", () => {
    expect(periodStart("mois", TODAY)).toBe("2026-11-01");
    expect(periodStart("annee", TODAY)).toBe("2026-01-01");
    expect(periodStart("trimestre", TODAY)).toBe("2026-09-01");
    expect(periodStart("12mois", TODAY)).toBe("2025-11-11");
    expect(periodStart("tout", TODAY)).toBeNull();
  });
  test("une clôture sans date n'entre que dans « Depuis le début »", () => {
    expect(inPeriod(row({ closed_on: null }), "annee", TODAY)).toBe(false);
    expect(inPeriod(row({ closed_on: null }), "tout", TODAY)).toBe(true);
  });
});

describe("chiffres", () => {
  test("taux = gagnées ÷ (gagnées + perdues) sur la période ; « — » sans clôture", () => {
    const rows = [row({}), row({}), row({ deal_status: "lost" }), row({ deal_status: "lost", closed_on: "2025-01-10" })];
    expect(metrics(rows, "annee", TODAY)).toEqual({ won: 2, lost: 1, rate: 67 });
    expect(metrics(rows, "tout", TODAY)).toEqual({ won: 2, lost: 2, rate: 50 });
    expect(metrics([], "mois", TODAY)).toEqual({ won: 0, lost: 0, rate: null });
  });
});

describe("tableau après-vente", () => {
  test("trois colonnes, indépendantes de la période ; terminées et anciens dossiers à compléter exclus", () => {
    const old = row({ stage: "en_mission", closed_on: "2023-02-01" });
    const rows = [row({ stage: "devis_contrat" }), row({ stage: "onboarding" }), old, row({ stage: "termine" }), row({ sale_id: null, stage: null }), row({ deal_status: "lost", stage: null })];
    const cols = board(rows);
    expect(cols.map((c) => [c.key, c.rows.length])).toEqual([["devis_contrat", 1], ["onboarding", 1], ["en_mission", 1]]);
    expect(cols[2].rows[0]).toBe(old); // ancienne vente encore en mission : visible
    expect(rows.filter(needsCompletion)).toHaveLength(1);
  });
  test("montant sur une ligne", () => {
    expect(sp(amountLine(row({ mission_kind: "recurrent", mission_amount: "1000.00" })))).toBe("1 000 € / mois");
    expect(sp(amountLine(row({ mission_kind: "ponctuel", mission_amount: 2500 })))).toBe("2 500 € ponctuels");
    expect(sp(amountLine(row({ mission_kind: "ponctuel", mission_amount: "1234.50" })))).toBe("1 234,50 € ponctuels");
    expect(sp(amountLine(row({ deal_amount: "800.00" })))).toBe("800 €");
    expect(amountLine(row({}))).toBeNull();
  });
  test("éléments obligatoires manquants", () => {
    const r = row({ prep: { items: [
      { key: "proposition", label: "", done: false, required: true }, { key: "contexte", label: "", done: false, required: false },
      { key: "dates", label: "", done: true, required: true }] } });
    expect(missingItems(r).map((i) => i.key)).toEqual(["proposition"]);
  });
  test("le lien vers Claude ne porte que l'identifiant du projet et interdit toute publication", () => {
    const p = onboardingPrompt("11111111-1111-4111-8111-111111111111");
    expect(p).toContain("get_project");
    expect(p).toMatch(/Ne publie rien/);
  });
});
