"use server";

// Server actions du module Projets (administration). Les règles fortes (appartenance des contacts,
// invalidation des sessions, journal) sont appliquées en base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { headers } from "next/headers";
import { z } from "zod";
import { run } from "@/lib/action";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { appUrl } from "@/lib/appointments/config";
import { codeHash, generateCode } from "@/lib/projects/portal-auth";
import { companyPeople } from "@/lib/projects/owner";
import {
  meetingCreateSchema, meetingPatchSchema, milestoneSchema, phaseSchema, projectCreateSchema, projectPatchSchema, recapSchema,
  taskPatchSchema, type MeetingCreateInput, type MilestoneInput, type PhaseInput, type ProjectCreateInput, type ProjectPatch, type RecapInput, type TaskPatch,
} from "@/lib/projects/schemas";
import type { AdminTask, RecapAction } from "@/lib/projects/types";
import { BookingError, cancelBooking, ownerCreateBooking, reconcileCalendar, rescheduleBooking } from "@/lib/appointments/server";
import { syncGoogleChanges } from "@/lib/appointments/google-sync";

function v<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}
const idv = (id: string) => v(z.uuid("Identifiant invalide"), id);
async function rpc<T = unknown>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}
/** Erreurs de l'orchestration Rendez-vous → message lisible, jamais présentées comme un succès. */
async function orchestrate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof BookingError) throw new CrmError(e.message);
    throw e;
  }
}
async function origin() {
  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host?.startsWith("localhost") ? "http" : "https");
  return appUrl(host ? `${proto}://${host}` : null);
}

export async function createProjectAction(input: ProjectCreateInput) {
  return run(async (sb) => {
    const d = v(projectCreateSchema, input);
    const { person_ids, ...data } = d;
    return { id: await rpc<string>(sb, "project_create", { p_data: data, p_person_ids: person_ids }) };
  });
}

