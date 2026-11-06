// Opérations d'administration du module Projets, partagées par l'application (server actions, route des
// fichiers) et le connecteur Claude (MCP) : mêmes validations, mêmes fonctions SQL. Les règles fortes
// (appartenance des contacts, invalidation des sessions, journal) sont appliquées en base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { confirmUpload, fileUrl, updateFile } from "@/lib/crm/files";
import {
  meetingPatchSchema, milestoneSchema, phaseSchema, projectCreateSchema, projectPatchSchema, recapSchema, taskPatchSchema,
  type MilestoneInput, type PhaseInput, type ProjectCreateInput, type ProjectPatch, type RecapInput, type TaskPatch,
} from "./schemas";
import type { AdminTask, RecapAction } from "./types";

export function v<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}
export const idv = (id: string) => v(z.uuid("Identifiant invalide"), id);

export async function rpc<T = unknown>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}
async function ok(res: PromiseLike<{ error: { message: string; code?: string } | null }>) {
  const { error } = await res;
  if (error) throw new CrmError(friendlyError(error));
}
/** Une écriture que les droits en base filtrent ne renvoie pas d'erreur : aucune ligne touchée n'est pas un succès. */
async function changed(res: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>) {
  const { data, error } = await res;
  if (error) throw new CrmError(friendlyError(error));
  if (!Array.isArray(data) || !data.length) throw new CrmError("Rien n'a été modifié : élément introuvable ou action non autorisée.");
}
async function sameIds(res: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>, expected: string[]) {
  const { data, error } = await res;
  if (error) throw new CrmError(friendlyError(error));
  const ids = new Set(((data ?? []) as { id: string }[]).map((r) => r.id));
  if (ids.size !== expected.length || expected.some((id) => !ids.has(id))) throw new CrmError("Le planning n'a pas été enregistré entièrement : rechargez-le pour vérifier son état.");
}

// Projet et contacts ---------------------------------------------------------------------

export async function createProject(sb: SupabaseClient, input: ProjectCreateInput) {
  const { person_ids, ...data } = v(projectCreateSchema, input);
  return { id: await rpc<string>(sb, "project_create", { p_data: data, p_person_ids: person_ids }) };
}

export async function updateProject(sb: SupabaseClient, id: string, patch: ProjectPatch) {
  const p = v(projectPatchSchema, patch) as Record<string, unknown>;
  if (p.status === "archive") p.archived_at = new Date().toISOString();
  else if (p.status) p.archived_at = null;
  await changed(sb.from("projects").update(p).eq("id", idv(id)).select("id"));
}

export const addMember = (sb: SupabaseClient, projectId: string, personId: string) =>
  rpc(sb, "project_add_member", { p_project: idv(projectId), p_person: idv(personId) });

export const removeMember = (sb: SupabaseClient, projectId: string, personId: string) =>
  rpc(sb, "project_remove_member", { p_project: idv(projectId), p_person: idv(personId) });

export const setAccessExpiry = (sb: SupabaseClient, personId: string, expiresAt: string | null) =>
  rpc(sb, "portal_access_set_expiry", { p_person: idv(personId), p_expires_at: expiresAt ? v(z.iso.datetime({ offset: true }), expiresAt) : null });

export const revokeAccess = (sb: SupabaseClient, personId: string) => rpc(sb, "portal_access_revoke", { p_person: idv(personId) });

// Planning ------------------------------------------------------------------------------

/** Enregistre phases et jalons d'un projet (ordre = ordre reçu ; les éléments retirés sont supprimés). */
export async function savePlanning(sb: SupabaseClient, projectId: string, phases: PhaseInput[], milestones: MilestoneInput[]) {
  const pid = idv(projectId);
  const ph = v(z.array(phaseSchema).max(20, "20 phases maximum"), phases);
  const ms = v(z.array(milestoneSchema).max(50, "50 jalons maximum"), milestones);
  const keepPh: string[] = [];
  for (const [i, p] of ph.entries()) {
    const { id, ...data } = p;
    if (id) {
      await changed(sb.from("project_phases").update({ ...data, position: i }).eq("id", id).eq("project_id", pid).select("id"));
      keepPh.push(id);
    } else {
      const { data: row, error } = await sb.from("project_phases").insert({ ...data, position: i, project_id: pid }).select("id").single();
      if (error) throw new CrmError(friendlyError(error));
      keepPh.push((row as { id: string }).id);
    }
  }
  const delPh = sb.from("project_phases").delete().eq("project_id", pid);
  await ok(keepPh.length ? delPh.not("id", "in", `(${keepPh.join(",")})`) : delPh);
  const keepMs: string[] = [];
  for (const m of ms) {
    const { id, done, ...data } = m;
    const row = { ...data, phase_id: data.phase_id && keepPh.includes(data.phase_id) ? data.phase_id : null, done_at: done ? new Date().toISOString() : null };
    if (id) {
      const { data: prev } = await sb.from("project_milestones").select("done_at").eq("id", id).maybeSingle();
      await changed(sb.from("project_milestones").update({ ...row, done_at: done ? ((prev as { done_at: string | null } | null)?.done_at ?? row.done_at) : null }).eq("id", id).eq("project_id", pid).select("id"));
      keepMs.push(id);
    } else {
      const { data: ins, error } = await sb.from("project_milestones").insert({ ...row, project_id: pid }).select("id").single();
      if (error) throw new CrmError(friendlyError(error));
      keepMs.push((ins as { id: string }).id);
    }
  }
  const delMs = sb.from("project_milestones").delete().eq("project_id", pid);
  await ok(keepMs.length ? delMs.not("id", "in", `(${keepMs.join(",")})`) : delMs);
  await sameIds(sb.from("project_phases").select("id").eq("project_id", pid), keepPh);
  await sameIds(sb.from("project_milestones").select("id").eq("project_id", pid), keepMs);
}

