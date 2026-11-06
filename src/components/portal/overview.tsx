// Vue d'ensemble du portail. Hiérarchie : 1. état du projet, 2. mes prochains points, 3. ce qui vous attend,
// 4. timeline, 5. détail chronologique. Rien n'est inventé : une section sans contenu publié reste discrète.
import Link from "next/link";
import { CalendarRange, PauseCircle, Video } from "lucide-react";
import { PROJECT_STATUS_LABELS, type PortalMeeting, type PortalProject, type PortalProjectView } from "@/lib/projects/types";
import { formatDate } from "@/lib/format";
import { MeetingTime } from "./meeting-time";
import { TimelineList, TimelineVisual, currentPhase, isLate } from "./timeline";

const STATUS_STYLE: Record<string, string> = {
  a_preparer: "bg-surface text-muted",
  en_cours: "bg-violet-soft text-violet-strong",
  en_attente: "bg-amber-50 text-warning",
  termine: "bg-success/10 text-success",
  archive: "bg-surface text-muted",
};

export function ProjectStateCard({ project, view }: { project: PortalProject; view?: PortalProjectView }) {
  const phases = view?.phases ?? [];
  const cur = currentPhase(phases);
  const done = phases.filter((p) => p.status === "termine").length;
  const late = view ? phases.filter((p) => isLate(p, view.today)) : [];
  const next = cur ? phases[phases.indexOf(cur) + 1] : phases.find((p) => p.status === "a_venir");
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
      {phases.length > 0 && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-surface p-3">
            <p className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Étape actuelle</p>
            <p className="mt-0.5 font-semibold text-ink">{cur ? cur.name : done === phases.length ? "Toutes les étapes sont terminées" : "Démarrage à venir"}</p>
            <p className="text-xs text-muted">{done} étape{done > 1 ? "s" : ""} terminée{done > 1 ? "s" : ""} sur {phases.length}</p>
            <div className="mt-2 flex gap-1" aria-hidden>{phases.map((p) => <span key={p.id} className={`h-1.5 flex-1 rounded-full ${p.status === "termine" ? "bg-success" : p.id === cur?.id ? "bg-violet-strong" : "bg-line"}`} />)}</div>
          </div>
          <div className="rounded-xl bg-surface p-3">
            <p className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Prochaine étape</p>
            <p className="mt-0.5 font-semibold text-ink">{next ? next.name : "—"}</p>
            {next?.start_date && <p className="text-xs text-muted">Prévue à partir du {formatDate(next.start_date)}</p>}
          </div>
        </div>
      )}
      {project.status === "en_attente" && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-warning"><PauseCircle size={16} className="mt-0.5 shrink-0" /> Le projet est en pause pour le moment.</p>
      )}
      {late.length > 0 && project.status !== "en_attente" && (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-warning">
          {late.length === 1 ? `L'étape « ${late[0].name} » prend un peu plus de temps que prévu.` : `${late.length} étapes prennent un peu plus de temps que prévu.`}
        </p>
      )}
      {project.client_update && (
        <div className="mt-3 rounded-xl border border-violet-line bg-violet-soft/40 p-3">
          <p className="font-label text-[11px] font-semibold tracking-wide text-violet-strong uppercase">Où en sommes-nous</p>
          <p className="mt-1 text-sm leading-relaxed whitespace-pre-line text-ink">{project.client_update}</p>
        </div>
      )}
    </section>
  );
}

export type UpcomingMeeting = PortalMeeting & { project_id?: string; project_name?: string };

