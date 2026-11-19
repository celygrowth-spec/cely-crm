// Outils MCP de la proposition, équivalents de ceux du diagnostic : lire les sources RETENUES de la fiche du dossier,
// proposer des réponses (jamais par-dessus celles de l'utilisateur, jamais de montant) et déposer le PDF de la
// version en cours. Mêmes garde-fous que l'interface, appliqués en base : un dossier, une génération, une validation,
// un envoi, une signature et tout appel à Make ne se font que dans l'application, par une action de l'utilisateur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { QUESTIONS } from "@/content/generators";
import { CrmError } from "@/lib/crm/service";
import { answerText, isBlank, latestVersion, type Answers, type GeneratorDossier } from "@/lib/generators/rules";
import * as gen from "@/lib/generators/service";
import { DATA_NOTE, text, uuid } from "./helpers";
import type { RegisterTool } from "./project-tools";

const dossier = { proposal_id: uuid };
/** Questions dont Claude ne propose jamais la réponse : les montants viennent de l'utilisateur, pas d'une estimation. */
export const AMOUNT_KEYS = new Set(["lignes_devis"]);
const internal = new Set(QUESTIONS.proposal.filter((q) => q.internal).map((q) => q.key));

/** Réponses lisibles par l'IA : les coordonnées de facturation restent dans le CRM. */
export function forAi(answers: Answers) {
  return QUESTIONS.proposal.filter((q) => !q.internal).map((q) => {
    const a = answers[q.key];
    return {
      key: q.key, section: q.section, question: q.label, aide: q.help ?? null, type: q.type, obligatoire: !!q.required,
      ...(q.options ? { choix: q.options.map((o) => o.value) } : {}),
      reponse: a && !isBlank(a.value) ? (q.type === "person" || q.type === "lines" ? a.value : answerText(q, a.value)) : null,
      origine: a ? (a.origin === "owner" ? "saisie par l'utilisateur : ne se remplace pas" : a.origin === "crm" ? "reprise du CRM : à affiner si une source est plus précise" : "proposée par Claude") : "vide",
      provenance: a?.provenance ?? null,
    };
  });
}

/** Une proposition précédente lue comme source : sans les coordonnées de facturation. */
export function stripInternal<T>(data: T): T {
  if (!data || typeof data !== "object" || Array.isArray(data) || !("reponses" in data)) return data;
  const r = (data as { reponses?: Record<string, unknown> }).reponses ?? {};
  return { ...data, reponses: Object.fromEntries(Object.entries(r).filter(([k]) => !internal.has(k))) };
}

export function stageOf(d: Pick<GeneratorDossier, "versions">): "preremplissage" | "slides" | "rien" {
  const v = latestVersion(d);
  if (!v) return "preremplissage";
  return v.validated_at || v.slides_status === "ready" ? "rien" : "slides";
}

const CONSIGNES = {
  preremplissage: `Étape : pré-remplissage du questionnaire. Lisez d'abord chaque source retenue (read_proposal_source, en suivant les pages), puis les éléments de bibliothèque sélectionnés (get_library_prompt, get_library_file_url). Proposez ensuite, avec save_proposal_answers, une réponse aux questions vides ou reprises du CRM quand une source la donne : la provenance est obligatoire et précise (« repris de l'appel du 12/11 », « repris du diagnostic », « repris de l'email du 03/11 »). Ne proposez JAMAIS de prix, de montant ni de ligne de devis : ils sont saisis par l'utilisateur. N'inventez rien : une question sans source reste vide. Une réponse saisie par l'utilisateur ne se remplace pas. Rien n'est généré ni envoyé à cette étape.`,
  slides: `Étape : slides de la version en cours. Partez UNIQUEMENT des réponses de cette version (version_en_cours.reponses) et des sources retenues. Reprenez la direction artistique du diagnostic : charte, modèle et exemples de la bibliothèque sélectionnée, avec vérification visuelle de chaque slide. Les lignes, les quantités et les montants sont repris à l'identique des réponses : ne les recalculez pas, ne les arrondissez pas, n'en ajoutez pas. Respectez le ton demandé et les points sensibles à éviter. Si un retour accompagne la version, appliquez-le à partir de la version précédente (lisez son fichier avec read_proposal_source). Exportez en PDF (une slide par page, paysage 16:9), puis déposez-le : start_proposal_version, envoi du fichier à l'adresse reçue avec Content-Type: application/pdf, confirm_proposal_version. En cas d'impossibilité, report_proposal_failure avec une raison compréhensible. Vous ne validez pas, n'envoyez rien au client et n'appelez aucun autre service : l'utilisateur relit dans l'application.`,
  rien: "Aucune étape en attente pour ce dossier : la dernière version est déjà reçue ou validée. Une nouvelle version se demande dans l'application (Régénérer).",
};