// Points de suivi ------------------------------------------------------------------------

export const linkMeeting = (sb: SupabaseClient, projectId: string, bookingId: string, visible: boolean) =>
  rpc<string>(sb, "project_link_meeting", { p_project: idv(projectId), p_booking: idv(bookingId), p_visible: visible });

export const updateMeeting = (sb: SupabaseClient, meetingId: string, patch: z.input<typeof meetingPatchSchema>) =>
  changed(sb.from("project_meetings").update(v(meetingPatchSchema, patch)).eq("id", idv(meetingId)).select("id"));

/** Détache le point du projet : le rendez-vous reste intact ; le récapitulatif éventuel est supprimé. */
export const unlinkMeeting = (sb: SupabaseClient, meetingId: string) => changed(sb.from("project_meetings").delete().eq("id", idv(meetingId)).select("id"));

export const saveRecap = (sb: SupabaseClient, meetingId: string, input: RecapInput) =>
  ok(sb.from("meeting_recaps").upsert({ meeting_id: idv(meetingId), ...v(recapSchema, input) }, { onConflict: "meeting_id" }));

export const publishRecap = (sb: SupabaseClient, meetingId: string, publish: boolean) =>
  rpc(sb, "project_publish_recap", { p_meeting: idv(meetingId), p_publish: publish });

// Tâches ------------------------------------------------------------------------------------

/** Règles d'affectation : une tâche du client est forcément visible ; une tâche à moi n'a pas de contact. */
function normalizeTask(p: Record<string, unknown>) {
  if (p.assignee_kind === "owner") p.assignee_person_id = null;
  if (p.assignee_kind === "client") p.visible_to_client = true;
  return p;
}

export async function createTask(sb: SupabaseClient, projectId: string, input: TaskPatch & { title: string }) {
  const p = normalizeTask({ ...v(taskPatchSchema, input) });
  const { data, error } = await sb.from("project_tasks").insert({ ...p, project_id: idv(projectId) }).select("*").single();
  if (error) throw new CrmError(friendlyError(error));
  return data as AdminTask;
}

export async function updateTask(sb: SupabaseClient, id: string, patch: TaskPatch) {
  const p = v(taskPatchSchema, patch) as Record<string, unknown>;
  if (p.assignee_kind) normalizeTask(p);
  if (p.visible_to_client === false) {
    const { data } = await sb.from("project_tasks").select("assignee_kind").eq("id", idv(id)).single();
    if ((data as { assignee_kind: string } | null)?.assignee_kind === "client" && p.assignee_kind !== "owner") {
      throw new CrmError("Une tâche attribuée au client lui reste visible : attribuez-la à vous-même pour la rendre interne.");
    }
  }
  const { data, error } = await sb.from("project_tasks").update({ ...p, updated_by_kind: "owner", updated_by_person: null }).eq("id", idv(id)).select("*").single();
  if (error) throw new CrmError(friendlyError(error));
  return data as AdminTask;
}

export const deleteTask = (sb: SupabaseClient, id: string) => changed(sb.from("project_tasks").delete().eq("id", idv(id)).select("id"));

export const commentTask = (sb: SupabaseClient, taskId: string, body: string) =>
  ok(sb.from("project_task_comments").insert({ task_id: idv(taskId), author_kind: "owner", body: v(z.string().trim().min(1, "Commentaire vide").max(1000, "1 000 caractères maximum"), body) }));

