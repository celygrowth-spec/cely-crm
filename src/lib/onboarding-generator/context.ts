import "server-only";
// Ce que le générateur d'onboarding apporte à la préparation de projet existante : le questionnaire validé et la
// proposition signée. Lu par la session Claude à travers open_project_onboarding (aucun outil parallèle).
import type { SupabaseClient } from "@supabase/supabase-js";
import { QUESTIONS } from "@/content/generators";
import { answerText, type Answers } from "@/lib/generators/rules";

export type SignedRef = { version_id: string; version: number; latest_version: number; dossier_id: string };

/** Proposition signée de la fiche (la plus récente), ou null. */
export async function signedProposalOf(sb: SupabaseClient, companyId: string): Promise<SignedRef | null> {
  const { data } = await sb.from("proposal_signed").select("version_id, version, latest_version, dossier_id").eq("company_id", companyId).order("signed_at", { ascending: false }).limit(1);
  return (data?.[0] as SignedRef | undefined) ?? null;
}

export async function versionAnswers(sb: SupabaseClient, versionId: string): Promise<{ answers: Answers; file_id: string | null } | null> {
  const { data } = await sb.from("generator_versions").select("answers, file_id").eq("id", versionId).maybeSingle();
  return (data as { answers: Answers; file_id: string | null } | null) ?? null;
}

const readable = (kind: "proposal" | "onboarding", answers: Answers, withInternal = false) =>
  QUESTIONS[kind]
    .filter((q) => (withInternal || !q.internal) && answers[q.key] !== undefined)
    .map((q) => ({ question: q.label, reponse: answerText(q, answers[q.key].value), provenance: answers[q.key].origin === "owner" ? "saisi par l'utilisateur" : answers[q.key].provenance ?? answers[q.key].origin }));

/** Complément lu par la session Claude des projets : null si le projet n'a pas de dossier de générateur. */
export async function generatorContext(sb: SupabaseClient, projectId: string, companyId: string) {
  const { data: dossier } = await sb.from("generator_dossiers").select("id").eq("project_id", projectId).eq("kind", "onboarding").order("created_at", { ascending: false }).limit(1);
  const id = (dossier?.[0] as { id: string } | undefined)?.id;
  if (!id) return null;
  const [{ data: answers }, signed] = await Promise.all([
    sb.from("generator_answers").select("question_key, value, provenance, origin").eq("dossier_id", id),
    signedProposalOf(sb, companyId),
  ]);
  const current: Answers = Object.fromEntries(((answers ?? []) as { question_key: string; value: never; provenance: string | null; origin: never }[]).map((a) => [a.question_key, { value: a.value, provenance: a.provenance, origin: a.origin }]));
  const proposal = signed ? await versionAnswers(sb, signed.version_id) : null;
  return {
    questionnaire_onboarding: {
      consigne: "Réponses validées par l'utilisateur pour cet onboarding : elles priment sur toute déduction. Reprenez-les dans l'analyse, les slides et le planning.",
      reponses: readable("onboarding", current),
    },
    proposition_signee: signed && proposal ? {
      version: signed.version,
      note: signed.version < signed.latest_version ? `La V${signed.version} a été signée alors qu'une version plus récente existe : c'est la V${signed.version} qui fait foi.` : "Version signée par le client : elle fait foi pour les engagements.",
      reponses: readable("proposal", proposal.answers),
    } : null,
  };
}
