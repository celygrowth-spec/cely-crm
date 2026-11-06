// Dossier de diagnostic et bibliothèque. Utilisé par les routes de l'application et par le connecteur MCP :
// les droits (lecture Claude bornée à la fiche du dossier, écritures réservées) sont appliqués en base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "./service";
import { confirmUpload, startUpload, type CompanyFile } from "./files";
import { LIBRARY_BUCKET, LIBRARY_CATEGORIES, MAX_LIBRARY_BYTES, PPTX_TYPE, libraryType, type Diagnostic, type LibraryFile } from "./diagnostic-rules";

const uuid = z.uuid("Identifiant invalide");
const COMPANY_BUCKET = "company-files";
const LIBRARY_COLUMNS = "id, category, display_name, mime_type, size_bytes, created_at";
const COLUMNS = "id, company_id, status, chat_url, summary, sources, answers_sent_at, last_error, created_at";
const CHILDREN = "questions:diagnostic_questions(id, position, question, why, answer, dont_know), versions:diagnostic_versions(id, version, file_id, status, created_at, ready_at)";

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}

const rpc = async <T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>) => check<T>(await sb.rpc(fn, args));

function ordered(d: Diagnostic): Diagnostic {
  return { ...d, questions: [...d.questions].sort((a, b) => a.position - b.position), versions: [...d.versions].sort((a, b) => b.version - a.version) };
}

// ---------------------------------------------------------------------------
// Bibliothèque
// ---------------------------------------------------------------------------

export async function getLibrary(sb: SupabaseClient): Promise<{ instructions: string; files: LibraryFile[] }> {
  const [settings, files] = await Promise.all([
    sb.from("diagnostic_settings").select("instructions").maybeSingle(),
    sb.from("diagnostic_library_files").select(LIBRARY_COLUMNS).eq("status", "ready").order("category").order("display_name"),
  ]);
  return { instructions: check<{ instructions: string } | null>(settings)?.instructions ?? "", files: check<LibraryFile[]>(files) };
}

export const setInstructions = (sb: SupabaseClient, text: string) =>
  rpc<null>(sb, "diagnostic_set_instructions", { p_text: z.string().trim().min(1, "Le prompt ne peut pas être vide.").max(100000, "Prompt trop long.").parse(text) });

export async function startLibraryUpload(sb: SupabaseClient, input: { name: string; size: number; category: string }) {
  const type = libraryType(input.name);
  if (!type) throw new CrmError("Format non autorisé.");
  if (input.size <= 0) throw new CrmError("Ce fichier est vide.");
  if (input.size > MAX_LIBRARY_BYTES) throw new CrmError("Fichier trop volumineux (25 Mo maximum).");
  const id = crypto.randomUUID();
  const path = `${id}.${input.name.split(".").pop()!.toLowerCase()}`;
  const category = input.category in LIBRARY_CATEGORIES ? input.category : "other";
  check(await sb.from("diagnostic_library_files").insert({ id, category, display_name: input.name.slice(0, 200), mime_type: type, size_bytes: input.size, storage_path: path }));
  const { data, error } = await sb.storage.from(LIBRARY_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    await sb.from("diagnostic_library_files").delete().eq("id", id);
    throw new CrmError(`Préparation de l'envoi impossible : ${error?.message ?? "réponse vide"}`);
  }
  return { id, signedUrl: data.signedUrl, type };
}

async function libraryPath(sb: SupabaseClient, id: string) {
  const row = check<{ storage_path: string } | null>(await sb.from("diagnostic_library_files").select("storage_path").eq("id", uuid.parse(id)).maybeSingle());
  if (!row) throw new CrmError("Fichier introuvable.");
  return row.storage_path;
}

export async function confirmLibraryUpload(sb: SupabaseClient, id: string): Promise<LibraryFile> {
  const path = await libraryPath(sb, id);
  const probe = await sb.storage.from(LIBRARY_BUCKET).createSignedUrl(path, 10);
  if (probe.error) throw new CrmError("Le fichier n'a pas été reçu par le stockage.");
  return check<LibraryFile>(await sb.from("diagnostic_library_files").update({ status: "ready" }).eq("id", id).select(LIBRARY_COLUMNS).single());
}

/** Retire l'objet puis la ligne : sert aussi à abandonner un envoi. */
export async function deleteLibraryFile(sb: SupabaseClient, id: string) {
  const path = await libraryPath(sb, id);
  const { error } = await sb.storage.from(LIBRARY_BUCKET).remove([path]);
  if (error) throw new CrmError(`Le fichier n'a pas pu être retiré du stockage : ${error.message}. Réessayez.`);
  check(await sb.from("diagnostic_library_files").delete().eq("id", id));
}