async function proposal(sb: SupabaseClient, id: string) {
  const d = await gen.getDossier(sb, id);
  if (d.kind !== "proposal") throw new CrmError("Ce dossier n'est pas une proposition.");
  return d;
}

export function registerGeneratorTools(tool: RegisterTool) {
  tool(
    "open_proposal",
    {
      title: "Ouvrir un dossier de proposition",
      description: "À appeler en premier (le message de l'utilisateur ou de la tâche donne l'identifiant du dossier). Renvoie l'étape en cours et ses consignes, la fiche, le questionnaire avec les réponses actuelles et leur provenance, les sources retenues par l'utilisateur, la sélection de bibliothèque et les versions. Un dossier se crée uniquement dans l'application.",
      inputSchema: z.object(dossier),
      readOnly: true,
    },
    async ({ proposal_id }, sb) => {
      const d = await proposal(sb, proposal_id);
      const stage = stageOf(d);
      const current = latestVersion(d);
      const previous = [...d.versions].sort((a, b) => b.version - a.version).find((v) => v.slides_status === "ready" && v.id !== current?.id);
      return text({
        etape: stage,
        consignes: CONSIGNES[stage],
        dossier: { id: d.id, cree_le: d.created_at, erreur_precedente: d.last_error },
        questionnaire: stage === "slides" ? undefined : forAi(d.answers),
        version_en_cours: stage === "slides" && current ? {
          version: current.version, etat: current.slides_status, retour_de_l_utilisateur: current.feedback,
          reponses: forAi(current.answers).filter((q) => q.reponse !== null),
          version_precedente: previous ? { version: previous.version, lecture: previous.file_id ? `read_proposal_source avec source « fichier:${previous.file_id} »` : "fichier supprimé de la fiche" } : null,
        } : undefined,
        sources_retenues: d.sources.filter((s) => s.retenue).map((s) => ({ source: s.cle, type: s.type, titre: s.titre, date: s.date })),
        sources_ecartees_par_l_utilisateur: d.sources.filter((s) => !s.retenue).length,
        bibliotheque_selectionnee: d.library.filter((l) => l.selected).map((l) => ({ id: l.id, nom: l.name, dossier: l.folder, lecture: l.kind === "prompt" ? "get_library_prompt" : "get_library_file_url" })),
        versions: d.versions.map((v) => ({ version: v.version, slides: v.slides_status, validee: !!v.validated_at, envoyee: !!v.sent_at })),
      }, DATA_NOTE);
    },
  );

  tool(
    "read_proposal_source",
    {
      title: "Lire une source retenue d'une proposition",
      description: "Lit une source de la fiche du dossier par sa clé, telle que listée par open_proposal (« fiche », « personnes », « notes », « appel:<id> », « email:<id> », « rdv:<id> », « diagnostic:<id> », « proposition:<id> », « fichier:<id> »). Par pages : offset en lignes pour un appel ou des notes, en caractères pour un fichier (suivez suite_offset). Une source écartée par l'utilisateur, ou d'une autre fiche, est refusée.",
      inputSchema: z.object({ ...dossier, source: z.string().min(2).max(60), offset: z.number().int().min(0).max(10_000_000).default(0) }),
      readOnly: true,
    },
    async ({ proposal_id, source, offset }, sb) => {
      await proposal(sb, proposal_id);
      return text(stripInternal(await gen.readSource(sb, proposal_id, source, offset)), DATA_NOTE);
    },
  );

  tool(
    "save_proposal_answers",
    {
      title: "Proposer des réponses au questionnaire",
      description: "Enregistre vos propositions de réponse, chacune avec sa provenance. Une réponse saisie par l'utilisateur n'est jamais remplacée ; une question inconnue ou une forme invalide est refusée, avec la raison. Les prix, montants et lignes de devis ne se proposent pas : l'utilisateur les saisit. N'enregistre rien d'autre : ni génération, ni validation, ni envoi.",
      inputSchema: z.object({
        ...dossier,
        answers: z.array(z.object({
          key: z.string().regex(/^[a-z0-9_]{2,60}$/),
          value: z.union([z.string().max(10000), z.number(), z.object({ person_id: z.uuid().nullish(), first_name: z.string().max(100), last_name: z.string().max(100), title: z.string().max(150).nullish(), email: z.string().max(254).nullish() })]),
          provenance: z.string().trim().min(3).max(200).describe("D'où vient la réponse : « repris de l'appel du 12/11 », « repris du diagnostic »…"),
        })).min(1).max(60),
      }),
    },
    async ({ proposal_id, answers }, sb) => {
      await proposal(sb, proposal_id);
      const amounts = answers.filter((a) => AMOUNT_KEYS.has(a.key)).map((a) => `${a.key} : les montants se saisissent dans l'application`);
      const r = await gen.saveClaudeAnswers(sb, proposal_id, "proposal", answers.filter((a) => !AMOUNT_KEYS.has(a.key)));
      return text({ resultat: "propositions enregistrées", ...r, refusees: [...amounts, ...r.refusees] });
    },
  );

  tool(
    "start_proposal_version",
    {
      title: "Préparer le dépôt des slides d'une proposition",
      description: "Refusé tant que l'utilisateur n'a pas lancé la génération dans l'application. Ouvre ou reprend le dépôt de la version en cours et renvoie une adresse de dépôt à usage unique : envoyez-y le PDF (PUT, Content-Type: application/pdf), puis appelez confirm_proposal_version. Ne recopiez jamais cette adresse dans votre réponse.",
      inputSchema: z.object({ ...dossier, size_bytes: z.number().int().positive().max(26_214_400) }),
    },
    async ({ proposal_id, size_bytes }, sb) => {
      const d = await proposal(sb, proposal_id);
      const { data } = await sb.from("companies").select("name").eq("id", d.company_id).maybeSingle();
      const v = await gen.startVersion(sb, proposal_id, "proposal", size_bytes, (data?.name as string | undefined) ?? "");
      return text({ version: v.version, nom_du_fichier: v.name, adresse_de_depot: v.uploadUrl, methode: "PUT", content_type: "application/pdf", ensuite: "confirm_proposal_version" });
    },
  );

  tool(
    "confirm_proposal_version",
    {
      title: "Confirmer le dépôt des slides d'une proposition",
      description: "Vérifie que le PDF est bien reçu et lisible, puis passe la version à « à relire ». Un autre format est refusé avec la marche à suivre. La validation et l'envoi restent à l'utilisateur, dans l'application.",
      inputSchema: z.object({ ...dossier, version: z.number().int().min(1) }),
    },
    async ({ proposal_id, version }, sb) => {
      await proposal(sb, proposal_id);
      return text({ resultat: "version reçue, à relire par l'utilisateur", ...(await gen.confirmVersion(sb, proposal_id, "proposal", version)) });
    },
  );

  tool(
    "report_proposal_failure",
    {
      title: "Signaler un échec sur une proposition",
      description: "À appeler si l'étape ne peut pas aboutir (source illisible, modèle introuvable, dépôt impossible). Le message est montré à l'utilisateur, qui pourra réessayer : ses réponses sont conservées. N'y mettez ni adresse de dépôt ni donnée personnelle.",
      inputSchema: z.object({ ...dossier, message: z.string().trim().min(5).max(1000) }),
    },
    async ({ proposal_id, message }, sb) => {
      await proposal(sb, proposal_id);
      await gen.reportFailure(sb, proposal_id, message);
      return text({ resultat: "échec signalé à l'utilisateur" });
    },
  );
}
