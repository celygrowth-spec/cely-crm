import "server-only";
// Générer l'onboarding : même principe que le diagnostic (sources, questions pré-remplies, version, relecture,
// validation), mais la génération remplit l'onboarding de projet EXISTANT : points bloquants, sections, analyse et
// slides par la tâche Claude des projets, puis planning et tâches à la validation. Aucun circuit parallèle.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { QUESTIONS } from "@/content/generators";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { assertComplete, rpc, type Generated, type TriggerOutcome } from "@/lib/generators/service";
import type { Answers } from "@/lib/generators/rules";
import * as ob from "@/lib/projects/onboarding";
import { projectPlanning } from "@/lib/projects/owner";
import type { SectionItem, SectionKey } from "@/lib/projects/onboarding-rules";
import { createTask, savePlanning } from "@/lib/projects/service";
import { signedProposalOf, versionAnswers } from "./context";

const uuid = z.uuid("Identifiant invalide");

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}

async function dossierOf(sb: SupabaseClient, id: string) {
  const d = check<{ id: string; kind: string; company_id: string; project_id: string | null } | null>(await sb.from("generator_dossiers").select("id, kind, company_id, project_id").eq("id", uuid.parse(id)).maybeSingle());
  if (!d || d.kind !== "onboarding") throw new CrmError("Dossier d'onboarding introuvable.");
  if (!d.project_id) throw new CrmError("Ce dossier n'est rattaché à aucun projet.");
  return d as { id: string; company_id: string; project_id: string };
}

const text = (a: Answers, k: string) => { const v = a[k]?.value; return typeof v === "string" ? v.trim() : ""; };
const lines = (s: string): SectionItem[] => s.split(/\n+/).map((l) => l.replace(/^[\s\-•*\d.)]+/, "").trim()).filter(Boolean).slice(0, 30).map((l) => ({ text: l.slice(0, 1000) }));

/** Sections de la préparation tirées du questionnaire. */
export function sectionsFromAnswers(a: Answers): Partial<Record<SectionKey, SectionItem[]>> {
  const labelled = (["interlocuteurs", "acces", "outils", "rituels", "vigilance"] as const).flatMap((k) => {
    const v = text(a, k);
    const q = QUESTIONS.onboarding.find((x) => x.key === k);
    return v && q ? [{ text: `${q.label.replace(/\s*\?$/, "")} : ${v.replace(/\n+/g, " ; ")}`.slice(0, 1000) }] : [];
  });
  return { first_actions: lines(text(a, "premieres_actions")), context: labelled };
}

const same = (a: SectionItem[] | undefined, b: SectionItem[] | undefined) => JSON.stringify((a ?? []).map((x) => x.text)) === JSON.stringify((b ?? []).map((x) => x.text));

/**
 * Remplit la préparation existante à partir du questionnaire et de la proposition signée, par les mêmes fonctions
 * que l'écran « Préparer l'onboarding ». Une section que j'ai modifiée entre-temps dans le projet n'est pas remplacée.
 */
export async function fillProjectOnboarding(sb: SupabaseClient, projectId: string, companyId: string, answers: Answers, previous: Answers | null) {
  const o = await ob.getOnboarding(sb, projectId);
  if (!o) throw new CrmError("Ce projet n'est lié à aucune vente : pas de préparation à remplir.");
  const signed = await signedProposalOf(sb, companyId);
  const proposal = signed ? await versionAnswers(sb, signed.version_id) : null;
  const pa = proposal?.answers ?? {};
  const open = (key: string) => o.items.find((i) => i.key === key && i.status === "open");
  const filled: string[] = [];
  const answer = async (key: string, action: ob.AnswerAction, value: string | null, file: string | null = null) => {
    const item = open(key);
    if (!item || (!value && !file)) return;
    await ob.answerItem(sb, item.id, action, value, file);
    filled.push(key);
  };
  await answer("proposal", "file", null, proposal?.file_id ?? null);
  await answer("objectives", "text", [text(pa, "objectifs"), text(pa, "indicateurs") && `Indicateurs : ${text(pa, "indicateurs")}`].filter(Boolean).join("\n").slice(0, 5000) || null);
  await answer("scope", "text", [text(pa, "perimetre"), text(pa, "canaux") && `Canaux : ${text(pa, "canaux")}`, text(pa, "exclusions") && `Exclu : ${text(pa, "exclusions")}`].filter(Boolean).join("\n").slice(0, 5000) || null);
  await answer("start_date", "date", text(answers, "date_lancement") || null);

  const next = sectionsFromAnswers(answers);
  const before = previous ? sectionsFromAnswers(previous) : {};
  for (const key of ["first_actions", "context"] as const) {
    const items = next[key] ?? [];
    const section = o.sections[key];
    const current = section?.items;
    // le questionnaire fait foi sur une section vide, proposée par le CRM ou par Claude, ou inchangée depuis la
    // version précédente du générateur ; une section que j'ai corrigée dans le projet entre-temps est conservée
    const replaceable = !current?.length || section?.origin !== "owner" || same(current, before[key]);
    if (items.length && replaceable && !same(current, items)) {
      await ob.saveSection(sb, projectId, key, items);
      filled.push(key);
    }
  }
  return filled;
}

export type OnboardingGenerated = Generated & { slides: TriggerOutcome; filled: string[] };

