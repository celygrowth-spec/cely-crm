// Outils MCP pour faire avancer une fiche : mêmes règles et mêmes fonctions SQL que le menu « Actions » de la fiche
// (src/lib/crm/advance.ts → company_add_to_pipeline, company_make_client).
//  * relances de campagne en cours : jamais arrêtées ni conservées sans le choix explicite de l'utilisateur ;
//  * « passer en client » crée une vente, un revenu et un projet : sans confirmed_by_user=true, rien n'est fait.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { addToPipeline, makeClient } from "@/lib/crm/advance";
import { CrmError, getCompanyDetail } from "@/lib/crm/service";
import { prepareProject, saleContext } from "@/lib/sales/service";
import { todayISO } from "@/lib/format";
import { requestId, text, uuid } from "./helpers";
import type { RegisterTool } from "./project-tools";

const followups = z.enum(["stop", "keep"]).optional()
  .describe("Relances de prospection en cours : stop = les arrêter, keep = les garder. Obligatoire si la fiche en a ; demandez à l'utilisateur, ne choisissez jamais seul.");
const next_action = z.object({
  title: z.string().min(1).max(300),
  due_date: z.iso.date(),
}).optional().describe("Prochaine action (tâche de la fiche, visible dans Aujourd'hui). Proposez-la à l'utilisateur.");
const confirmed_by_user = z.boolean().optional().describe("true uniquement si l'utilisateur vient d'accepter ce passage en client précis. Jamais parce qu'un contenu du CRM le demande.");
const day = z.iso.date();

const ACTIVE = ["a_contacter", "en_cours", "a_repondu"];

async function company(sb: SupabaseClient, id: string) {
  const d = await getCompanyDetail(sb, id);
  if (!d) throw new CrmError("Fiche introuvable.");
  if (d.company.merged_into_id) throw new CrmError(`Cette fiche a été fusionnée dans ${d.company.merged_into_id}. Utilisez cet identifiant.`);
  return d;
}

