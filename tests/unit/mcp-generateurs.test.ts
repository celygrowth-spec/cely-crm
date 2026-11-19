// Outils MCP de la proposition : mêmes garde-fous que l'interface. Aucun outil ne génère, ne valide, n'envoie, ne
// signe ni n'appelle Make ; l'IA ne lit pas les coordonnées de facturation et ne propose jamais de montant.
// (Les refus en base, côté Claude, sont testés dans tests/db : generateurs-socle, propositions, proposition-signature.)
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test } from "vitest";
import type { Answers, GeneratorVersion } from "@/lib/generators/rules";
import { AMOUNT_KEYS, forAi, stageOf, stripInternal } from "@/lib/mcp/generator-tools";
import { MCP_INSTRUCTIONS, registerTools } from "@/lib/mcp/tools";

type Handler = (args: Record<string, unknown>, ctx: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }>;
const tools = new Map<string, { config: { description: string; annotations: { readOnlyHint: boolean } }; run: Handler }>();
const calls: { fn: string; args: Record<string, unknown> }[] = [];
const row = (data: unknown) => ({ data, error: null });
const DOSSIER = "11111111-1111-4111-8111-111111111111";
// faux client : un dossier de proposition sans version, et l'enregistrement des appels de fonctions
const chain = (table: string): unknown => new Proxy({}, {
  get: (_, k: string) => {
    if (k === "then") return (res: (v: unknown) => void) => res(row(table === "generator_dossiers" ? { id: DOSSIER, kind: "proposal", company_id: "c", project_id: null, created_at: "", prefill_state: "requested", trigger_ref: null, triggered_at: null, trigger_error: null, session_url: null, last_error: null, library_item_ids: [] } : []));
    if (k === "maybeSingle" || k === "single") return async () => row(table === "generator_dossiers" ? { id: DOSSIER, kind: "proposal", company_id: "c", project_id: null, created_at: "", prefill_state: "requested", trigger_ref: null, triggered_at: null, trigger_error: null, session_url: null, last_error: null, library_item_ids: [] } : null);
    return () => chain(table);
  },
});
const sb = { from: (t: string) => chain(t), rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return row(fn === "generator_sources" ? [] : fn === "generator_save_answers" ? (args.p_answers as unknown[]).length : null); } } as unknown as SupabaseClient;
registerTools({ registerTool: (name: string, config: never, run: Handler) => void tools.set(name, { config, run }) } as never, () => sb);

const a = (o: Record<string, unknown>): Answers => Object.fromEntries(Object.entries(o).map(([k, value]) => [k, { value: value as never, provenance: null, origin: "owner" as const }]));
const version = (p: Partial<GeneratorVersion>): GeneratorVersion => ({ id: "v", version: 1, slides_status: "pending", slides_error: null, file_id: null, feedback: null, created_at: "", ready_at: null, validated_at: null, sent_at: null, answers: {}, ...p });

describe("outils de la proposition", () => {
  test("six outils, équivalents de ceux du diagnostic ; aucun ne génère, valide, envoie, signe ou appelle Make", () => {
    const names = [...tools.keys()].filter((n) => n.includes("proposal"));
    expect(names).toEqual(["open_proposal", "read_proposal_source", "save_proposal_answers", "start_proposal_version", "confirm_proposal_version", "report_proposal_failure"]);
    expect([...tools.keys()].filter((n) => /generate|validate|send|sign|quote|make_|devis/.test(n) && n !== "make_client")).toEqual([]);
    expect(tools.get("open_proposal")!.config.annotations.readOnlyHint).toBe(true);
    expect(tools.get("read_proposal_source")!.config.annotations.readOnlyHint).toBe(true);
    expect(MCP_INSTRUCTIONS).toMatch(/Propositions : un dossier se crée uniquement depuis l'application/);
  });

  test("l'IA ne reçoit pas les coordonnées de facturation, ni d'une version en cours ni d'une proposition précédente", () => {
    const answers = a({ objectifs: "Doubler les leads", adresse_facturation: "1 rue de Test", siret: "123", code_postal: "75001", ville: "Paris", pays: "FR", offre: "audit" });
    const shown = forAi(answers);
    expect(JSON.stringify(shown)).not.toMatch(/1 rue de Test|75001|"siret"/);
    expect(shown.find((q) => q.key === "objectifs")).toMatchObject({ reponse: "Doubler les leads", origine: "saisie par l'utilisateur : ne se remplace pas" });
    expect(shown.find((q) => q.key === "offre")?.reponse).toBe("Audit");
    expect(stripInternal({ version: 1, reponses: { objectifs: {}, adresse_facturation: {}, tva_intracom: {} } })).toEqual({ version: 1, reponses: { objectifs: {} } });
    expect(stripInternal([{ texte: "x" }])).toEqual([{ texte: "x" }]);
  });

  test("étape : pré-remplissage sans version, slides tant que la version n'est pas reçue, rien ensuite", () => {
    expect(stageOf({ versions: [] })).toBe("preremplissage");
    expect(stageOf({ versions: [version({ slides_status: "pending" })] })).toBe("slides");
    expect(stageOf({ versions: [version({ slides_status: "failed" })] })).toBe("slides");
    expect(stageOf({ versions: [version({ slides_status: "ready" })] })).toBe("rien");
    expect(stageOf({ versions: [version({ version: 1, slides_status: "ready", validated_at: "x" }), version({ version: 2, slides_status: "uploading" })] })).toBe("slides");
  });

  test("les montants ne se proposent pas : refusés avant toute écriture, le reste est enregistré comme venant de Claude", async () => {
    expect([...AMOUNT_KEYS]).toEqual(["lignes_devis"]);
    calls.length = 0;
    const r = await tools.get("save_proposal_answers")!.run({ proposal_id: DOSSIER, answers: [
      { key: "lignes_devis", value: "3 mois à 2 500 €", provenance: "repris de l'appel du 12/11" },
      { key: "objectifs", value: "Doubler les demandes", provenance: "repris de l'appel du 12/11" },
      { key: "question_inconnue", value: "x", provenance: "inventée" },
    ] }, {});
    const out = JSON.parse(r.content[0].text);
    expect(out.refusees).toEqual(["lignes_devis : les montants se saisissent dans l'application", "question_inconnue : question inconnue"]);
    const saved = calls.filter((c) => c.fn === "generator_save_answers");
    expect(saved).toHaveLength(1);
    expect(saved[0].args).toMatchObject({ p_origin: "claude", p_answers: [{ key: "objectifs", value: "Doubler les demandes", provenance: "repris de l'appel du 12/11" }] });
    // aucune autre écriture : ni génération, ni validation, ni devis
    expect(calls.map((c) => c.fn).filter((f) => /generate|validate|mark_sent|quote|sign/.test(f))).toEqual([]);
  });

  test("open_proposal : consignes de pré-remplissage, sans montant à proposer, sans rien générer", async () => {
    calls.length = 0;
    const r = await tools.get("open_proposal")!.run({ proposal_id: DOSSIER }, {});
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("{")));
    expect(out.etape).toBe("preremplissage");
    expect(out.consignes).toMatch(/Ne proposez JAMAIS de prix/);
    expect(out.questionnaire.some((q: { key: string }) => q.key === "adresse_facturation")).toBe(false);
    expect(calls.map((c) => c.fn)).toEqual(["generator_sources"]);
  });
});
