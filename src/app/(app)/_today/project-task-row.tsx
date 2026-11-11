"use client";

// Tâche de projet attribuée à moi, affichée dans « Aujourd'hui » : la validation se fait sur la tâche d'origine
// (projet), donc elle se voit aussitôt dans le projet et, si elle est visible, dans le portail du client.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FolderKanban } from "lucide-react";
import { updateTaskAction } from "@/app/projets-actions";
import { useSync } from "@/lib/client/query";
import { relativeDay, todayISO } from "@/lib/format";
import type { TodoItem } from "@/lib/crm/types";
import { Badge } from "@/components/ui";

export function ProjectTaskRow({ t }: { t: TodoItem }) {
  const router = useRouter();
  const sync = useSync();
  const [busy, setBusy] = useState(false);
  const today = todayISO();
  async function done() {
    setBusy(true);
    const r = await updateTaskAction(t.id, { status: "termine" });
    setBusy(false);
    if (!r.ok) return toast.error(r.error);
    toast.success("Tâche du projet terminée", { description: t.project_name ?? undefined });
    sync(["project", t.project_id], ["company", t.company_id]);
    router.refresh();
  }
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2" data-project-task={t.id}>
      <input type="checkbox" className="accent-violet-600" disabled={busy} onChange={done} aria-label={`Terminer « ${t.title} »`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{t.title}</p>
        <p className="truncate text-xs text-muted">
          <FolderKanban size={11} className="mr-1 inline" aria-hidden />
          <Link href={`/projets/${t.project_id}`} className="font-semibold text-ink hover:text-violet-strong">{t.project_name}</Link> · {t.company_name}
        </p>
      </div>
      <Badge tone="violet">Projet</Badge>
      {t.due_date ? (
        <Badge tone={t.due_date < today ? "danger" : t.due_date === today ? "violet" : "neutral"}>{relativeDay(t.due_date)}</Badge>
      ) : <Badge>Sans échéance</Badge>}
    </div>
  );
}
