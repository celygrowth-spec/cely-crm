"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { useCrm } from "@/components/app-shell";
import Link from "next/link";
import { TaskRow } from "@/components/record-tasks";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import type { TodoItem } from "@/lib/crm/types";
import { CHANNEL_LABELS, relativeDay, todayISO } from "@/lib/format";

export function TodoView({ items }: { items: TodoItem[] }) {
  const router = useRouter();
  const { openCompany } = useCrm();
  const today = todayISO();
  const groups = [
    { title: "En retard", items: items.filter((i) => i.due_date < today) },
    { title: "Aujourd'hui", items: items.filter((i) => i.due_date === today) },
    { title: "Prochaines actions", items: items.filter((i) => i.due_date > today) },
  ];
  const refresh = () => router.refresh();

  return (
    <div className="max-w-4xl">
      <PageHeader title="À faire" description="Tâches manuelles et étapes de prospection à réaliser, sans doublon." />
      {!items.length && (
        <EmptyState title="Rien à faire pour l'instant" description="Les tâches créées sur les fiches et les relances de campagne apparaîtront ici." />
      )}
      <div className="space-y-6">
        {groups.map((g) =>
          g.items.length ? (
            <section key={g.title}>
              <h2 className="mb-2 flex items-center gap-2 font-label text-xs font-bold text-muted uppercase">
                {g.title} <Badge tone={g.title === "En retard" ? "danger" : "neutral"}>{g.items.length}</Badge>
              </h2>
              <div className="space-y-2">
                {g.items.map((i) =>
                  i.item_type === "task" ? (
                    <TaskRow
                      key={`t-${i.id}`}
                      task={{ id: i.id, title: i.title, due_date: i.due_date }}
                      companyLabel={i.company_name}
                      personLabel={i.person_name || undefined}
                      onOpenCompany={() => openCompany(i.company_id)}
                      onChanged={refresh}
                    />
                  ) : (
                    <div key={`f-${i.id}`} className="rounded-lg border border-violet-line bg-violet-soft/30 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <CheckCircle2 size={15} className="text-violet" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">
                            {i.title} {i.channel && <span className="font-normal text-muted">· {CHANNEL_LABELS[i.channel]}</span>}
                          </p>
                          <p className="text-xs text-muted">
                            <button onClick={() => openCompany(i.company_id)} className="font-semibold text-ink hover:text-violet-strong">{i.company_name}</button>
                            {i.person_name && ` · ${i.person_name}`} · Campagne {i.campaign_name}
                          </p>
                        </div>
                        <Badge tone={i.due_date < today ? "danger" : i.due_date === today ? "violet" : "neutral"}>{relativeDay(i.due_date)}</Badge>
                      </div>
                      <div className="mt-2">
                        <Link href={`/prospection/focus?depart=${i.id}`} className="inline-flex items-center gap-1 rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-white hover:bg-violet-strong">
                          Traiter en mode Focus
                        </Link>
                      </div>
                    </div>
                  ),
                )}
              </div>
            </section>
          ) : null,
        )}
      </div>
    </div>
  );
}
