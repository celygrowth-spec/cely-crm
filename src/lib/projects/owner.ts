import "server-only";
// Lectures d'administration du module Projets (session du propriétaire, sous RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import { CrmError, friendlyError } from "@/lib/crm/service";
import type { OnboardingStatus } from "./onboarding-rules";
import type { AdminMeeting, AdminTask, Member, Milestone, Phase, PortalAccess, Project, TaskComment } from "./types";

function check<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}

export async function listProjects(sb: SupabaseClient, opts: { archived?: boolean; companyId?: string } = {}): Promise<Project[]> {
  let q = sb.from("project_overview").select("*");
  if (opts.companyId) q = q.eq("company_id", opts.companyId);
  else q = opts.archived ? q.eq("status", "archive") : q.neq("status", "archive");
  return check(await q.order("updated_at", { ascending: false }).limit(300)) as Project[];
}

/** État de préparation des projets nés d'une vente (« Gagné »), par projet. */
export async function onboardingStatuses(sb: SupabaseClient): Promise<Record<string, OnboardingStatus>> {
  const rows = check(await sb.from("project_onboarding_status").select("project_id, status").limit(1000)) as { project_id: string; status: OnboardingStatus }[];
  return Object.fromEntries(rows.map((r) => [r.project_id, r.status]));
}

export async function getProject(sb: SupabaseClient, id: string): Promise<Project | null> {
  return check(await sb.from("project_overview").select("*").eq("id", id).maybeSingle()) as Project | null;
}

export async function projectMembers(sb: SupabaseClient, projectId: string): Promise<Member[]> {
  const ids = (check(await sb.from("project_members").select("person_id").eq("project_id", projectId).order("added_at")) as { person_id: string }[]).map((m) => m.person_id);
  if (!ids.length) return [];
  const [people, accesses] = await Promise.all([
    sb.from("people").select("id, first_name, last_name, email").in("id", ids),
    sb.from("portal_accesses").select("id, person_id, code_hint, code_generated_at, expires_at, revoked_at, last_used_at").in("person_id", ids),
  ]);
  const ppl = check(people) as { id: string; first_name: string | null; last_name: string | null; email: string | null }[];
  const acc = check(accesses) as PortalAccess[];
  return ids.map((id) => {
    const p = ppl.find((x) => x.id === id);
    return { person_id: id, first_name: p?.first_name ?? null, last_name: p?.last_name ?? null, email: p?.email ?? null, access: acc.find((a) => a.person_id === id) ?? null };
  });
}

export async function companyPeople(sb: SupabaseClient, companyId: string) {
  return check(await sb.from("people").select("id, first_name, last_name, email").eq("company_id", companyId).order("is_primary", { ascending: false }).order("created_at")) as {
    id: string; first_name: string | null; last_name: string | null; email: string | null;
  }[];
}

export async function projectPlanning(sb: SupabaseClient, projectId: string): Promise<{ phases: Phase[]; milestones: (Milestone & { visible_to_client: boolean })[] }> {
  const [ph, ms] = await Promise.all([
    sb.from("project_phases").select("id, name, description, deliverables, start_date, end_date, color, status, completed_at").eq("project_id", projectId).order("position").order("start_date"),
    sb.from("project_milestones").select("id, title, due_date, done_at, phase_id, visible_to_client").eq("project_id", projectId).order("due_date"),
  ]);
  return {
    phases: check(ph) as Phase[],
    milestones: (check(ms) as { id: string; title: string; due_date: string; done_at: string | null; phase_id: string | null; visible_to_client: boolean }[]).map((m) => ({ ...m, done: !!m.done_at })),
  };
}

export async function projectMeetings(sb: SupabaseClient, projectId: string): Promise<AdminMeeting[]> {
  const meetings = check(await sb.from("project_meetings").select("id, booking_id, title, agenda, participants, visible_to_client").eq("project_id", projectId)) as Omit<AdminMeeting, "booking" | "recap">[];
  if (!meetings.length) return [];
  const ids = meetings.map((m) => m.booking_id);
  const [bk, rc] = await Promise.all([
    sb.from("appt_bookings").select("id, status, starts_at, ends_at, meeting_url, first_name, last_name, schedule_timezone, event_snapshot, google_drift").in("id", ids),
    sb.from("meeting_recaps").select("meeting_id, summary, decisions, actions, next_step, links, internal_note, status, published_at").in("meeting_id", meetings.map((m) => m.id)),
  ]);
  const bookings = check(bk) as (AdminMeeting["booking"] & { id: string })[];
  const recaps = check(rc) as (NonNullable<AdminMeeting["recap"]> & { meeting_id: string })[];
  return meetings
    .map((m) => ({ ...m, booking: bookings.find((b) => b.id === m.booking_id)!, recap: recaps.find((r) => r.meeting_id === m.id) ?? null }))
    .filter((m) => m.booking)
    .sort((a, b) => a.booking.starts_at.localeCompare(b.booking.starts_at));
}

/** Rendez-vous de la fiche qui peuvent être rattachés au projet (jamais ceux d'une autre fiche). */
export async function linkableBookings(sb: SupabaseClient, companyId: string) {
  const [bk, linked] = await Promise.all([
    sb.from("appt_bookings").select("id, starts_at, first_name, last_name, event_snapshot, status").eq("company_id", companyId).in("status", ["confirmed"]).order("starts_at", { ascending: false }).limit(50),
    sb.from("project_meetings").select("booking_id"),
  ]);
  const taken = new Set((check(linked) as { booking_id: string }[]).map((x) => x.booking_id));
  return (check(bk) as { id: string; starts_at: string; first_name: string; last_name: string; event_snapshot: { name: string } }[]).filter((b) => !taken.has(b.id));
}

export async function projectTasks(sb: SupabaseClient, projectId: string): Promise<AdminTask[]> {
  return check(await sb.from("project_tasks").select("*").eq("project_id", projectId).order("position").order("created_at").limit(1000)) as AdminTask[];
}

export async function taskDetail(sb: SupabaseClient, taskId: string): Promise<{ task: AdminTask; comments: TaskComment[] } | null> {
  const t = check(await sb.from("project_tasks").select("*").eq("id", taskId).maybeSingle()) as AdminTask | null;
  if (!t) return null;
  const rows = check(await sb.from("project_task_comments").select("id, body, created_at, author_kind, person_id").eq("task_id", taskId).order("created_at")) as
    { id: string; body: string; created_at: string; author_kind: "owner" | "client"; person_id: string | null }[];
  const ids = [...new Set(rows.map((r) => r.person_id).filter((x): x is string => !!x))];
  const people = ids.length ? (check(await sb.from("people").select("id, first_name, last_name").in("id", ids)) as { id: string; first_name: string | null; last_name: string | null }[]) : [];
  return {
    task: t,
    comments: rows.map((r) => {
      const p = people.find((x) => x.id === r.person_id);
      return { id: r.id, body: r.body, created_at: r.created_at, author_kind: r.author_kind, author: r.author_kind === "owner" ? "Vous" : [p?.first_name, p?.last_name].filter(Boolean).join(" ") || "Client" };
    }),
  };
}