export async function libraryFileUrl(sb: SupabaseClient, id: string, download = false) {
  const row = check<{ storage_path: string; display_name: string } | null>(
    await sb.from("diagnostic_library_files").select("storage_path, display_name").eq("id", uuid.parse(id)).eq("status", "ready").maybeSingle(),
  );
  if (!row) throw new CrmError("Fichier introuvable.");
  const { data, error } = await sb.storage.from(LIBRARY_BUCKET).createSignedUrl(row.storage_path, 300, download ? { download: row.display_name } : undefined);
  if (error || !data) throw new CrmError("Lien temporaire impossible à créer.");
  return data.signedUrl;
}

// ---------------------------------------------------------------------------
// Dossiers : actions de l'application
// ---------------------------------------------------------------------------

export async function listDiagnostics(sb: SupabaseClient, companyId: string): Promise<Diagnostic[]> {
  const rows = check<Diagnostic[]>(await sb.from("diagnostics").select(`${COLUMNS}, ${CHILDREN}`).eq("company_id", uuid.parse(companyId)).order("created_at", { ascending: false }));
  return rows.map(ordered);
}

export const startDiagnostic = (sb: SupabaseClient, companyId: string, key: string) =>
  rpc<string>(sb, "diagnostic_start", { p_company: uuid.parse(companyId), p_key: z.string().min(8).max(100).parse(key) });

