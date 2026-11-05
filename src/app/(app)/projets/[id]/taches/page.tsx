import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getProject, projectMeetings, projectMembers, projectTasks } from "@/lib/projects/owner";
import { AdminTasks } from "./admin-tasks";

export default async function TasksPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ point?: string; tache?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  const [tasks, members, meetings] = await Promise.all([projectTasks(supabase, id), projectMembers(supabase, id), projectMeetings(supabase, id)]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  return (
    <AdminTasks
      projectId={id}
      initial={tasks}
      today={today}
      members={members.map((m) => ({ id: m.person_id, name: [m.first_name, m.last_name].filter(Boolean).join(" ") || m.email || "Contact" }))}
      meetings={meetings.map((m) => ({ id: m.id, title: `${m.title ?? m.booking.event_snapshot.name} · ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "Europe/Paris" }).format(new Date(m.booking.starts_at))}` }))}
      initialMeeting={sp.point ?? ""}
      openTask={sp.tache ?? null}
    />
  );
}
