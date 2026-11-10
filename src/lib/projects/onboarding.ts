import "server-only";
// Projet préparé après « Gagné » : partagé par les routes de l'application et le connecteur Claude.
// Les règles (une vente = un projet, corrections conservées, rien de visible du client sans action
// explicite) sont appliquées en base (migration 20261112000100_projet_onboarding.sql).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { confirmUpload, fileUrl, startUpload } from "@/lib/crm/files";
import { PPTX_TYPE } from "@/lib/crm/diagnostic-rules";
import { fireRoutine, routineConfig } from "@/lib/crm/diagnostic-trigger";
import { idv, moveFiles, rpc, v } from "./service";
import { SECTION_KEYS, routineText, type Onboarding, type OnboardingDeck, type OnboardingItem, type Section, type SectionKey } from "./onboarding-rules";

const COMPANY_BUCKET = "company-files";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}

// Gagné ---------------------------------------------------------------------------------------

export type WinResult = { closing_id: string; project_id: string; created: boolean };

/** Enregistre la vente et crée (ou retrouve) son projet. La préparation est lancée ensuite, à part. */
export const winDeal = (sb: SupabaseClient, companyId: string) => rpc<WinResult>(sb, "project_win_deal", { p_company: idv(companyId) });

/** Vente active d'une fiche et son projet, pour le bouton « Ouvrir le projet ». */
export async function activeClosing(sb: SupabaseClient, companyId: string) {
  const c = check(await sb.from("deal_closings").select("id").eq("company_id", idv(companyId)).is("reopened_at", null).maybeSingle()) as { id: string } | null;
  if (!c) return null;
  const s = check(await sb.from("project_onboarding_status").select("project_id, status").eq("closing_id", c.id).maybeSingle()) as { project_id: string; status: string } | null;
  return s ? { closing_id: c.id, project_id: s.project_id, status: s.status } : { closing_id: c.id, project_id: null, status: null };
}

// Préparation ---------------------------------------------------------------------------------

/** Préparation depuis les sources du CRM ; un échec est enregistré et relançable, la vente et le projet restent. */
export async function prepare(sb: SupabaseClient, projectId: string) {
  const id = idv(projectId);
  const { data, error } = await sb.rpc("onboarding_prepare", { p_project: id });
  if (!error) return data as { status: string };
  const message = friendlyError(error);
  await sb.rpc("onboarding_prep_failed", { p_project: id, p_message: message });
  throw new CrmError(`Préparation interrompue : ${message} Le projet est bien enregistré ; relancez la préparation.`);
}

/** Analyse des sources par Claude (tâche automatique si elle est configurée). */
export async function requestAnalysis(sb: SupabaseClient, projectId: string, fetcher?: typeof fetch): Promise<{ triggered: boolean; error?: string }> {
  const id = idv(projectId);
  const cfg = routineConfig("ONBOARDING");
  if (!cfg) return { triggered: false };
  if (!(await rpc<boolean>(sb, "onboarding_analysis_claim", { p_project: id }))) return { triggered: false };
  try {
    const url = await fireRoutine(routineText(id, "analyse"), fetcher, cfg);
    await rpc(sb, "onboarding_analysis_result", { p_project: id, p_session_url: url, p_error: null });
    return { triggered: true };
  } catch (e) {
    const message = e instanceof CrmError ? e.message : "Lancement impossible.";
    await rpc(sb, "onboarding_analysis_result", { p_project: id, p_session_url: null, p_error: message });
    return { triggered: false, error: message };
  }
}

