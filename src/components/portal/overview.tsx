// Vue d'ensemble du portail : répond d'abord à « Où en est le projet ? ».
// Les sections suivantes (prochain point, ce qui vous attend, timeline) s'ajoutent avec les phases.
import { CalendarRange } from "lucide-react";
import { PROJECT_STATUS_LABELS, type PortalProject } from "@/lib/projects/types";
import { formatDate } from "@/lib/format";

const STATUS_STYLE: Record<string, string> = {
  a_preparer: "bg-surface text-muted",
  en_cours: "bg-violet-soft text-violet-strong",
  en_attente: "bg-amber-50 text-warning",
  termine: "bg-success/10 text-success",
  archive: "bg-surface text-muted",
};

export function ProjectStateCard({ project }: { project: PortalProject }) {
  return (
    <section aria-labelledby="etat" className="rounded-2xl border border-line bg-white p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-1 font-label text-xs font-semibold ${STATUS_STYLE[project.status]}`}>{PROJECT_STATUS_LABELS[project.status]}</span>
        {project.read_only && <span className="rounded-full bg-surface px-2.5 py-1 font-label text-xs text-muted">Projet archivé · consultation seule</span>}
        {(project.start_date || project.end_date) && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted">
            <CalendarRange size={14} aria-hidden /> {formatDate(project.start_date)} → {formatDate(project.end_date)}
          </span>
        )}
      </div>
      <h1 id="etat" className="mt-3 font-display text-2xl leading-tight font-bold text-ink sm:text-3xl">{project.name}</h1>
      {project.description && <p className="mt-1 text-sm text-muted">{project.description}</p>}
      {project.client_update ? (
        <div className="mt-4 rounded-xl bg-surface p-4">
          <p className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Où en sommes-nous</p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-ink">{project.client_update}</p>
        </div>
      ) : null}
    </section>
  );
}

export function PortalOverview({ project }: { project: PortalProject }) {
  return (
    <div className="space-y-5">
      <ProjectStateCard project={project} />
    </div>
  );
}
