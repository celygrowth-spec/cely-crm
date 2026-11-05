import { redirect } from "next/navigation";
import { PortalTopBar } from "@/components/portal/shell";
import { PortalTasks } from "@/components/portal/tasks";
import { PortalSessionError, portalRpc } from "@/lib/projects/portal";
import type { PortalMe, PortalTask } from "@/lib/projects/types";

// « Mes tâches » : toutes les actions visibles sur les projets autorisés (une seule ligne par action).
export default async function MyTasksPage() {
  let me: PortalMe;
  let tasks: PortalTask[];
  try {
    [me, tasks] = await Promise.all([portalRpc<PortalMe>("portal_me"), portalRpc<PortalTask[]>("portal_tasks", { p_project: null, p_limit: 300 })]);
  } catch (e) {
    if (e instanceof PortalSessionError) redirect("/portail");
    throw e;
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  return (
    <>
      <PortalTopBar me={me} />
      <main className="mx-auto max-w-5xl px-4 py-6">
        <h1 className="mb-4 font-display text-2xl font-bold text-ink">Mes tâches</h1>
        <PortalTasks initial={tasks} today={today} showProject={me.projects.length > 1} />
      </main>
    </>
  );
}
