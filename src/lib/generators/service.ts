import "server-only";
// Socle commun des générateurs (proposition, onboarding), côté serveur. Utilisé par les routes de l'application et
// par le connecteur MCP : les droits (sources bornées à la fiche du dossier, versions figées, actions réservées à
// l'application) sont appliqués en base (migration 20261123000200_generateurs_socle.sql).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { QUESTIONS } from "@/content/generators";
import { openPdfDeposit, readCompanyFile, receivePdf } from "@/lib/crm/diagnostic";
import { fireRoutine, routineConfig } from "@/lib/crm/diagnostic-trigger";
import { listLibrary } from "@/lib/crm/library";
import { pathLabel } from "@/lib/crm/library-rules";
import { CrmError, friendlyError } from "@/lib/crm/service";
import {
  GENERATOR_NAMES, answerProblem, generatorRoutineText, missingRequired,
  type AnswerValue, type Answers, type GeneratorDossier, type GeneratorKind, type GeneratorStage, type GeneratorVersion, type LibraryChoice, type PersonValue, type QuoteLine, type Source,
} from "./rules";

const uuid = z.uuid("Identifiant invalide");
const keySchema = z.string().min(8).max(100);
const COLUMNS = "id, kind, company_id, project_id, created_at, prefill_state, trigger_ref, triggered_at, trigger_error, session_url, last_error, library_item_ids";
const VERSION_COLUMNS = "id, version, slides_status, slides_error, file_id, feedback, created_at, ready_at, validated_at, sent_at, answers";

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}
export const rpc = async <T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>) => check<T>(await sb.rpc(fn, args));

/** Tâche Claude d'un générateur : celle de la proposition, ou celle des projets (déjà en place) pour l'onboarding. */
export const generatorRoutine = (kind: GeneratorKind) => routineConfig(kind === "proposal" ? "PROPOSITION" : "ONBOARDING");

const dayMonth = (iso: string) => new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", timeZone: "Europe/Paris" }).format(new Date(iso));

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

type Row = Omit<GeneratorDossier, "answers" | "sources" | "library" | "versions" | "auto_routine"> & { library_item_ids: string[] };

