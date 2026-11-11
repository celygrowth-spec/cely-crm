"use client";

import { useRouter } from "next/navigation";
import { useCrm } from "@/components/app-shell";
import { TaskRow } from "@/components/record-tasks";
import type { TodoItem } from "@/lib/crm/types";
import { ProjectTaskRow } from "./project-task-row";

/** Tâches CRM et tâches de projet attribuées à moi, chacune validée sur sa tâche d'origine. */
export function TasksList({ tasks }: { tasks: TodoItem[] }) {
  const router = useRouter();
  const { openCompany } = useCrm();
  return (
    <div className="space-y-1.5">
      {tasks.map((t) =>
        t.item_type === "project_task" ? <ProjectTaskRow key={`p-${t.id}`} t={t} /> : (
          <TaskRow
            key={`t-${t.id}`}
            task={{ id: t.id, title: t.title, due_date: t.due_date }}
            companyLabel={t.company_name}
            personLabel={t.person_name || undefined}
            onOpenCompany={() => openCompany(t.company_id)}
            onChanged={() => router.refresh()}
          />
        ),
      )}
    </div>
  );
}