export async function updateProjectAction(id: string, patch: ProjectPatch) {
  return run(async (sb) => {
    const p = v(projectPatchSchema, patch) as Record<string, unknown>;
    if (p.status === "archive") p.archived_at = new Date().toISOString();
    else if (p.status) p.archived_at = null;
    const { error } = await sb.from("projects").update(p).eq("id", idv(id));
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function companyPeopleAction(companyId: string) {
  return run((sb) => companyPeople(sb, idv(companyId)));
}

export async function addMemberAction(projectId: string, personId: string) {
  return run(async (sb) => {
    await rpc(sb, "project_add_member", { p_project: idv(projectId), p_person: idv(personId) });
  });
}

export async function removeMemberAction(projectId: string, personId: string) {
  return run(async (sb) => {
    await rpc(sb, "project_remove_member", { p_project: idv(projectId), p_person: idv(personId) });
  });
}

/**
 * Génère (ou régénère) le code d'accès d'une personne. Le code n'est renvoyé qu'ici, une seule fois :
 * la base n'en garde que l'empreinte. Régénérer invalide l'ancien code et ferme les sessions ouvertes.
 */
export async function issueAccessAction(personId: string, expiresAt: string | null) {
  return run(async (sb) => {
    const exp = expiresAt ? v(z.iso.datetime({ offset: true }), expiresAt) : null;
    const { code, hint } = generateCode();
    await rpc(sb, "portal_access_issue", { p_person: idv(personId), p_code_hash: codeHash(code), p_code_hint: hint, p_expires_at: exp });
    return { code, url: `${await origin()}/portail` };
  });
}

export async function setAccessExpiryAction(personId: string, expiresAt: string | null) {
  return run(async (sb) => {
    await rpc(sb, "portal_access_set_expiry", { p_person: idv(personId), p_expires_at: expiresAt ? v(z.iso.datetime({ offset: true }), expiresAt) : null });
  });
}

export async function revokeAccessAction(personId: string) {
  return run(async (sb) => {
    await rpc(sb, "portal_access_revoke", { p_person: idv(personId) });
  });
}

// Planning ------------------------------------------------------------------------------

/** Enregistre phases et jalons d'un projet (ordre = ordre reçu ; les éléments retirés sont supprimés). */
export async function savePlanningAction(projectId: string, phases: PhaseInput[], milestones: MilestoneInput[]) {
  return run(async (sb) => {
    const pid = idv(projectId);
    const ph = v(z.array(phaseSchema).max(20, "20 phases maximum"), phases);
    const ms = v(z.array(milestoneSchema).max(50, "50 jalons maximum"), milestones);
    const ok = async (res: PromiseLike<{ error: { message: string; code?: string } | null }>) => {
      const { error } = await res;
      if (error) throw new CrmError(friendlyError(error));
    };
    const keepPh: string[] = [];
    for (const [i, p] of ph.entries()) {
      const { id, ...data } = p;
      if (id) {
        await ok(sb.from("project_phases").update({ ...data, position: i }).eq("id", id).eq("project_id", pid));
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
        await ok(sb.from("project_milestones").update({ ...row, done_at: done ? ((prev as { done_at: string | null } | null)?.done_at ?? row.done_at) : null }).eq("id", id).eq("project_id", pid));
        keepMs.push(id);
      } else {
        const { data: ins, error } = await sb.from("project_milestones").insert({ ...row, project_id: pid }).select("id").single();
        if (error) throw new CrmError(friendlyError(error));
        keepMs.push((ins as { id: string }).id);
      }
    }
    const delMs = sb.from("project_milestones").delete().eq("project_id", pid);
    await ok(keepMs.length ? delMs.not("id", "in", `(${keepMs.join(",")})`) : delMs);
  });
}

// Points de suivi ------------------------------------------------------------------------

export async function createMeetingAction(projectId: string, input: MeetingCreateInput) {
  return run(async (sb) => {
    const d = v(meetingCreateSchema, input);
    const r = await orchestrate(async () => ownerCreateBooking(sb, { typeId: d.type_id, startsAt: d.starts_at, durationMin: d.duration_min, personId: d.person_id, idempotencyKey: d.idempotency_key }, await origin()));
    if (r.status === "unavailable") throw new CrmError("Ce créneau chevauche un autre rendez-vous.");
    if (r.status === "error") throw new CrmError(r.message);
    const { data: existing } = await sb.from("project_meetings").select("id").eq("booking_id", r.id).maybeSingle();
    if (existing) return { id: (existing as { id: string }).id };
    const id = await rpc<string>(sb, "project_link_meeting", { p_project: idv(projectId), p_booking: r.id, p_visible: d.visible, p_title: d.title, p_agenda: d.agenda });
    if (d.participants) await sb.from("project_meetings").update({ participants: d.participants }).eq("id", id);
    return { id };
  });
}

export async function linkMeetingAction(projectId: string, bookingId: string, visible: boolean) {
  return run(async (sb) => ({ id: await rpc<string>(sb, "project_link_meeting", { p_project: idv(projectId), p_booking: idv(bookingId), p_visible: visible }) }));
}

export async function updateMeetingAction(meetingId: string, patch: z.input<typeof meetingPatchSchema>) {
  return run(async (sb) => {
    const { error } = await sb.from("project_meetings").update(v(meetingPatchSchema, patch)).eq("id", idv(meetingId));
    if (error) throw new CrmError(friendlyError(error));
  });
}

/** Détache le point du projet : le rendez-vous reste intact ; le récapitulatif éventuel est supprimé. */
export async function unlinkMeetingAction(meetingId: string) {
  return run(async (sb) => {
    const { error } = await sb.from("project_meetings").delete().eq("id", idv(meetingId));
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function saveRecapAction(meetingId: string, input: RecapInput) {
  return run(async (sb) => {
    const r = v(recapSchema, input);
    const { error } = await sb.from("meeting_recaps").upsert({ meeting_id: idv(meetingId), ...r }, { onConflict: "meeting_id" });
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function publishRecapAction(meetingId: string, publish: boolean) {
  return run(async (sb) => {
    await rpc(sb, "project_publish_recap", { p_meeting: idv(meetingId), p_publish: publish });
  });
}

export async function rescheduleMeetingAction(bookingId: string, startsAt: string) {
  return run(async (sb) => {
    const { data } = await sb.from("appt_bookings").select("event_snapshot").eq("id", idv(bookingId)).single();
    const slug = (data as { event_snapshot: { slug: string } } | null)?.event_snapshot.slug ?? "";
    const r = await orchestrate(async () => rescheduleBooking({ kind: "owner", sb }, bookingId, slug, v(z.iso.datetime({ offset: true }), startsAt), await origin()));
    if (r.status === "unavailable") throw new CrmError("Ce créneau chevauche un autre rendez-vous.");
    if (r.status === "error") throw new CrmError(r.message);
    await rpc(sb, "appt_google_drift", { p_booking: bookingId, p_drift: null });
    return r;
  });
}

export async function cancelMeetingAction(bookingId: string, reason: string | null) {
  return run(async (sb) => {
    await orchestrate(async () => cancelBooking({ kind: "owner", sb }, idv(bookingId), reason?.trim().slice(0, 1000) || null, await origin()));
    await rpc(sb, "appt_google_drift", { p_booking: bookingId, p_drift: null });
  });
}

/** Écart Google : rétablir l'événement selon Cely (la base fait foi). */
export async function restoreGoogleEventAction(bookingId: string) {
  return run(async (sb) => {
    await rpc(sb, "appt_calendar_resync", { p_id: idv(bookingId), p_error: "Rétabli depuis Cely après modification dans Google", p_server_key: null });
    await orchestrate(async () => reconcileCalendar(sb, await origin(), 10));
    await rpc(sb, "appt_google_drift", { p_booking: bookingId, p_drift: null });
  });
}

export async function syncGoogleNowAction() {
  return run(async (sb) => orchestrate(() => syncGoogleChanges(sb)));
}

// Tâches ------------------------------------------------------------------------------------

/** Règles d'affectation : une tâche du client est forcément visible ; une tâche à moi n'a pas de contact. */
function normalizeTask(p: Record<string, unknown>) {
  if (p.assignee_kind === "owner") p.assignee_person_id = null;
  if (p.assignee_kind === "client") p.visible_to_client = true;
  return p;
}

export async function createTaskAction(projectId: string, input: TaskPatch & { title: string }) {
  return run(async (sb) => {
    const p = normalizeTask({ ...v(taskPatchSchema, input) });
    const { data, error } = await sb.from("project_tasks").insert({ ...p, project_id: idv(projectId) }).select("*").single();
    if (error) throw new CrmError(friendlyError(error));
    return data as AdminTask;
  });
}

export async function updateTaskAction(id: string, patch: TaskPatch) {
  return run(async (sb) => {
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
  });
}

export async function deleteTaskAction(id: string) {
  return run(async (sb) => {
    const { error } = await sb.from("project_tasks").delete().eq("id", idv(id));
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function commentTaskAction(taskId: string, body: string) {
  return run(async (sb) => {
    const b = v(z.string().trim().min(1, "Commentaire vide").max(1000, "1 000 caractères maximum"), body);
    const { error } = await sb.from("project_task_comments").insert({ task_id: idv(taskId), author_kind: "owner", body: b });
    if (error) throw new CrmError(friendlyError(error));
  });
}

/** Action d'un récapitulatif → tâche liée au point d'origine ; l'action garde la référence (aucun doublon). */
export async function taskFromRecapAction(meetingId: string, index: number) {
  return run(async (sb) => {
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
    const { error: e2 } = await sb.from("meeting_recaps").update({ actions }).eq("meeting_id", meetingId);
    if (e2) throw new CrmError(friendlyError(e2));
    return { task_id: (t as { id: string }).id, existing: false };
  });
}

// Idées --------------------------------------------------------------------------------------

export async function decideIdeaAction(id: string, status: "a_explorer" | "retenue" | "plus_tard" | "ecartee", note: string | null) {
  return run(async (sb) => {
    const n = v(z.string().trim().max(1000, "1 000 caractères maximum").nullable(), note);
    const { error } = await sb.from("project_ideas").update({ status, decision_note: n || null }).eq("id", idv(id));
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function createIdeaAction(projectId: string, title: string, description: string | null) {
  return run(async (sb) => {
    const t = v(z.string().trim().min(1, "Titre obligatoire").max(160), title);
    const { error } = await sb.from("project_ideas").insert({ project_id: idv(projectId), title: t, description: description?.trim() || null, author_kind: "owner" });
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function commentIdeaAction(ideaId: string, body: string) {
  return run(async (sb) => {
    const b = v(z.string().trim().min(1).max(1000), body);
    const { error } = await sb.from("project_idea_comments").insert({ idea_id: idv(ideaId), author_kind: "owner", body: b });
    if (error) throw new CrmError(friendlyError(error));
  });
}

export async function ideaToTaskAction(ideaId: string) {
  return run(async (sb) => ({ task_id: await rpc<string>(sb, "project_idea_to_task", { p_idea: idv(ideaId) }) }));
}