export const setChatUrl = (sb: SupabaseClient, id: string, url: string) => {
  const value = url.trim();
  if (value && !/^https:\/\/claude\.ai\//.test(value)) throw new CrmError("Collez l'adresse du chat, qui commence par https://claude.ai/.");
  return rpc<null>(sb, "diagnostic_set_chat", { p_id: uuid.parse(id), p_url: value.split(/[?#]/)[0] });
};

export const saveAnswer = (sb: SupabaseClient, questionId: string, answer: string, dontKnow: boolean) =>
  rpc<null>(sb, "diagnostic_save_answer", { p_question: uuid.parse(questionId), p_answer: z.string().max(20000, "Réponse trop longue.").parse(answer), p_dont_know: dontKnow });

export const submitAnswers = (sb: SupabaseClient, id: string) => rpc<string>(sb, "diagnostic_submit_answers", { p_id: uuid.parse(id) });

// ---------------------------------------------------------------------------
// Dossiers : connecteur MCP
// ---------------------------------------------------------------------------

export async function openDiagnostic(sb: SupabaseClient, id: string) {
  await rpc(sb, "diagnostic_open", { p_id: uuid.parse(id) });
  const row = check<Diagnostic | null>(await sb.from("diagnostics").select(`${COLUMNS}, ${CHILDREN}`).eq("id", id).maybeSingle());
  if (!row) throw new CrmError("Dossier introuvable.");
  const library = await getLibrary(sb);
  return { dossier: ordered(row), ...library };
}

export const companyOf = (sb: SupabaseClient, id: string) => rpc<string>(sb, "diagnostic_company", { p_id: uuid.parse(id) });

export async function listHistory(sb: SupabaseClient, id: string, before: string | undefined, limit: number) {
  const company = await companyOf(sb, id);
  let q = sb.from("interactions").select("id, occurred_at, kind, channel, content, source").eq("company_id", company);
  if (before) q = q.lt("occurred_at", before);
  return check<{ occurred_at: string }[]>(await q.order("occurred_at", { ascending: false }).limit(limit));
}

export async function listAppointments(sb: SupabaseClient, id: string) {
  const company = await companyOf(sb, id);
  return check<unknown[]>(
    await sb.from("appt_bookings").select("id, status, outcome, starts_at, ends_at, first_name, last_name, email, answers, internal_note").eq("company_id", company).order("starts_at", { ascending: false }).limit(100),
  );
}

export const listEmails = (sb: SupabaseClient, id: string, before: string | undefined, limit: number) =>
  rpc<unknown[]>(sb, "diagnostic_mail_list", { p_id: uuid.parse(id), p_before: before ?? null, p_limit: limit });
export const emailThread = (sb: SupabaseClient, id: string, mailId: string, offset: number, limit: number) =>
  rpc<{ corps: string }[]>(sb, "diagnostic_mail_thread", { p_id: uuid.parse(id), p_mail: uuid.parse(mailId), p_offset: offset, p_limit: limit });
export const listCalls = (sb: SupabaseClient, id: string, before: string | undefined, limit: number) =>
  rpc<unknown[]>(sb, "fireflies_diagnostic_calls", { p_id: uuid.parse(id), p_before: before ?? null, p_limit: limit });
export const callTranscript = (sb: SupabaseClient, id: string, callId: string, offset: number, limit: number) =>
  rpc<{ total: number; lignes: unknown[] }>(sb, "fireflies_diagnostic_transcript", { p_id: uuid.parse(id), p_call: uuid.parse(callId), p_offset: offset, p_limit: limit });

/** Fichiers prêts de la fiche du dossier. Sans passer par listFiles : le connecteur ne nettoie rien. */
export async function listDossierFiles(sb: SupabaseClient, id: string) {
  const company = await companyOf(sb, id);
  return check<Pick<CompanyFile, "id" | "display_name" | "category" | "mime_type" | "size_bytes" | "created_at">[]>(
    await sb.from("company_files").select("id, display_name, category, mime_type, size_bytes, created_at").eq("company_id", company).eq("status", "ready").order("created_at", { ascending: false }),
  );
}

export async function dossierFileUrl(sb: SupabaseClient, id: string, fileId: string) {
  const company = await companyOf(sb, id);
  const row = check<{ storage_path: string } | null>(
    await sb.from("company_files").select("storage_path").eq("id", uuid.parse(fileId)).eq("company_id", company).eq("status", "ready").maybeSingle(),
  );
  if (!row) throw new CrmError("Fichier introuvable sur cette fiche.");
  const { data, error } = await sb.storage.from(COMPANY_BUCKET).createSignedUrl(row.storage_path, 300);
  if (error || !data) throw new CrmError("Lien temporaire impossible à créer.");
  return data.signedUrl;
}

export const saveResearch = (sb: SupabaseClient, id: string, summary: string, sources: unknown[]) =>
  rpc<null>(sb, "diagnostic_save_research", { p_id: uuid.parse(id), p_summary: summary, p_sources: sources });

export const saveQuestions = (sb: SupabaseClient, id: string, questions: { question: string; why?: string }[]) =>
  rpc<number>(sb, "diagnostic_save_questions", { p_id: uuid.parse(id), p_questions: questions });

type OpenVersion = { id: string; version: number; file_id: string | null; company_id: string };

/** Ouvre la version suivante, ou reprend le dépôt en cours, et renvoie une adresse de dépôt à usage unique. */
export async function startVersion(sb: SupabaseClient, id: string, size: number, companyName: string) {
  const v = await rpc<OpenVersion>(sb, "diagnostic_version_open", { p_id: uuid.parse(id) });
  const name = `Diagnostic ${companyName} V${v.version}.pptx`;
  if (!v.file_id) {
    const file = await startUpload(sb, { companyId: v.company_id, name, type: PPTX_TYPE, size, category: "Présentation" });
    await rpc(sb, "diagnostic_version_attach", { p_version: v.id, p_file: file.id });
    return { version: v.version, uploadUrl: file.signedUrl, name };
  }
  const row = check<{ storage_path: string }>(await sb.from("company_files").select("storage_path").eq("id", v.file_id).single());
  const { data, error } = await sb.storage.from(COMPANY_BUCKET).createSignedUploadUrl(row.storage_path, { upsert: true });
  if (error || !data) throw new CrmError(`Préparation de l'envoi impossible : ${error?.message ?? "réponse vide"}`);
  return { version: v.version, uploadUrl: data.signedUrl, name };
}

/** La version n'est « reçue » que si le stockage contient bien l'objet : sa taille réelle remplace la taille annoncée. */
export async function confirmVersion(sb: SupabaseClient, id: string, version: number) {
  const row = check<{ file_id: string | null } | null>(
    await sb.from("diagnostic_versions").select("file_id").eq("diagnostic_id", uuid.parse(id)).eq("version", version).eq("status", "uploading").maybeSingle(),
  );
  if (!row?.file_id) throw new CrmError("Aucun dépôt en cours pour cette version.");
  const file = check<{ storage_path: string }>(await sb.from("company_files").select("storage_path").eq("id", row.file_id).single());
  const [folder, object] = file.storage_path.split("/");
  const { data, error } = await sb.storage.from(COMPANY_BUCKET).list(folder, { search: object, limit: 1 });
  const size = (data?.[0]?.metadata as { size?: number } | undefined)?.size;
  if (error || !size) throw new CrmError("Le fichier n'a pas été reçu par le stockage. Refaites le dépôt avec start_diagnostic_version.");
  await confirmUpload(sb, row.file_id);
  check(await sb.from("company_files").update({ size_bytes: size }).eq("id", row.file_id));
  await rpc(sb, "diagnostic_version_ready", { p_id: id, p_version: version });
  return { version, taille_recue: size };
}

export const reportFailure = (sb: SupabaseClient, id: string, message: string) =>
  rpc<null>(sb, "diagnostic_report_failure", { p_id: uuid.parse(id), p_message: message });
