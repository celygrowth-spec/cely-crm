"use client";

import { useRouter } from "next/navigation";
import { useCrm } from "@/components/app-shell";
import { TaskRow } from "@/components/record-tasks";
import type { TodoItem } from "@/lib/crm/types";

export function TasksBlock({ tasks }: { tasks: TodoItem[] }) {
  const router = useRouter();
  const { openCompany } = useCrm();
  return (
    <section>
      <h2 className="mb-1.5 font-label text-xs font-bold text-muted uppercase">Tâches manuelles · {tasks.length}</h2>
      <div className="space-y-1.5">
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={{ id: t.id, title: t.title, due_date: t.due_date }}
            companyLabel={t.company_name}
            personLabel={t.person_name || undefined}
            onOpenCompany={() => openCompany(t.company_id)}
            onChanged={() => router.refresh()}
          />
        ))}
      </div>
    </section>
  );
}