const joinLabel = (url: string) => (/^https:\/\/meet\.google\.com\//.test(url) ? "Rejoindre sur Google Meet" : "Rejoindre le point");

function JoinOrPending({ m, compact }: { m: UpcomingMeeting; compact?: boolean }) {
  if (m.meeting_url) {
    return (
      <a href={m.meeting_url} target="_blank" rel="noopener noreferrer"
        className={compact
          ? "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-semibold text-ink hover:border-violet hover:text-violet-strong"
          : "inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-ink px-4 text-sm font-semibold text-white hover:bg-violet-strong"}>
        <Video size={compact ? 14 : 16} aria-hidden /> {joinLabel(m.meeting_url)}
      </a>
    );
  }
  if (m.location_kind === "phone") return <span className="shrink-0 text-xs text-muted">Point téléphonique</span>;
  return <span className={`shrink-0 rounded-full bg-surface px-2.5 py-1 font-label text-xs text-muted ${compact ? "" : "self-start sm:self-auto"}`}>Lien à venir</span>;
}

/**
 * « Mes prochains points » : le prochain mis en avant, puis jusqu'à deux suivants en version compacte.
 * Ne reçoit que des points rattachés et partagés ; l'ordre suit la date réelle (un report le déplace),
 * un point annulé n'y figure pas (il reste dans le déroulé du projet).
 */
export function UpcomingMeetings({ meetings, hrefFor, showProject }: { meetings: UpcomingMeeting[]; hrefFor?: (m: UpcomingMeeting) => string; showProject?: boolean }) {
  const list = meetings.filter((m) => m.status === "upcoming").sort((a, b) => a.starts_at.localeCompare(b.starts_at)).slice(0, 3);
  const [next, ...rest] = list;
  const title = (m: UpcomingMeeting, cls: string) => {
    const href = hrefFor?.(m);
    return href ? <Link href={href} className={`${cls} hover:text-violet-strong hover:underline`}>{m.title}</Link> : <span className={cls}>{m.title}</span>;
  };
  return (
    <section aria-labelledby="prochains-points" className="rounded-2xl border border-line bg-white p-5" data-upcoming>
      <h2 id="prochains-points" className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Mes prochains points</h2>
      {!next ? <p className="mt-1 text-sm text-muted">Aucun point prévu pour le moment.</p> : (
        <>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center" data-meeting={next.id}>
            <div className="min-w-0 flex-1">
              {showProject && next.project_name && <p className="font-label text-[11px] font-semibold text-violet-strong">{next.project_name}</p>}
              {title(next, "font-display text-lg leading-snug font-bold text-ink")}
              <p className="text-sm text-ink"><MeetingTime start={next.starts_at} end={next.ends_at} tz={next.timezone} /></p>
            </div>
            <JoinOrPending m={next} />
          </div>
          {rest.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {rest.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-meeting={m.id}>
                  <div className="min-w-0 flex-1">
                    {title(m, "text-sm font-semibold text-ink")}
                    <p className="text-xs text-muted">
                      {showProject && m.project_name && <span className="font-semibold text-violet-strong">{m.project_name} · </span>}
                      <MeetingTime start={m.starts_at} end={m.ends_at} tz={m.timezone} />
                    </p>
                  </div>
                  <JoinOrPending m={m} compact />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

export function PastMeetings({ view, linkBase }: { view: PortalProjectView; linkBase?: string }) {
  const past = view.meetings.filter((m) => m.status === "past").reverse().slice(0, 5);
  if (!past.length) return null;
  return (
    <section aria-labelledby="points-passes">
      <h2 id="points-passes" className="mb-2 font-display text-lg font-bold text-ink">Points passés</h2>
      <ul className="divide-y divide-line rounded-2xl border border-line bg-white">
        {past.map((m) => (
          <li key={m.id}>
            {linkBase ? (
              <Link href={`${linkBase}/points/${m.id}`} className="flex flex-wrap items-center gap-2 px-4 py-3 hover:bg-surface">
                <span className="flex-1 font-semibold text-ink">{m.title}</span>
                <span className="text-sm text-muted">{formatDate(m.starts_at)}</span>
                <span className={`rounded-full px-2 py-0.5 font-label text-[11px] ${m.has_recap ? "bg-violet-soft text-violet-strong" : "bg-surface text-muted"}`}>{m.has_recap ? "Récapitulatif disponible" : "Récapitulatif à venir"}</span>
              </Link>
            ) : <span className="block px-4 py-3">{m.title}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function WaitingForYou({ view, linkBase }: { view: PortalProjectView; linkBase?: string }) {
  const tasks = view.my_tasks ?? [];
  return (
    <section aria-labelledby="attend" className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 id="attend" className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Ce qui vous attend</h2>
        {linkBase && tasks.length > 0 && <Link href={`${linkBase}/taches`} className="text-xs font-semibold text-violet-strong underline">Toutes les tâches</Link>}
      </div>
      {tasks.length === 0 ? <p className="mt-1 text-sm text-muted">Rien pour le moment : aucune action ne vous est demandée.</p> : (
        <ul className="mt-2 space-y-1.5">
          {tasks.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`size-2 rounded-full ${t.status === "bloque" ? "bg-warning" : t.status === "en_cours" ? "bg-violet-strong" : "bg-line"}`} aria-hidden />
              <span className="flex-1 text-ink">{t.title}</span>
              {t.due_date && <span className={`text-xs ${t.due_date < view.today ? "font-semibold text-warning" : "text-muted"}`}>{t.due_date < view.today ? "à faire depuis le " : "avant le "}{formatDate(t.due_date)}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function PortalOverview({ project, linkBase, attention }: { project: PortalProjectView; linkBase?: string; attention?: React.ReactNode }) {
  const hasPlan = project.phases.length > 0;
  return (
    <div className="space-y-5">
      <ProjectStateCard project={project} view={project} />
      <UpcomingMeetings meetings={project.meetings} hrefFor={linkBase ? (m) => `${linkBase}/points/${m.id}` : undefined} />
      {attention ?? <WaitingForYou view={project} linkBase={linkBase} />}
      {hasPlan && (
        <section aria-labelledby="deroule" className="space-y-4">
          <h2 id="deroule" className="font-display text-lg font-bold text-ink">Déroulé du projet</h2>
          <TimelineVisual phases={project.phases} milestones={project.milestones} meetings={project.meetings} today={project.today} start={project.start_date} end={project.end_date} projectId={project.id} linkBase={linkBase} />
          <TimelineList phases={project.phases} milestones={project.milestones} meetings={project.meetings} today={project.today} start={project.start_date} end={project.end_date} projectId={project.id} linkBase={linkBase} />
        </section>
      )}
      {!hasPlan && <PastMeetings view={project} linkBase={linkBase} />}
    </div>
  );
}
