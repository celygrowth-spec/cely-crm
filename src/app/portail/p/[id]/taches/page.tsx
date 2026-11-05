import { portalLoad } from "@/lib/projects/portal-load";
import type { PortalTask } from "@/lib/projects/types";
import { PortalTasks } from "@/components/portal/tasks";

export default async function ProjectTasksPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ point?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tasks = await portalLoad<PortalTask[]>("portal_tasks", { p_project: id, p_limit: 300 });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  return (
    <div>
      <h1 className="mb-4 font-display text-2xl font-bold text-ink">Tâches du projet</h1>
      <PortalTasks initial={tasks} today={today} showProject={false} meetingFilter={sp.point} />
    </div>
  );
}
