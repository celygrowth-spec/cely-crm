import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { listEventTypes } from "@/lib/appointments/owner";
import { getProject, linkableBookings, projectMeetings, projectMembers } from "@/lib/projects/owner";
import { MeetingsView } from "./meetings-view";

export default async function PointsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  const [meetings, types, members, linkable, conn] = await Promise.all([
    projectMeetings(supabase, id),
    listEventTypes(supabase),
    projectMembers(supabase, id),
    linkableBookings(supabase, p.company_id),
    supabase.from("appt_google_connection").select("destination_calendar_id, events_synced_at, events_sync_error").maybeSingle(),
  ]);
  const c = conn.data as { destination_calendar_id: string | null; events_synced_at: string | null; events_sync_error: string | null } | null;
  return (
    <MeetingsView
      project={p}
      meetings={meetings}
      types={types.map((t) => ({ id: t.id, name: t.name, duration: t.duration_min, meet: t.google_meet || !!t.meeting_url }))}
      members={members.map((m) => ({ id: m.person_id, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email || "Contact", email: m.email }))}
      linkable={linkable}
      google={c ? { destination: !!c.destination_calendar_id, syncedAt: c.events_synced_at, error: c.events_sync_error } : null}
    />
  );
}
