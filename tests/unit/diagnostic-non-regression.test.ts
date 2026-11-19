// Non-régression du diagnostic, posée AVANT le socle commun des générateurs : ses messages, ses états, ses outils
// MCP (noms, descriptions, paramètres) et ses consignes d'étape ne doivent pas changer quand la proposition et
// l'onboarding réutilisent ses briques. Un changement voulu du diagnostic met à jour l'instantané, en connaissance de cause.
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { DIAGNOSTIC_STATUS_LABELS, answersPrompt, claudeLink, revisionPrompt, stageOf, startPrompt } from "@/lib/crm/diagnostic-rules";
import { registerTools } from "@/lib/mcp/tools";

type Tool = { title: string; description: string; inputSchema: z.ZodObject; annotations: unknown };
const tools = new Map<string, Tool>();
registerTools({ registerTool: (name: string, config: Tool) => void tools.set(name, config) } as never, () => ({}) as SupabaseClient);

const DIAGNOSTIC_TOOLS = [
  "open_diagnostic", "list_diagnostic_history", "list_diagnostic_emails", "get_diagnostic_email_thread", "list_diagnostic_appointments",
  "list_diagnostic_calls", "get_diagnostic_transcript", "list_diagnostic_files", "get_diagnostic_file_url", "read_diagnostic_file",
  "read_diagnostic_site", "save_diagnostic_research", "save_diagnostic_questions", "start_diagnostic_version", "confirm_diagnostic_version",
  "report_diagnostic_failure",
];

describe("diagnostic : inchangé", () => {
  test("états et messages envoyés à Claude", () => {
    expect(DIAGNOSTIC_STATUS_LABELS).toEqual({
      waiting_claude: "En attente de Claude", researching: "Recherche en cours", questions_ready: "Questions à compléter",
      answers_sent: "Réponses envoyées, slides à générer", generating: "Génération en cours", version_ready: "Fichier reçu",
      revision_requested: "Nouvelle version demandée", failed: "Échec",
    });
    expect([startPrompt("ID"), answersPrompt("ID"), revisionPrompt("ID")]).toMatchSnapshot();
    expect(claudeLink("bonjour", "https://claude.ai/chat/abc?x=1")).toBe("https://claude.ai/chat/abc?q=bonjour");
    expect(claudeLink("bonjour", "https://claude.ai/code/session_1")).toBe("https://claude.ai/new?q=bonjour");
  });

  test("étape à relancer", () => {
    const v = (version: number, feedback: string | null) => ({ id: `v${version}`, version, file_id: "f", status: "ready" as const, created_at: "", ready_at: "", feedback, feedback_at: null });
    expect(stageOf({ answers_sent_at: null, versions: [] })).toBe("start");
    expect(stageOf({ answers_sent_at: "2026-11-01", versions: [] })).toBe("answers");
    expect(stageOf({ answers_sent_at: "2026-11-01", versions: [v(1, "plus court"), v(2, null)] })).toBe("answers");
    expect(stageOf({ answers_sent_at: "2026-11-01", versions: [v(1, null), v(2, "plus court")] })).toBe("revision");
  });

  test("les 16 outils MCP du diagnostic : mêmes noms, mêmes descriptions, mêmes paramètres", () => {
    expect([...tools.keys()].filter((n) => n.includes("diagnostic"))).toEqual(DIAGNOSTIC_TOOLS);
    expect(DIAGNOSTIC_TOOLS.map((n) => {
      const t = tools.get(n)!;
      return { name: n, title: t.title, description: t.description, annotations: t.annotations, input: z.toJSONSchema(t.inputSchema) };
    })).toMatchSnapshot();
  });
});