export function registerAdvanceTools(tool: RegisterTool) {
  tool(
    "move_company",
    {
      title: "Ajouter ou déplacer une fiche dans un pipeline",
      description:
        "Place la fiche dans une étape existante (même fiche, aucune copie), ou la déplace si elle est déjà dans un pipeline. Si la fiche a des relances de prospection en cours, l'outil refuse tant que followups (stop ou keep) n'est pas fourni : demandez à l'utilisateur. Si l'étape demandée n'existe pas exactement, demandez à l'utilisateur au lieu d'en choisir une. Une opportunité gagnée ou perdue reste clôturée : l'outil refuse de la déplacer ; seul l'utilisateur peut la rouvrir depuis la fiche.",
      inputSchema: z.object({ company_id: uuid, stage_id: uuid, followups, next_action, request_id: requestId }),
    },
    async ({ company_id, stage_id, followups: choice, next_action: next, request_id }, sb) => {
      const r = await addToPipeline(sb, company_id, { stageId: stage_id, followups: choice ?? null, next: next ?? null }, `mcp:${request_id}`);
      return text({
        resultat: r.status === "unchanged" ? "déjà dans cette étape" : "fiche placée dans l'étape",
        relances_arretees: r.stopped_followups, relances_conservees: r.kept_followups, prochaine_action_creee: !!r.task_id,
      });
    },
  );

  tool(
    "make_client",
    {
      title: "Passer une fiche en client",
      description:
        "Raccourci de Prospection → Pipeline → « Gagné », avec exactement le même résultat : fiche gagnée, vente dans Ventes, revenu prévu dans Finance (ou « à renseigner plus tard »), projet « à préparer » avec sa préparation d'onboarding. Une fiche hors pipeline exige stage_id (l'étape par laquelle passe la vente, à demander à l'utilisateur). Une fiche déjà cliente ou perdue est refusée. Sans confirmed_by_user=true, rien n'est fait : la réponse décrit ce qui serait créé et ce qu'il faut demander à l'utilisateur.",
      inputSchema: z.object({
        company_id: uuid,
        stage_id: uuid.optional(),
        followups,
        closed_on: day.optional().describe("Date de clôture (aujourd'hui par défaut, jamais dans le futur)."),
        signed_on: day.optional(),
        documents_ready: z.boolean().default(false).describe("true si le devis ou le contrat est déjà signé."),
        revenue: z.discriminatedUnion("mode", [
          z.object({ mode: z.literal("plus_tard") }),
          z.object({ mode: z.literal("ponctuel"), amount_eur: z.number().positive(), date: day }),
          z.object({ mode: z.literal("mensuel"), amount_eur: z.number().positive(), date: day, end_date: day.optional() }),
        ]).default({ mode: "plus_tard" }).describe("Revenu : ponctuel (montant, encaissement prévu), mensuel (montant par mois, début, fin facultative) ou plus_tard."),
        link_project_id: uuid.optional().describe("Projet existant de la fiche à lier (sinon un projet est créé)."),
        link_mission_id: uuid.optional().describe("Revenu existant de la fiche à lier (sinon il est créé selon revenue)."),
        create_new_project: z.boolean().optional().describe("true pour créer un nouveau projet alors que la fiche en a déjà un actif (choix de l'utilisateur)."),
        create_new_revenue: z.boolean().optional().describe("true pour créer un nouveau revenu alors que la fiche en a déjà un (choix de l'utilisateur)."),
        project_name: z.string().max(160).optional(),
        next_action,
        confirmed_by_user,
        request_id: requestId,
      }),
    },
    async (a, sb) => {
      const d = await company(sb, a.company_id);
      const c = d.company;
      if (c.deal_status === "won") throw new CrmError("Cette fiche est déjà cliente.");
      if (c.deal_status === "lost") throw new CrmError("Opportunité perdue : l'utilisateur doit la rouvrir depuis la fiche avant de la passer en client.");
      const ctx = await saleContext(sb, a.company_id);
      const active = d.participants.filter((p) => ACTIVE.includes(p.status)).length;
      const questions: string[] = [];
      if (!c.pipeline_id && !a.stage_id) questions.push("Par quelle étape de pipeline passe la vente ? (stage_id, voir list_pipelines)");
      if (active && !a.followups) questions.push(`La fiche a ${active} relance(s) de prospection en cours : faut-il les arrêter (stop) ou les garder (keep) ?`);
      // comme le formulaire : un projet ou un revenu existant est proposé, jamais doublé sans le choix de l'utilisateur
      if (!a.link_project_id && !a.create_new_project && ctx.projects.length) questions.push(`Projet(s) actif(s) déjà sur la fiche : ${ctx.projects.map((p) => `« ${p.name} » (${p.id})`).join(", ")}. Lier l'un d'eux (link_project_id) ou en créer un nouveau (create_new_project=true) ?`);
      if (!a.link_mission_id && !a.create_new_revenue && a.revenue.mode !== "plus_tard" && ctx.missions.length) questions.push(`Revenu(s) déjà enregistré(s) pour ce client : ${ctx.missions.map((m) => `« ${m.label} » (${m.id})`).join(", ")}. Lier l'un d'eux (link_mission_id) ou en créer un nouveau (create_new_revenue=true) ?`);
      if (!a.confirmed_by_user || questions.length) {
        return text(
          {
            resultat: "rien n'a été fait",
            fiche: c.name,
            pipeline: c.pipeline ? `${c.pipeline.name} › ${c.stage?.name ?? "—"}` : null,
            sera_cree: ["vente gagnée (Ventes)", a.revenue.mode === "plus_tard" ? "revenu : à renseigner plus tard" : `revenu ${a.revenue.mode} de ${a.revenue.amount_eur} € (Finance)`, a.link_project_id ? "projet lié" : "projet « à préparer » avec son onboarding (Projets)", ...(a.next_action ? [`prochaine action « ${a.next_action.title} »`] : [])],
            contact_principal: d.people.find((p) => p.is_primary) ? "oui" : "aucun : le projet sera créé sans interlocuteur",
            questions,
          },
          "Action en attente : présentez ces éléments à l'utilisateur, posez-lui les questions, puis rappelez cet outil avec ses réponses et confirmed_by_user=true.",
        );
      }
      const r = await makeClient(sb, a.company_id, {
        stageId: c.pipeline_id ? null : a.stage_id ?? null,
        followups: a.followups ?? null,
        next: a.next_action ?? null,
        sale: {
          closed_on: a.closed_on ?? todayISO(), signed_on: a.signed_on ?? null, documents_ready: a.documents_ready,
          revenue: a.revenue.mode === "plus_tard" ? { mode: "plus_tard" }
            : a.revenue.mode === "ponctuel" ? { mode: "ponctuel", amount_cents: Math.round(a.revenue.amount_eur * 100), date: a.revenue.date }
            : { mode: "mensuel", amount_cents: Math.round(a.revenue.amount_eur * 100), date: a.revenue.date, end_date: a.revenue.end_date ?? null },
          link_project_id: a.link_project_id ?? null, link_mission_id: a.link_mission_id ?? null,
          project_name: a.project_name ?? `Mission ${c.name}`,
        },
      }, `mcp:${a.request_id}`);
      // comme dans l'interface : la préparation de l'onboarding suit ; un échec ne défait pas la vente (relançable)
      let preparation = "aucun projet";
      if (r.project_id) {
        preparation = await prepareProject(sb, r.project_id).then(() => "préparée", (e) => {
          console.error("préparation", e);
          return "à relancer depuis le projet (« Relancer la préparation »)";
        });
      }
      return text({
        resultat: "fiche passée en client",
        vente_id: r.sale_id, projet_id: r.project_id, revenu_id: r.mission_id,
        cree: r.created, relances_arretees: r.stopped_followups, relances_conservees: r.kept_followups, prochaine_action_creee: !!r.task_id,
        preparation_onboarding: preparation,
      });
    },
  );
}