export async function getOnboarding(sb: SupabaseClient, projectId: string): Promise<Onboarding | null> {
  const id = idv(projectId);
  const st = check(await sb.from("project_onboarding_status").select("*").eq("project_id", id).maybeSingle()) as
    Pick<Onboarding, "project_id" | "closing_id" | "company_id" | "won_at" | "status" | "open_required" | "open_optional" | "prep_state" | "prep_error" | "analysis_state" | "analysis_error"> | null;
  if (!st) return null;
  const [o, items, decks, project, docs, people, members] = await Promise.all([
    sb.from("project_onboarding").select("sections, proposal_file_id, diagnostic_id, analysis_requested_at, analysis_session_url").eq("project_id", id).single(),
    sb.from("project_onboarding_items").select("*").eq("project_id", id).order("required", { ascending: false }).order("priority").order("created_at"),
    sb.from("project_onboarding_decks").select("id, version, status, file_id, error, session_url, requested_at, ready_at, shared_at").eq("project_id", id).order("version", { ascending: false }),
    sb.from("projects").select("start_date, portal_published").eq("id", id).single(),
    sb.from("company_files").select("id, display_name, category, created_at").eq("company_id", st.company_id).eq("status", "ready").order("created_at", { ascending: false }).limit(100),
    sb.from("people").select("id, first_name, last_name, title, email, phone, is_primary").eq("company_id", st.company_id).order("is_primary", { ascending: false }).order("created_at"),
    sb.from("project_members").select("person_id").eq("project_id", id),
  ]);
  const ob = check(o) as { sections: Onboarding["sections"]; proposal_file_id: string | null; diagnostic_id: string | null; analysis_requested_at: string | null; analysis_session_url: string | null };
  const pr = check(project) as { start_date: string | null; portal_published: boolean };
  const ppl = (check(people) as { id: string; first_name: string | null; last_name: string | null; title: string | null; email: string | null; phone: string | null; is_primary: boolean }[])
    .map((p) => ({ id: p.id, name: [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email || "Contact", title: p.title, email: p.email, phone: p.phone, is_primary: p.is_primary }));
  const memberIds = new Set((check(members) as { person_id: string }[]).map((m) => m.person_id));
  return {
    ...st,
    ...ob,
    analysis_auto: !!routineConfig("ONBOARDING"),
    deck_auto: !!routineConfig("ONBOARDING"),
    items: check(items) as OnboardingItem[],
    decks: check(decks) as OnboardingDeck[],
    documents: check(docs) as Onboarding["documents"],
    contacts: ppl,
    members: ppl.filter((p) => memberIds.has(p.id)).map((p) => ({ id: p.id, name: p.name })),
    start_date: pr.start_date,
    portal_published: pr.portal_published,
  };
}

// Mes réponses --------------------------------------------------------------------------------

const refSchema = z.object({
  kind: z.enum(["file", "call", "diagnostic", "company", "answer"]),
  id: z.uuid().nullish(),
  label: z.string().max(200).optional(),
  excerpt: z.string().max(500).optional(),
  at: z.number().min(0).optional(),
});
export const sectionItemSchema = z.object({
  text: z.string().trim().min(1, "Élément vide").max(1000, "1 000 caractères maximum par élément"),
  refs: z.array(refSchema).max(5).optional(),
  suggested: z.boolean().optional(),
  provisional: z.boolean().optional(),
  date: z.iso.date().nullish(),
  date_status: z.enum(["confirmed", "provisional", "unknown"]).optional(),
});
const sectionKey = z.enum(SECTION_KEYS);

export const saveSection = (sb: SupabaseClient, projectId: string, key: SectionKey, items: z.input<typeof sectionItemSchema>[]) =>
  rpc(sb, "onboarding_save_section", { p_project: idv(projectId), p_key: v(sectionKey, key), p_items: v(z.array(sectionItemSchema).max(30, "30 éléments maximum"), items) });

export type AnswerAction = "text" | "date" | "file" | "choice" | "not_applicable" | "reopen";
export const answerItem = (sb: SupabaseClient, itemId: string, action: AnswerAction, value: string | null, fileId: string | null) =>
  rpc(sb, "onboarding_answer", {
    p_item: idv(itemId),
    p_action: v(z.enum(["text", "date", "file", "choice", "not_applicable", "reopen"]), action),
    p_value: value,
    p_file: fileId ? idv(fileId) : null,
  });

export const shareRequest = (sb: SupabaseClient, itemId: string, text: string, personId: string | null) =>
  rpc<{ task_id: string }>(sb, "onboarding_share_request", { p_item: idv(itemId), p_text: text, p_person: personId ? idv(personId) : null });

/** Document importé depuis le bloc : il devient la réponse du point (la pièce reste dans la fiche et le projet, en interne). */
export async function attachAnswerFile(sb: SupabaseClient, projectId: string, itemId: string, fileId: string) {
  await confirmUpload(sb, idv(fileId));
  const folder = await internalFolder(sb, projectId);
  check(await sb.from("project_files").upsert({ project_id: idv(projectId), file_id: fileId, folder_id: folder }, { onConflict: "project_id,file_id", ignoreDuplicates: true }));
  return answerItem(sb, itemId, "file", null, fileId);
}

async function internalFolder(sb: SupabaseClient, projectId: string) {
  const found = check(await sb.from("project_folders").select("id").eq("project_id", projectId).is("parent_id", null).eq("name", "Onboarding (interne)").eq("visible_to_client", false).maybeSingle()) as { id: string } | null;
  if (found) return found.id;
  const r = await rpc<{ id?: string }>(sb, "project_folder_save", { p_project: projectId, p_folder: null, p_name: "Onboarding (interne)", p_parent: null, p_visible: false, p_upload: false, p_confirm: false });
  if (!r.id) throw new CrmError("Dossier interne impossible à créer.");
  return r.id;
}

export async function documentUrl(sb: SupabaseClient, projectId: string, fileId: string) {
  const o = await getStatusRow(sb, projectId);
  const f = check(await sb.from("company_files").select("id").eq("id", idv(fileId)).eq("company_id", o.company_id).eq("status", "ready").maybeSingle());
  if (!f) throw new CrmError("Document introuvable sur cette fiche.");
  return fileUrl(sb, fileId, false);
}

async function getStatusRow(sb: SupabaseClient, projectId: string) {
  const o = check(await sb.from("project_onboarding_status").select("company_id, status").eq("project_id", idv(projectId)).maybeSingle()) as { company_id: string; status: string } | null;
  if (!o) throw new CrmError("Ce projet n'a pas de préparation.");
  return o;
}

// Slides d'onboarding -------------------------------------------------------------------------

/** Demande la version suivante ; Claude la génère (tâche automatique, sinon lien vers Claude). */
export async function requestDeck(sb: SupabaseClient, projectId: string, fetcher?: typeof fetch) {
  const id = idv(projectId);
  const d = await rpc<{ id: string; version: number; existing: boolean }>(sb, "onboarding_deck_request", { p_project: id });
  const cfg = routineConfig("ONBOARDING");
  if (!cfg || d.existing) return { ...d, triggered: false };
  try {
    const url = await fireRoutine(routineText(id, "slides"), fetcher, cfg);
    await rpc(sb, "onboarding_deck_session", { p_deck: d.id, p_session_url: url, p_error: null });
    return { ...d, triggered: true };
  } catch (e) {
    const message = e instanceof CrmError ? e.message : "Lancement impossible.";
    await rpc(sb, "onboarding_deck_session", { p_deck: d.id, p_session_url: null, p_error: message });
    return { ...d, triggered: false, error: message };
  }
}

/**
 * Partage explicite d'une version : elle passe à la racine du projet (visible du client une fois le projet
 * publié) ; les autres versions retournent dans le dossier interne. Rien n'est partagé sans ce clic.
 */
export async function shareDeck(sb: SupabaseClient, projectId: string, deckId: string, share: boolean) {
  const pid = idv(projectId);
  const decks = check(await sb.from("project_onboarding_decks").select("id, file_id, status").eq("project_id", pid)) as { id: string; file_id: string | null; status: string }[];
  const target = decks.find((d) => d.id === idv(deckId));
  if (!target?.file_id || target.status !== "ready") throw new CrmError("Cette version n'est pas prête.");
  const files = check(await sb.from("project_files").select("id, file_id").eq("project_id", pid).in("file_id", decks.map((d) => d.file_id).filter((x): x is string => !!x))) as { id: string; file_id: string }[];
  const folder = await internalFolder(sb, pid);
  const others = files.filter((f) => f.file_id !== target.file_id).map((f) => f.id);
  if (others.length) await moveFiles(sb, pid, others, folder, false);
  const mine = files.find((f) => f.file_id === target.file_id);
  if (!mine) throw new CrmError("Le fichier de cette version n'est plus dans le projet.");
  const r = await moveFiles(sb, pid, [mine.id], share ? null : folder, share);
  if (r.confirm) throw new CrmError("Partage non confirmé : rien n'a été partagé.");
  check(await sb.from("project_onboarding_decks").update({ shared_at: null }).eq("project_id", pid).neq("id", target.id));
  check(await sb.from("project_onboarding_decks").update({ shared_at: share ? new Date().toISOString() : null }).eq("id", target.id));
}

// Claude (connecteur) ------------------------------------------------------------------------

export async function openForClaude(sb: SupabaseClient, projectId: string) {
  const o = await getOnboarding(sb, projectId);
  if (!o) throw new CrmError("Ce projet n'a pas de préparation (il n'a pas été créé depuis une vente).");
  const sources = await rpc<Record<string, unknown>>(sb, "onboarding_sources", { p_project: o.project_id });
  const library = check(await sb.from("diagnostic_library_files").select("id, display_name, category").eq("status", "ready").in("category", ["brand", "example"])) as unknown[];
  return {
    projet: { id: o.project_id, etat: o.status, date_de_demarrage: o.start_date, publie_sur_le_portail: o.portal_published },
    proposition_retenue: o.documents.find((d) => d.id === o.proposal_file_id) ?? null,
    documents_de_la_fiche: o.documents,
    sections: o.sections,
    points: o.items.filter((i) => i.status !== "resolved").map((i) => ({ key: i.key, label: i.label, statut: i.status, obligatoire: i.required, reponse: i.answer, repondu_par: i.answered_by })),
    slides: o.decks.map((d) => ({ version: d.version, statut: d.status })),
    bibliotheque_modele_cely: library,
    ...sources,
  };
}

export const callTranscript = (sb: SupabaseClient, projectId: string, callId: string, offset: number, limit: number) =>
  rpc<{ total: number; lignes: unknown[] }>(sb, "onboarding_call_transcript", { p_project: idv(projectId), p_call: idv(callId), p_offset: offset, p_limit: limit });

export async function claudeDocumentUrl(sb: SupabaseClient, projectId: string, fileId: string) {
  const o = await getStatusRow(sb, projectId);
  const row = check(await sb.from("company_files").select("storage_path").eq("id", idv(fileId)).eq("company_id", o.company_id).eq("status", "ready").maybeSingle()) as { storage_path: string } | null;
  if (!row) throw new CrmError("Document introuvable sur la fiche de ce projet.");
  const { data, error } = await sb.storage.from(COMPANY_BUCKET).createSignedUrl(row.storage_path, 300);
  if (error || !data) throw new CrmError("Lien temporaire impossible à créer.");
  return data.signedUrl;
}

export const analysisItemSchema = z.object({
  key: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(300),
  detail: z.string().max(2000).optional(),
  kind: z.enum(["text", "choice", "conflict", "client_request", "date"]).default("text"),
  required: z.boolean().default(false),
  priority: z.number().int().min(1).max(100).optional(),
  target_section: sectionKey.optional(),
  options: z.array(z.object({ label: z.string().trim().min(1).max(200), text: z.string().max(1000).optional(), refs: z.array(refSchema).max(5).optional() })).max(6).optional(),
  refs: z.array(refSchema).max(5).optional(),
});

export const saveAnalysis = (sb: SupabaseClient, projectId: string, sections: Partial<Record<SectionKey, z.input<typeof sectionItemSchema>[]>>, items: z.input<typeof analysisItemSchema>[], startDate: string | null) =>
  rpc<{ status: string; sections_enregistrees: string[]; sections_conservees_car_corrigees: string[] }>(sb, "onboarding_save_analysis", {
    p_project: idv(projectId),
    p_sections: v(z.partialRecord(sectionKey, z.array(sectionItemSchema).max(30)), sections),
    p_items: v(z.array(analysisItemSchema).max(20), items),
    p_start_date: startDate ? v(z.iso.date(), startDate) : null,
  });

export const reportAnalysisFailure = (sb: SupabaseClient, projectId: string, message: string) =>
  rpc(sb, "onboarding_analysis_result", { p_project: idv(projectId), p_session_url: null, p_error: message.slice(0, 2000) || "Analyse impossible." });

export async function startDeckUpload(sb: SupabaseClient, projectId: string, size: number, companyName: string) {
  const d = await rpc<{ id: string; version: number; file_id: string | null; company_id: string }>(sb, "onboarding_deck_open", { p_project: idv(projectId) });
  const name = `Onboarding ${companyName} V${d.version}.pptx`;
  if (!d.file_id) {
    const file = await startUpload(sb, { companyId: d.company_id, name, type: PPTX_TYPE, size, category: "Présentation" });
    await rpc(sb, "onboarding_deck_attach", { p_deck: d.id, p_file: file.id });
    return { version: d.version, uploadUrl: file.signedUrl, name };
  }
  const row = check(await sb.from("company_files").select("storage_path").eq("id", d.file_id).single()) as { storage_path: string };
  const { data, error } = await sb.storage.from(COMPANY_BUCKET).createSignedUploadUrl(row.storage_path, { upsert: true });
  if (error || !data) throw new CrmError(`Préparation de l'envoi impossible : ${error?.message ?? "réponse vide"}`);
  return { version: d.version, uploadUrl: data.signedUrl, name };
}

/** La version n'est « prête » que si le stockage contient bien le fichier. */
export async function confirmDeckUpload(sb: SupabaseClient, projectId: string, version: number) {
  const pid = idv(projectId);
  const d = check(await sb.from("project_onboarding_decks").select("file_id").eq("project_id", pid).eq("version", version).eq("status", "uploading").maybeSingle()) as { file_id: string | null } | null;
  if (!d?.file_id) throw new CrmError("Aucun dépôt en cours pour cette version.");
  const file = check(await sb.from("company_files").select("storage_path").eq("id", d.file_id).single()) as { storage_path: string };
  const [folder, object] = file.storage_path.split("/");
  const { data, error } = await sb.storage.from(COMPANY_BUCKET).list(folder, { search: object, limit: 1 });
  const size = (data?.[0]?.metadata as { size?: number } | undefined)?.size;
  if (error || !size) throw new CrmError("Le fichier n'a pas été reçu par le stockage. Refaites le dépôt avec start_onboarding_deck_upload.");
  await confirmUpload(sb, d.file_id);
  check(await sb.from("company_files").update({ size_bytes: size }).eq("id", d.file_id));
  await rpc(sb, "onboarding_deck_ready", { p_project: pid, p_version: version });
  return { version, taille_recue: size };
}

export const reportDeckFailure = (sb: SupabaseClient, projectId: string, message: string) =>
  rpc(sb, "onboarding_deck_failed", { p_project: idv(projectId), p_message: message });

export type { Section };