/** Analyse puis slides par la tâche Claude des projets. Un projet pas encore prêt : la version l'explique et se relance. */
async function launch(sb: SupabaseClient, dossier: { id: string; project_id: string }, fetcher?: typeof fetch): Promise<TriggerOutcome> {
  const analysis = await ob.requestAnalysis(sb, dossier.project_id, fetcher);
  try {
    const deck = await ob.requestDeck(sb, dossier.project_id, fetcher);
    return { triggered: analysis.triggered || deck.triggered, ...("error" in deck && deck.error ? { error: deck.error } : analysis.error ? { error: analysis.error } : {}) };
  } catch (e) {
    const message = e instanceof CrmError ? e.message : "Les slides n'ont pas pu être demandées.";
    await rpc(sb, "generator_report_failure", { p_id: dossier.id, p_message: message });
    return { triggered: false, error: message };
  }
}

async function previousAnswers(sb: SupabaseClient, dossierId: string, before: number): Promise<Answers | null> {
  const rows = check<{ answers: Answers }[]>(await sb.from("generator_versions").select("answers").eq("dossier_id", dossierId).lt("version", before).order("version", { ascending: false }).limit(1));
  return rows[0]?.answers ?? null;
}

/** « Générer » : fige les réponses (v1, v2…), remplit la préparation du projet, puis lance analyse et slides. */
export async function generateOnboarding(sb: SupabaseClient, id: string, key: string, feedback: string | null, fetcher?: typeof fetch): Promise<OnboardingGenerated> {
  const d = await dossierOf(sb, id);
  const answers = await assertComplete(sb, id, "onboarding");
  const v = await rpc<Generated>(sb, "generator_generate", { p_id: d.id, p_key: z.string().min(8).max(100).parse(key), p_feedback: feedback?.slice(0, 10000) ?? null });
  const filled = v.created ? await fillProjectOnboarding(sb, d.project_id, d.company_id, answers, await previousAnswers(sb, d.id, v.version)) : [];
  return { ...v, filled, slides: v.created ? await launch(sb, d, fetcher) : { triggered: false } };
}

/** « Réessayer » : même version, mêmes réponses. */
export async function retryOnboarding(sb: SupabaseClient, versionId: string, fetcher?: typeof fetch): Promise<TriggerOutcome> {
  const dossierId = await rpc<string>(sb, "generator_retry_slides", { p_version: uuid.parse(versionId) });
  const d = await dossierOf(sb, dossierId);
  const v = check<{ answers: Answers; version: number }>(await sb.from("generator_versions").select("answers, version").eq("id", versionId).single());
  await fillProjectOnboarding(sb, d.project_id, d.company_id, v.answers, await previousAnswers(sb, d.id, v.version));
  return launch(sb, d, fetcher);
}

/**
 * Validation : la version est figée, puis le planning validé alimente le projet par les fonctions existantes.
 * Phases : créées seulement si le projet n'en a pas encore. Premières actions : une tâche chacune, attribuée au
 * propriétaire, jamais visible du client ; une tâche du même intitulé n'est pas recréée.
 */
export async function validateOnboarding(sb: SupabaseClient, versionId: string) {
  const row = check<{ dossier_id: string } | null>(await sb.from("generator_versions").select("dossier_id").eq("id", uuid.parse(versionId)).maybeSingle());
  if (!row) throw new CrmError("Version introuvable.");
  const d = await dossierOf(sb, row.dossier_id);
  const validated_at = await rpc<string>(sb, "generator_validate", { p_version: versionId });
  const o = await ob.getOnboarding(sb, d.project_id);
  const planning = await projectPlanning(sb, d.project_id);
  let phases = 0;
  const wanted = (o?.sections.phases?.items ?? []).filter((x) => x.text.trim());
  if (!planning.phases.length && wanted.length) {
    await savePlanning(sb, d.project_id, wanted.slice(0, 20).map((x) => ({ name: x.text.slice(0, 80), description: x.text.length > 80 ? x.text : null, deliverables: null, start_date: x.date ?? null, end_date: null, color: "violet" as const, status: "a_venir" as const })), planning.milestones);
    phases = Math.min(wanted.length, 20);
  }
  const existing = new Set(check<{ title: string }[]>(await sb.from("project_tasks").select("title").eq("project_id", d.project_id)).map((t) => t.title.trim().toLowerCase()));
  let tasks = 0;
  for (const a of (o?.sections.first_actions?.items ?? []).slice(0, 30)) {
    const title = a.text.trim().slice(0, 300);
    if (!title || existing.has(title.toLowerCase())) continue;
    await createTask(sb, d.project_id, { title, description: null, status: "a_faire", assignee_kind: "owner", assignee_person_id: null, visible_to_client: false, due_date: null, blocked_reason: null, meeting_id: null, links: [] });
    existing.add(title.toLowerCase());
    tasks += 1;
  }
  const parts = [phases && `${phases} phase${phases > 1 ? "s" : ""} au planning`, tasks && `${tasks} tâche${tasks > 1 ? "s" : ""} créée${tasks > 1 ? "s" : ""}`].filter(Boolean);
  return { validated_at, phases, tasks, message: parts.length ? `Onboarding validé : ${parts.join(", ")} (rien n'est visible du client sans votre partage).` : "Onboarding validé." };
}
