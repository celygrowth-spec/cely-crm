// Outils MCP de la préparation de projet (après « Gagné ») : lire les sources de la fiche du projet,
// enregistrer l'analyse (jamais par-dessus les corrections de l'utilisateur) et déposer les slides
// d'onboarding dans un dossier interne. Aucun de ces outils ne rend quelque chose visible du client.
import { z } from "zod";
import * as ob from "@/lib/projects/onboarding";
import { SECTION_KEYS } from "@/lib/projects/onboarding-rules";
import { DATA_NOTE, text, uuid } from "./helpers";
import type { RegisterTool } from "./project-tools";

const project = { project_id: uuid };

export function registerOnboardingTools(tool: RegisterTool) {
  tool(
    "open_project_onboarding",
    {
      title: "Ouvrir la préparation d'un projet",
      description: "À appeler en premier (le message de l'utilisateur ou de la tâche donne l'identifiant du projet). Renvoie l'état, les sections préparées (origin=owner : corrigées par l'utilisateur, à respecter), les points en attente, la proposition retenue, les documents de la fiche, les appels Fireflies avec leur résumé, le diagnostic retenu, les interlocuteurs et la bibliothèque (modèle Cely).",
      inputSchema: z.object(project),
      readOnly: true,
    },
    async ({ project_id }, sb) => text(await ob.openForClaude(sb, project_id), DATA_NOTE),
  );

  tool(
    "get_project_onboarding_document_url",
    {
      title: "Télécharger un document de la fiche du projet",
      description: "Lien valable 5 minutes vers un document de la fiche de ce projet (proposition, contrat, diagnostic). Récupérez-le avec curl depuis votre environnement d'exécution ; ne recopiez jamais le lien. Si vous ne pouvez pas lire le contenu, dites-le au lieu de le supposer.",
      inputSchema: z.object({ ...project, file_id: uuid }),
      readOnly: true,
    },
    async ({ project_id, file_id }, sb) => text({ url: await ob.claudeDocumentUrl(sb, project_id, file_id), expire_dans_secondes: 300 }),
  );

  tool(
    "get_project_onboarding_transcript",
    {
      title: "Lire la transcription d'un appel du projet",
      description: "Lignes de la transcription Fireflies d'un appel rattaché à la fiche du projet (offset, limit ≤ 1000). Citez l'appel et le moment (champ start, en secondes) dans les références.",
      inputSchema: z.object({ ...project, call_id: uuid, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(400) }),
      readOnly: true,
    },
    async ({ project_id, call_id, offset, limit }, sb) => text(await ob.callTranscript(sb, project_id, call_id, offset, limit), DATA_NOTE),
  );

  const item = ob.sectionItemSchema;
  tool(
    "save_project_onboarding_analysis",
    {
      title: "Enregistrer l'analyse d'un projet",
      description:
        "Enregistre les sections (mission, objectives, scope, deliverables, phases, first_actions, context, findings) avec leurs références (refs : kind file|call|diagnostic, id, label, excerpt, at en secondes pour un appel). Une section corrigée par l'utilisateur n'est jamais remplacée. Une date non confirmée : date_status=provisional ; inconnue : unknown. Marquez suggested=true ce qui est une proposition de votre part. Les points (items) ne portent que sur ce qui manque vraiment au démarrage : regroupez les questions redondantes, adaptez-les à la prestation ; kind=conflict avec deux options et leurs références quand deux sources se contredisent ; kind=client_request quand l'information doit venir du client (accès, fichier). start_date : seulement si une source confirme la date de démarrage. Ne rend rien visible du client.",
      inputSchema: z.object({
        ...project,
        sections: z.partialRecord(z.enum(SECTION_KEYS), z.array(item).max(30)).default({}),
        items: z.array(ob.analysisItemSchema).max(20).default([]),
        start_date: z.iso.date().nullable().default(null),
      }),
    },
    async ({ project_id, sections, items, start_date }, sb) => text(await ob.saveAnalysis(sb, project_id, sections, items, start_date)),
  );

  tool(
    "report_project_onboarding_failure",
    {
      title: "Signaler l'échec de l'analyse ou des slides",
      description: "Indique à l'utilisateur, dans le projet, pourquoi l'analyse (stage=analyse) ou la génération des slides (stage=slides) n'a pas pu aboutir. Il pourra relancer.",
      inputSchema: z.object({ ...project, stage: z.enum(["analyse", "slides"]), message: z.string().trim().min(1).max(2000) }),
    },
    async ({ project_id, stage, message }, sb) => {
      if (stage === "analyse") await ob.reportAnalysisFailure(sb, project_id, message);
      else await ob.reportDeckFailure(sb, project_id, message);
      return text({ resultat: "échec enregistré, visible dans le projet" });
    },
  );

  tool(
    "start_onboarding_deck_upload",
    {
      title: "Préparer le dépôt des slides d'onboarding",
      description: "Ouvre la version demandée (ou la suivante) et renvoie une adresse de dépôt. Envoyez-y le .pptx (curl -X PUT --data-binary @fichier -H 'Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation'), puis appelez confirm_onboarding_deck_upload. Le fichier reste interne au projet. Ne recopiez jamais l'adresse.",
      inputSchema: z.object({ ...project, size_bytes: z.number().int().positive().max(25 * 1024 * 1024), company_name: z.string().trim().min(1).max(160) }),
    },
    async ({ project_id, size_bytes, company_name }, sb) => {
      const r = await ob.startDeckUpload(sb, project_id, size_bytes, company_name);
      return text({ version: r.version, nom: r.name, adresse_depot: r.uploadUrl });
    },
  );

  tool(
    "confirm_onboarding_deck_upload",
    {
      title: "Confirmer le dépôt des slides d'onboarding",
      description: "Vérifie que le stockage a bien reçu le fichier, puis range la version dans le dossier interne « Onboarding (interne) » du projet. Le partage au client se fait ensuite par l'utilisateur, dans l'application.",
      inputSchema: z.object({ ...project, version: z.number().int().min(1) }),
    },
    async ({ project_id, version }, sb) => text(await ob.confirmDeckUpload(sb, project_id, version)),
  );
}
