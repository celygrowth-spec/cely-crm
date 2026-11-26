// Onboarding de l'offre découverte vu par le connecteur Claude (get_project) : mêmes données que le panneau de
// suivi (fonction discovery_admin, réservée au propriétaire), avec l'origine de chaque valeur. Les écritures passent
// par src/lib/mcp/discovery-tools.ts. Ni chemin de stockage ni lien de fichier : les blacklists et archives LinkedIn
// contiennent des données personnelles et restent dans l'application.
import type { SupabaseClient } from "@supabase/supabase-js";
import { OFFER_QUESTIONS, STEPS } from "./content";
import { discoveryAdmin } from "./service";
import { stepProgress, unknownQuestions } from "./types";
import { WEBSITE_KEY } from "./website";

/** Origine lisible d'une valeur : qui l'a écrite. */
export const ORIGIN_LABEL = { client: "client (portail)", owner: "utilisateur", claude: "proposée par Claude" } as const;
const origin = (o: keyof typeof ORIGIN_LABEL | undefined) => ORIGIN_LABEL[o ?? "client"];

const LABELS: Record<string, string> = { not_started: "non commencé", in_progress: "en cours", complete: "complétée (pas encore envoyée)", sent: "envoyé" };

export async function discoveryForMcp(sb: SupabaseClient, projectId: string) {
  const a = await discoveryAdmin(sb, projectId);
  if (!a) return null;
  if (!a.exists) return a.suggested ? { offre_decouverte: false, suggestion: "La vente liée s'appelle « offre découverte » : la case peut être cochée dans l'application." } : null;
  return {
    offre_decouverte: a.enabled,
    etat: a.sent_at ? "envoyé" : a.started_at ? "en cours" : "non commencé",
    envoye_le: a.sent_at,
    envoye_par: a.sent_by ?? (a.sent_at && a.sent_origin && a.sent_origin !== "client" ? `marqué envoyé (${origin(a.sent_origin)})` : null),
    modifie_apres_envoi_le: a.changed_after_send_at,
    etapes: Object.fromEntries(STEPS.filter((s) => s.key !== "welcome").map((s) => [s.key, { avancement: LABELS[stepProgress(a, s.key)], choix: a.steps[s.key]?.status ?? null, ...(a.steps[s.key] ? { origine: origin(a.origins?.steps[s.key]) } : {}) }])),
    // « Je ne sais pas » : question à compléter avec le client (réponse vide)
    reponses: OFFER_QUESTIONS.map((q) => ({ key: q.key, question: q.title, reponse: a.answers[q.key]?.value || null, je_ne_sais_pas: !!a.answers[q.key]?.unknown, origine: a.answers[q.key] ? origin(a.origins?.answers[q.key]) : null, par: a.answers[q.key]?.by ?? null, le: a.answers[q.key]?.at ?? null })),
    a_completer_avec_le_client: unknownQuestions(a).map((q) => q.title),
    site_web: a.answers[WEBSITE_KEY]?.value || null,
    site_web_origine: a.answers[WEBSITE_KEY]?.value ? origin(a.origins?.answers[WEBSITE_KEY]) : null,
    fichiers: a.files.map((f) => ({ id: f.id, etape: f.step, origine: origin(a.origins?.files[f.id]), nom: f.name, taille_octets: f.size, compte_linkedin: f.account, depose_par: f.by, le: f.at })),
    cibles: a.targets.map((t) => ({
      position: t.position, nom: t.name, secteur: t.sector, taille: t.company_size, postes: t.roles, zone: t.geography, notes: t.notes,
      completee_par_le_client: t.client_filled, proposee_par_claude: a.origins?.targets[String(t.position)] ?? [], validee_le: t.validated_at, validee_par: t.validated_by, modifiee_depuis_validation: t.modified_since_validation,
      commentaires: t.comments.map((c) => ({ texte: c.body, par: c.by, le: c.at })),
    })),
    changements_apres_envoi: a.changes.slice(0, 50),
    contacts: a.contacts,
  };
}