/** Action d'un récapitulatif → tâche liée au point d'origine ; l'action garde la référence (aucun doublon). */
export async function taskFromRecap(sb: SupabaseClient, meetingId: string, index: number) {
  const { data: m } = await sb.from("project_meetings").select("project_id").eq("id", idv(meetingId)).single();
  const { data: r } = await sb.from("meeting_recaps").select("actions").eq("meeting_id", meetingId).single();
  const actions = ((r as { actions: RecapAction[] } | null)?.actions ?? []).slice();
  const a = actions[index];
  if (!m || !a) throw new CrmError("Action introuvable : enregistrez d'abord le récapitulatif.");
  if (a.task_id) return { task_id: a.task_id, existing: true };
  const { data: t, error } = await sb.from("project_tasks").insert({
    project_id: (m as { project_id: string }).project_id, title: a.text.slice(0, 300), meeting_id: meetingId, assignee_kind: "client", visible_to_client: true,
  }).select("id").single();
  if (error) throw new CrmError(friendlyError(error));
  actions[index] = { ...a, task_id: (t as { id: string }).id };
  await ok(sb.from("meeting_recaps").update({ actions }).eq("meeting_id", meetingId));
  return { task_id: (t as { id: string }).id, existing: false };
}

// Idées --------------------------------------------------------------------------------------

export type IdeaStatus = "a_explorer" | "retenue" | "plus_tard" | "ecartee";

export const decideIdea = (sb: SupabaseClient, id: string, status: IdeaStatus, note: string | null) =>
  changed(sb.from("project_ideas").update({ status, decision_note: v(z.string().trim().max(1000, "1 000 caractères maximum").nullable(), note) || null }).eq("id", idv(id)).select("id"));

export const createIdea = (sb: SupabaseClient, projectId: string, title: string, description: string | null) =>
  ok(sb.from("project_ideas").insert({ project_id: idv(projectId), title: v(z.string().trim().min(1, "Titre obligatoire").max(160), title), description: description?.trim() || null, author_kind: "owner" }));

export const commentIdea = (sb: SupabaseClient, ideaId: string, body: string) =>
  ok(sb.from("project_idea_comments").insert({ idea_id: idv(ideaId), author_kind: "owner", body: v(z.string().trim().min(1).max(1000), body) }));

export const ideaToTask = (sb: SupabaseClient, ideaId: string) => rpc<string>(sb, "project_idea_to_task", { p_idea: idv(ideaId) });

// Fichiers et dossiers ------------------------------------------------------------------------

async function fileIdOf(sb: SupabaseClient, projectFileId: string) {
  const { data, error } = await sb.from("project_files").select("file_id").eq("id", idv(projectFileId)).single();
  if (error) throw new CrmError(friendlyError(error));
  return (data as { file_id: string }).file_id;
}

/** Le transfert est terminé : la pièce devient prête et rejoint le projet. */
export async function attachUpload(sb: SupabaseClient, projectId: string, fileId: string, folderId: string | null) {
  await confirmUpload(sb, fileId);
  await ok(sb.from("project_files").insert({ project_id: projectId, file_id: fileId, folder_id: folderId }));
}

export const shareFiles = (sb: SupabaseClient, projectId: string, fileIds: string[], folderId: string | null) =>
  ok(sb.from("project_files").insert(fileIds.map((f) => ({ project_id: projectId, file_id: f, folder_id: folderId }))));

/** Retrait du projet uniquement : le document reste dans la fiche CRM. */
export const unshareFile = (sb: SupabaseClient, projectFileId: string) => changed(sb.from("project_files").delete().eq("id", idv(projectFileId)).select("id"));

export const renameProjectFile = async (sb: SupabaseClient, projectFileId: string, name: string) =>
  updateFile(sb, await fileIdOf(sb, projectFileId), { display_name: name });

export const projectFileUrl = async (sb: SupabaseClient, projectFileId: string, download: boolean) => fileUrl(sb, await fileIdOf(sb, projectFileId), download);

/** La base refuse (et signale par `confirm`) un déplacement qui rendrait visible un document interne. */
export const moveFiles = (sb: SupabaseClient, projectId: string, ids: string[], folderId: string | null, confirm: boolean) =>
  rpc<{ moved?: number; confirm?: number }>(sb, "project_files_move", { p_project: projectId, p_ids: ids, p_folder: folderId, p_confirm: confirm });

export type FolderInput = { id: string | null; name: string; parent: string | null; visible: boolean; upload: boolean; confirm: boolean };
export const saveFolder = (sb: SupabaseClient, projectId: string, f: FolderInput) =>
  rpc<{ id?: string; confirm?: number }>(sb, "project_folder_save", {
    p_project: projectId, p_folder: f.id, p_name: f.name, p_parent: f.parent, p_visible: f.visible, p_upload: f.upload, p_confirm: f.confirm,
  });

/** Les fichiers sont d'abord déplacés vers la destination choisie (racine ou autre dossier), rien n'est supprimé. */
export const deleteFolder = (sb: SupabaseClient, folderId: string, targetId: string | null, confirm: boolean) =>
  rpc<{ deleted?: boolean; moved?: number; confirm?: number }>(sb, "project_folder_delete", { p_folder: folderId, p_target: targetId, p_confirm: confirm });
