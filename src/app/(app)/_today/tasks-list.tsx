"use client";

import type { TodoItem } from "@/lib/crm/types";
import { ProjectTaskRow } from "./project-task-row";

/** Tâches de projet attribuées à moi, chacune validée sur sa tâche d'origine. */
export function TasksList({ tasks }: { tasks: TodoItem[] }) {
  return (
    <div className="space-y-1.5">
      {tasks.filter((t) => t.item_type === "project_task").map((t) => <ProjectTaskRow key={`p-${t.id}`} t={t} />)}
    </div>
  );
}
