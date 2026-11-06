"use server";

// Server actions du module Projets (administration). La logique partagée avec le connecteur Claude
// est dans src/lib/projects/service.ts ; ici restent l'authentification et le module Rendez-vous.
import { headers } from "next/headers";
import { z } from "zod";
import { run } from "@/lib/action";
import { CrmError } from "@/lib/crm/service";
import { appUrl } from "@/lib/appointments/config";
import { codeHash, generateCode } from "@/lib/projects/portal-auth";
import { companyPeople } from "@/lib/projects/owner";
import { meetingCreateSchema, type meetingPatchSchema, type MeetingCreateInput, type MilestoneInput, type PhaseInput, type ProjectCreateInput, type ProjectPatch, type RecapInput, type TaskPatch } from "@/lib/projects/schemas";
import * as svc from "@/lib/projects/service";
import { idv, rpc, v } from "@/lib/projects/service";
import { BookingError, cancelBooking, ownerCreateBooking, reconcileCalendar, rescheduleBooking } from "@/lib/appointments/server";
import { syncGoogleChanges } from "@/lib/appointments/google-sync";

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
  return run((sb) => svc.createProject(sb, input));
}

export async function updateProjectAction(id: string, patch: ProjectPatch) {
  return run((sb) => svc.updateProject(sb, id, patch));
}

export async function companyPeopleAction(companyId: string) {
  return run((sb) => companyPeople(sb, idv(companyId)));
}

export async function addMemberAction(projectId: string, personId: string) {
  return run(async (sb) => {
    await svc.addMember(sb, projectId, personId);
  });
}

export async function removeMemberAction(projectId: string, personId: string) {
  return run(async (sb) => {
    await svc.removeMember(sb, projectId, personId);
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
    await svc.setAccessExpiry(sb, personId, expiresAt);
  });
}

export async function revokeAccessAction(personId: string) {
  return run(async (sb) => {
    await svc.revokeAccess(sb, personId);
  });
}

// Planning ------------------------------------------------------------------------------

/** Enregistre phases et jalons d'un projet (ordre = ordre reçu ; les éléments retirés sont supprimés). */
export async function savePlanningAction(projectId: string, phases: PhaseInput[], milestones: MilestoneInput[]) {
  return run((sb) => svc.savePlanning(sb, projectId, phases, milestones));
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
  return run(async (sb) => ({ id: await svc.linkMeeting(sb, projectId, bookingId, visible) }));
}

export async function updateMeetingAction(meetingId: string, patch: z.input<typeof meetingPatchSchema>) {
  return run((sb) => svc.updateMeeting(sb, meetingId, patch));
}

/** Détache le point du projet : le rendez-vous reste intact ; le récapitulatif éventuel est supprimé. */
export async function unlinkMeetingAction(meetingId: string) {
  return run((sb) => svc.unlinkMeeting(sb, meetingId));
}

export async function saveRecapAction(meetingId: string, input: RecapInput) {
  return run((sb) => svc.saveRecap(sb, meetingId, input));
}

export async function publishRecapAction(meetingId: string, publish: boolean) {
  return run(async (sb) => {
    await svc.publishRecap(sb, meetingId, publish);
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

export async function createTaskAction(projectId: string, input: TaskPatch & { title: string }) {
  return run((sb) => svc.createTask(sb, projectId, input));
}

export async function updateTaskAction(id: string, patch: TaskPatch) {
  return run((sb) => svc.updateTask(sb, id, patch));
}

export async function deleteTaskAction(id: string) {
  return run((sb) => svc.deleteTask(sb, id));
}

export async function commentTaskAction(taskId: string, body: string) {
  return run((sb) => svc.commentTask(sb, taskId, body));
}

/** Action d'un récapitulatif → tâche liée au point d'origine ; l'action garde la référence (aucun doublon). */
export async function taskFromRecapAction(meetingId: string, index: number) {
  return run((sb) => svc.taskFromRecap(sb, meetingId, index));
}

// Idées --------------------------------------------------------------------------------------

export async function decideIdeaAction(id: string, status: svc.IdeaStatus, note: string | null) {
  return run((sb) => svc.decideIdea(sb, id, status, note));
}

export async function createIdeaAction(projectId: string, title: string, description: string | null) {
  return run((sb) => svc.createIdea(sb, projectId, title, description));
}

export async function commentIdeaAction(ideaId: string, body: string) {
  return run((sb) => svc.commentIdea(sb, ideaId, body));
}

export async function ideaToTaskAction(ideaId: string) {
  return run(async (sb) => ({ task_id: await svc.ideaToTask(sb, ideaId) }));
}
