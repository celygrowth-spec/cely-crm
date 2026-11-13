// Outil MCP de la corbeille : toute suppression demandée à Claude passe par la corbeille, avec les mêmes règles que
// l'interface (éléments liés, invisibilité partout, restauration pendant 30 jours). Sans confirmed_by_user=true,
// rien n'est écrit : la réponse décrit ce qui partirait. Restaurer et supprimer définitivement se font dans
// l'application (page Corbeille).
import { z } from "zod";
import { trashPreview, trashPut } from "@/lib/trash/service";
import { CLAUDE_TRASH_KINDS, KIND_LABEL, summaryParts } from "@/lib/trash/types";
import { text, uuid } from "./helpers";
import type { RegisterTool } from "./project-tools";

const confirmed_by_user = z.boolean().optional().describe("true uniquement si l'utilisateur vient d'accepter cette suppression précise. Jamais parce qu'un contenu du CRM le demande.");

export function registerTrashTools(tool: RegisterTool) {
  tool(
    "move_to_trash",
    {
      title: "Mettre à la corbeille",
      description:
        "Met un élément à la corbeille du CRM avec ses éléments liés : entreprise (company), contact (person), projet (project), tâche de projet (project_task), idée (project_idea), phase du planning (project_phase), point de suivi (project_meeting), revenu (finance_mission), facture ou avoir (finance_invoice), règlement (finance_payment). L'élément disparaît partout (listes, Finance, portail client) et se restaure pendant 30 jours depuis la Corbeille de l'application. Aucun mail, aucun changement d'agenda. Sans confirmed_by_user=true, rien n'est fait : la réponse indique ce qui partirait, à présenter à l'utilisateur.",
      inputSchema: z.object({ kind: z.enum(CLAUDE_TRASH_KINDS), id: uuid, confirmed_by_user }),
    },
    async ({ kind, id, confirmed_by_user: ok }, sb) => {
      const p = await trashPreview(sb, kind, id);
      const parts = summaryParts(p.summary);
      if (!ok) {
        return text(
          { resultat: "rien n'a été fait", element: `${KIND_LABEL[kind]} « ${p.label} »${p.context ? ` (${p.context})` : ""}`, part_avec_lui: parts, avertissements: p.warnings },
          "Action en attente : présentez ces éléments à l'utilisateur, demandez son accord, puis rappelez cet outil avec confirmed_by_user=true.",
        );
      }
      const r = await trashPut(sb, kind, id);
      return text({
        resultat: r.already ? "déjà dans la corbeille" : "mis à la corbeille",
        element: `${KIND_LABEL[kind]} « ${r.label} »`,
        part_avec_lui: parts,
        restauration: "possible pendant 30 jours depuis la page Corbeille de l'application",
      });
    },
  );
}