async function hydrate(sb: SupabaseClient, row: Row): Promise<GeneratorDossier> {
  const [answers, versions, sources, lib] = await Promise.all([
    sb.from("generator_answers").select("question_key, value, provenance, origin").eq("dossier_id", row.id),
    sb.from("generator_versions").select(VERSION_COLUMNS).eq("dossier_id", row.id).order("version", { ascending: false }),
    rpc<Source[]>(sb, "generator_sources", { p_id: row.id }),
    listLibrary(sb),
  ]);
  const selected = new Set(row.library_item_ids);
  const library: LibraryChoice[] = lib.items
    .map((i) => ({ id: i.id, name: i.display_name, kind: i.kind, folder: pathLabel(lib.folders, i.folder_id), selected: selected.has(i.id) }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || a.folder.localeCompare(b.folder, "fr") || a.name.localeCompare(b.name, "fr"));
  const { library_item_ids: _ids, ...rest } = row;
  void _ids;
  return {
    ...rest,
    auto_routine: !!generatorRoutine(rest.kind),
    answers: Object.fromEntries(check<{ question_key: string; value: AnswerValue; provenance: string | null; origin: Answers[string]["origin"] }[]>(answers).map((a) => [a.question_key, { value: a.value, provenance: a.provenance, origin: a.origin }])),
    versions: check<GeneratorVersion[]>(versions),
    sources,
    library,
  };
}

export async function getDossier(sb: SupabaseClient, id: string): Promise<GeneratorDossier> {
  const row = check<Row | null>(await sb.from("generator_dossiers").select(COLUMNS).eq("id", uuid.parse(id)).maybeSingle());
  if (!row) throw new CrmError("Dossier introuvable.");
  return hydrate(sb, row);
}

/** Dossiers d'une fiche pour un générateur, le plus récent d'abord. */
export async function listDossiers(sb: SupabaseClient, companyId: string, kind: GeneratorKind): Promise<GeneratorDossier[]> {
  const rows = check<Row[]>(await sb.from("generator_dossiers").select(COLUMNS).eq("company_id", uuid.parse(companyId)).eq("kind", kind).order("created_at", { ascending: false }).limit(20));
  return Promise.all(rows.map((r) => hydrate(sb, r)));
}

// ---------------------------------------------------------------------------
// Pré-remplissage par le CRM : ce qu'il sait déjà, avec sa provenance. Jamais d'estimation.
// ---------------------------------------------------------------------------

type Prefill = { key: string; value: AnswerValue; provenance: string };

async function crmPrefill(sb: SupabaseClient, kind: GeneratorKind, companyId: string, dossierId: string): Promise<Prefill[]> {
  const [company, people, others] = await Promise.all([
    sb.from("companies").select("name, amount, amount_recurring").eq("id", companyId).maybeSingle(),
    sb.from("people").select("id, first_name, last_name, title, email, is_primary").eq("company_id", companyId).order("is_primary", { ascending: false }).order("created_at"),
    sb.from("generator_dossiers").select("id").eq("company_id", companyId).eq("kind", "proposal").neq("id", dossierId),
  ]);
  // dernière proposition de la fiche (validée de préférence) : ses réponses évitent toute ressaisie
  const otherIds = check<{ id: string }[]>(others).map((o) => o.id);
  const previous = otherIds.length
    ? await sb.from("generator_versions").select("version, answers, validated_at, created_at").in("dossier_id", otherIds)
        .order("validated_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(1)
    : { data: [], error: null };
  const c = check<{ name: string; amount: number | string | null; amount_recurring: boolean } | null>(company);
  const persons = check<{ id: string; first_name: string | null; last_name: string | null; title: string | null; email: string | null; is_primary: boolean }[]>(people);
  const prev = check<{ version: number; answers: Answers; validated_at: string | null; created_at: string }[]>(previous)[0] ?? null;
  const known = new Set(QUESTIONS[kind].map((q) => q.key));
  const out = new Map<string, Prefill>();
  const put = (key: string, value: AnswerValue | null | undefined, provenance: string) => {
    if (known.has(key) && value !== null && value !== undefined && value !== "" && !out.has(key)) out.set(key, { key, value, provenance });
  };
  const person = (p: (typeof persons)[number]): PersonValue => ({ person_id: p.id, first_name: p.first_name ?? "", last_name: p.last_name ?? "", title: p.title, email: p.email });

  if (kind === "proposal") {
    if (prev) for (const [k, a] of Object.entries(prev.answers)) put(k, a.value, `repris de la proposition V${prev.version} du ${dayMonth(prev.validated_at ?? prev.created_at)}`);
    put("raison_sociale", c?.name, "repris de la fiche");
    if (persons[0]) put("signataire", person(persons[0]), persons[0].is_primary ? "contact principal de la fiche" : "premier contact de la fiche");
    const amount = c?.amount == null ? null : Number(c.amount);
    if (amount && amount > 0) {
      const line: QuoteLine = { label: "Accompagnement", quantity: 1, unit: c!.amount_recurring ? "mois" : "forfait", unit_price: amount, vat_rate: 20, recurrence: c!.amount_recurring ? "monthly" : "one_off" };
      put("lignes_devis", [line], "repris du montant de la fiche, à vérifier");
    }
    put("pays", "FR", "valeur par défaut");
  } else {
    // l'onboarding repart de la proposition (signée de préférence) : voir onboardingPrefill dans le lot onboarding
    if (prev) {
      const from = `repris de la proposition V${prev.version}`;
      put("date_lancement", prev.answers.date_demarrage?.value, from);
    }
    if (persons.length) {
      put("interlocuteurs", persons.map((p) => [`${p.first_name ?? ""} ${p.last_name ?? ""}`.trim(), p.title].filter(Boolean).join(", ")).join("\n"), "repris des interlocuteurs de la fiche, rôles à préciser");
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Actions de l'application
// ---------------------------------------------------------------------------

export type TriggerOutcome = { triggered: boolean; error?: string };

/**
 * Lance la tâche Claude pour une étape du dossier, une seule fois. Sans tâche configurée, rien n'est lancé :
 * l'écran propose alors le lien vers Claude.
 */
export async function trigger(sb: SupabaseClient, id: string, kind: GeneratorKind, stage: GeneratorStage, ref: string, fetcher?: typeof fetch): Promise<TriggerOutcome> {
  const cfg = generatorRoutine(kind);
  if (!cfg) return { triggered: false };
  if (!(await rpc<boolean>(sb, "generator_claim_trigger", { p_id: uuid.parse(id), p_ref: ref }))) return { triggered: false };
  try {
    const url = await fireRoutine(generatorRoutineText(kind, stage, id), fetcher, cfg);
    await rpc(sb, "generator_trigger_result", { p_id: id, p_session_url: url, p_error: null });
    return { triggered: true };
  } catch (e) {
    const message = e instanceof CrmError ? e.message : "Lancement impossible.";
    await rpc(sb, "generator_trigger_result", { p_id: id, p_session_url: null, p_error: message });
    return { triggered: false, error: message };
  }
}

/**
 * Ouvre le dossier (un double clic rend le même) : le CRM y dépose aussitôt ce qu'il sait, puis Claude est lancé
 * pour proposer le reste à partir des échanges.
 */
export async function startDossier(sb: SupabaseClient, kind: GeneratorKind, companyId: string, projectId: string | null, key: string, fetcher?: typeof fetch) {
  const r = await rpc<{ id: string; created: boolean }>(sb, "generator_start", { p_kind: kind, p_company: uuid.parse(companyId), p_project: projectId ? uuid.parse(projectId) : null, p_key: keySchema.parse(key) });
  if (r.created) {
    const prefill = await crmPrefill(sb, kind, companyId, r.id);
    if (prefill.length) await rpc(sb, "generator_save_answers", { p_id: r.id, p_answers: prefill, p_origin: "crm" });
  }
  return { id: r.id, created: r.created, ...(await trigger(sb, r.id, kind, "preremplissage", "prefill", fetcher)) };
}

function question(kind: GeneratorKind, key: string) {
  const q = QUESTIONS[kind].find((x) => x.key === key);
  if (!q) throw new CrmError("Question inconnue.");
  return q;
}

/** Réponse saisie ou corrigée par le propriétaire : elle a toujours le dernier mot. Une réponse vide efface. */
export async function saveAnswer(sb: SupabaseClient, id: string, kind: GeneratorKind, key: string, value: unknown) {
  const problem = answerProblem(question(kind, key), value);
  if (problem) throw new CrmError(problem);
  await rpc(sb, "generator_save_answers", { p_id: uuid.parse(id), p_answers: [{ key, value: value ?? "" }], p_origin: "owner" });
}

export const setSelection = (sb: SupabaseClient, id: string, excluded: string[], library: string[] | null) =>
  rpc<null>(sb, "generator_set_selection", { p_id: uuid.parse(id), p_excluded: z.array(z.string().max(60)).max(500).parse(excluded), p_library: library ? z.array(uuid).max(60).parse(library) : null });

export const setDefaultLibrary = (sb: SupabaseClient, kind: GeneratorKind, items: string[]) =>
  rpc<string[]>(sb, "generator_set_default_library", { p_kind: kind, p_items: z.array(uuid).max(60).parse(items) });

export async function getDefaultLibrary(sb: SupabaseClient): Promise<{ kind: GeneratorKind; library_item_ids: string[] }[]> {
  return check(await sb.from("generator_settings").select("kind, library_item_ids"));
}

/** Refuse la génération tant qu'une question obligatoire est vide : ce qui n'est pas demandé finit en approximation. */
export async function assertComplete(sb: SupabaseClient, id: string, kind: GeneratorKind) {
  const rows = check<{ question_key: string; value: AnswerValue }[]>(await sb.from("generator_answers").select("question_key, value").eq("dossier_id", uuid.parse(id)));
  const answers: Answers = Object.fromEntries(rows.map((r) => [r.question_key, { value: r.value, provenance: null, origin: "owner" as const }]));
  const missing = missingRequired(QUESTIONS[kind], answers);
  if (missing.length) throw new CrmError(`Il reste ${missing.length} question${missing.length > 1 ? "s" : ""} obligatoire${missing.length > 1 ? "s" : ""} sans réponse : ${missing.slice(0, 3).map((q) => `« ${q.label} »`).join(", ")}${missing.length > 3 ? "…" : ""}`);
  return answers;
}

export type Generated = { id: string; version: number; created: boolean };

/** « Générer » : fige les réponses dans la version suivante (une seule par clic), puis lance les slides. */
export async function generate(sb: SupabaseClient, id: string, kind: GeneratorKind, key: string, feedback: string | null, fetcher?: typeof fetch) {
  await assertComplete(sb, id, kind);
  const v = await rpc<Generated>(sb, "generator_generate", { p_id: uuid.parse(id), p_key: keySchema.parse(key), p_feedback: feedback?.slice(0, 10000) ?? null });
  return { ...v, slides: await trigger(sb, id, kind, "slides", `slides:${v.version}`, fetcher) };
}

/** « Réessayer » après un échec ou une génération interrompue : même version, mêmes réponses. */
export async function retrySlides(sb: SupabaseClient, kind: GeneratorKind, versionId: string, fetcher?: typeof fetch): Promise<TriggerOutcome> {
  const dossier = await rpc<string>(sb, "generator_retry_slides", { p_version: uuid.parse(versionId) });
  const v = check<{ version: number }>(await sb.from("generator_versions").select("version").eq("id", versionId).single());
  return trigger(sb, dossier, kind, "slides", `slides:${v.version}`, fetcher);
}

export const validateVersion = (sb: SupabaseClient, versionId: string) => rpc<string>(sb, "generator_validate", { p_version: uuid.parse(versionId) });
export const markSent = (sb: SupabaseClient, versionId: string, mailId: string | null) =>
  rpc<string>(sb, "generator_mark_sent", { p_version: uuid.parse(versionId), p_mail: mailId ? uuid.parse(mailId) : null });

// ---------------------------------------------------------------------------
// Connecteur MCP : lectures bornées au dossier, pré-remplissage, dépôt du PDF
// ---------------------------------------------------------------------------

/** Lit une source retenue du dossier. Un fichier est extrait côté serveur, par tranches (offset en caractères). */
export async function readSource(sb: SupabaseClient, id: string, key: string, offset = 0, limit = 200) {
  const cle = z.string().regex(/^[a-z_]{2,20}(:[0-9a-f-]{36})?$/, "Clé de source invalide").parse(key);
  const data = await rpc<Record<string, unknown> | unknown[] | null>(sb, "generator_read", { p_id: uuid.parse(id), p_key: cle, p_offset: offset, p_limit: limit });
  if (data === null) throw new CrmError("Source introuvable sur cette fiche.");
  if (!cle.startsWith("fichier:")) return data;
  const company = await rpc<string>(sb, "generator_company", { p_id: id });
  return readCompanyFile(sb, company, cle.slice(8), offset);
}

/** Réponses proposées par Claude : seules les questions connues sont gardées, et une forme invalide est refusée. */
export async function saveClaudeAnswers(sb: SupabaseClient, id: string, kind: GeneratorKind, answers: { key: string; value: unknown; provenance: string }[]) {
  const kept: { key: string; value: unknown; provenance: string }[] = [];
  const refused: string[] = [];
  for (const a of answers) {
    const q = QUESTIONS[kind].find((x) => x.key === a.key);
    const problem = q ? answerProblem(q, a.value) : "question inconnue";
    if (problem) refused.push(`${a.key} : ${problem}`);
    else kept.push({ key: a.key, value: a.value, provenance: a.provenance.trim().slice(0, 200) || "proposé par Claude" });
  }
  const written = kept.length ? await rpc<number>(sb, "generator_save_answers", { p_id: uuid.parse(id), p_answers: kept, p_origin: "claude" }) : 0;
  return { enregistrees: written, conservees_car_saisies_par_l_utilisateur: kept.length - written, refusees: refused };
}

const pdfFix = (kind: GeneratorKind) => {
  const t = kind === "proposal" ? "proposal" : "onboarding_generator";
  return `Exportez le support en PDF (une slide par page, paysage 16:9), puis refaites le dépôt : start_${t}_version, envoi avec Content-Type: application/pdf, confirm_${t}_version.`;
};

/** Ouvre (ou reprend) le dépôt du PDF de la version en cours et rend une adresse de dépôt à usage unique. */
export async function startVersion(sb: SupabaseClient, id: string, kind: GeneratorKind, size: number, companyName: string) {
  const v = await rpc<{ id: string; version: number; file_id: string | null; company_id: string }>(sb, "generator_version_open", { p_id: uuid.parse(id) });
  const name = `${GENERATOR_NAMES[kind].title} ${companyName} V${v.version}.pdf`;
  const d = await openPdfDeposit(sb, { companyId: v.company_id, name, size, fileId: v.file_id, category: kind === "proposal" ? "Proposition" : "Présentation" });
  if (d.fileId !== v.file_id) await rpc(sb, "generator_version_attach", { p_version: v.id, p_file: d.fileId });
  return { version: v.version, uploadUrl: d.uploadUrl, name };
}

/** La version n'est « à relire » que si le stockage contient bien un PDF lisible. */
export async function confirmVersion(sb: SupabaseClient, id: string, kind: GeneratorKind, version: number) {
  const row = check<{ file_id: string | null } | null>(
    await sb.from("generator_versions").select("file_id").eq("dossier_id", uuid.parse(id)).eq("version", version).eq("slides_status", "uploading").maybeSingle(),
  );
  if (!row?.file_id) throw new CrmError("Aucun dépôt en cours pour cette version.");
  const { size, pdf } = await receivePdf(sb, row.file_id, "Le fichier n'a pas été reçu par le stockage. Refaites le dépôt.", pdfFix(kind), `Le support de ${GENERATOR_NAMES[kind].the}`);
  await rpc(sb, "generator_version_ready", { p_id: id, p_version: version });
  return { version, taille_recue: size, format: pdf.format, ...(pdf.avertissement ? { avertissement: pdf.avertissement } : {}) };
}

export const reportFailure = (sb: SupabaseClient, id: string, message: string) => rpc<null>(sb, "generator_report_failure", { p_id: uuid.parse(id), p_message: message });
