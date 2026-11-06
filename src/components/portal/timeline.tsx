// Timeline du projet : frise colorée (phases, jalons, points, aujourd'hui) puis liste chronologique,
// construites à partir des MÊMES données. L'avancement affiché est le statut réel de chaque phase ;
// le repère « Aujourd'hui » ne montre que le temps écoulé.
import Link from "next/link";
import { Check, Diamond, Pause, Video } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatDate } from "@/lib/format";
import { formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import { PHASE_STATUS_LABELS, type Milestone, type Phase, type PhaseColor, type PortalMeeting } from "@/lib/projects/types";
import { REACH_CLASS, axisTicks, makeScale } from "@/lib/projects/timeline-axis";
import { Mascot } from "./mascot";

export const PHASE_STYLES: Record<PhaseColor, { bar: string; soft: string; text: string; dot: string }> = {
  violet: { bar: "bg-[#8b5bff]", soft: "bg-[#f3eaff]", text: "text-[#5b21d6]", dot: "bg-[#8b5bff]" },
  blue: { bar: "bg-[#3b82f6]", soft: "bg-[#e8f0fe]", text: "text-[#1d4ed8]", dot: "bg-[#3b82f6]" },
  teal: { bar: "bg-[#14b8a6]", soft: "bg-[#e0f7f4]", text: "text-[#0f766e]", dot: "bg-[#14b8a6]" },
  green: { bar: "bg-[#22c55e]", soft: "bg-[#e7f8ee]", text: "text-[#15803d]", dot: "bg-[#22c55e]" },
  amber: { bar: "bg-[#f59e0b]", soft: "bg-[#fef3dc]", text: "text-[#b45309]", dot: "bg-[#f59e0b]" },
  pink: { bar: "bg-[#ec4899]", soft: "bg-[#fde8f3]", text: "text-[#be185d]", dot: "bg-[#ec4899]" },
  slate: { bar: "bg-[#64748b]", soft: "bg-[#eef1f5]", text: "text-[#334155]", dot: "bg-[#64748b]" },
};

/** Phase dont la date de fin est dépassée sans être terminée : décalage, pas d'échec. */
export function isLate(p: Phase, today: string) {
  return p.status !== "termine" && !!p.end_date && p.end_date < today;
}

export function currentPhase(phases: Phase[]): Phase | null {
  return phases.find((p) => p.status === "en_cours") ?? phases.find((p) => p.status === "en_pause") ?? null;
}

type Props = { phases: Phase[]; milestones: Milestone[]; meetings: PortalMeeting[]; today: string; start: string | null; end: string | null; projectId: string; linkBase?: string };

const edgeAlign = (left: number) => (left < 4 ? "translate-x-0" : left > 96 ? "-translate-x-full" : "-translate-x-1/2");
const shortDay = (d: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

export function TimelineVisual({ phases, milestones, meetings, today, start, end, projectId, linkBase }: Props) {
  const scale = makeScale([
    start, end,
    ...phases.flatMap((p) => [p.start_date, p.end_date]),
    ...milestones.map((m) => m.due_date),
    ...meetings.filter((m) => m.status !== "cancelled").map((m) => m.starts_at.slice(0, 10)),
  ]);
  const ticks = scale ? axisTicks(scale) : [];
  // aujourd'hui : milieu de la journée, à sa position exacte dans la période
  const todayPos = scale ? scale.at(today, "mid") : null;
  const showToday = todayPos !== null && todayPos >= 0 && todayPos <= 100;
  const current = currentPhase(phases);
  const done = phases.filter((p) => p.status === "termine").length;
  const placed = (p: Phase) => !!scale && !!p.start_date && !!p.end_date;
  const curLeft = current && placed(current) ? scale!.at(current.start_date!) : null;

  return (
    <div className="relative rounded-2xl border border-line bg-white p-4 sm:p-6">
      <div className="relative" role="img" aria-label={`Frise du projet${showToday ? `, aujourd'hui ${shortDay(today)}` : ""} : ${phases.map((p) => `${p.name} (${PHASE_STATUS_LABELS[p.status]}${p.start_date ? `, du ${formatDate(p.start_date)} au ${formatDate(p.end_date)}` : ""})`).join(", ")}`}>
        {/* axe : mois et repères 10 · 20 · 30 (seulement les dates qui existent dans la période) */}
        {scale && (
          <div className="relative h-8 border-b border-line" data-axis>
            {ticks.map((tk) => (
              <span key={tk.key} className={cn("absolute bottom-0", REACH_CLASS[tk.reach])} style={{ left: `${tk.left}%` }} data-tick={tk.kind}>
                <span className={cn("absolute bottom-1.5 whitespace-nowrap", edgeAlign(tk.left),
                  tk.kind === "month" ? "font-label text-[11px] font-semibold text-ink" : "text-[10px] text-muted tabular-nums")}>
                  {tk.label}{tk.year ? <span className="hidden sm:inline"> {tk.year}</span> : null}
                </span>
                <span className={cn("absolute bottom-0 w-px", tk.kind === "month" ? "h-1.5 bg-ink/40" : "h-1 bg-line")} />
              </span>
            ))}
          </div>
        )}

        {/* phase réellement en cours : repère distinct de la date du jour (une phase peut durer au-delà de sa fin prévue) */}
        {current && (
          <div className="relative mt-2 h-7">
            <span
              className={cn("absolute inline-flex items-center gap-1.5 whitespace-nowrap", curLeft === null ? "left-0" : edgeAlign(Math.min(curLeft, 90)))}
              style={curLeft === null ? undefined : { left: `${Math.min(Math.max(curLeft, 0), 90)}%` }}
              data-current-phase={current.id}
            >
              <Mascot projectId={projectId} phase={current.name} done={done} />
              <span className={cn("rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", current.status === "en_pause" ? "bg-amber-50 text-warning" : "bg-violet-soft text-violet-strong")}>
                {current.status === "en_pause" ? "En pause" : "En cours"} · {current.name}
              </span>
            </span>
          </div>
        )}

        <div className="relative mt-1">
          {/* lignes de mois, en fond */}
          {ticks.filter((tk) => tk.kind === "month" && tk.left > 0).map((tk) => (
            <span key={tk.key} className={cn("pointer-events-none absolute top-0 bottom-0 w-px bg-line/70", REACH_CLASS[tk.reach])} style={{ left: `${tk.left}%` }} aria-hidden />
          ))}
          {/* temps écoulé */}
          {showToday && <div className="pointer-events-none absolute top-0 bottom-0 left-0 rounded-l-lg bg-surface/80" style={{ width: `${todayPos}%` }} />}

          {/* phases, à leurs dates réelles (du premier au dernier jour inclus) */}
          <div className="relative flex h-12 gap-1 sm:h-14">
            {phases.map((p, i) => {
              const st = PHASE_STYLES[p.color] ?? PHASE_STYLES.violet;
              const left = placed(p) ? scale!.at(p.start_date!) : 0;
              const right = placed(p) ? scale!.at(p.end_date!, "end") : 0;
              const style = placed(p)
                ? { position: "absolute" as const, left: `${left}%`, width: `${Math.max(right - left, 2)}%`, top: 0, bottom: 0 }
                : { flex: 1 };
              const isCurrent = current?.id === p.id;
              const late = isLate(p, today) && placed(p) && showToday && todayPos! > right;
              return (
                <div key={p.id} className="contents">
                  {late && (
                    // dépassement : la phase se poursuit au-delà de sa fin prévue, jusqu'à aujourd'hui
                    <div className="tl-overrun absolute top-1 bottom-1 rounded-r-lg" style={{ left: `${right}%`, width: `${todayPos! - right}%` }} title={`${p.name} : dépasse la date prévue (${formatDate(p.end_date)})`} aria-hidden />
                  )}
                  <div
                    className={cn(
                      "tl-in flex min-w-0 items-center gap-1.5 overflow-hidden rounded-lg px-2 text-xs font-semibold shadow-sm sm:text-sm",
                      p.status === "a_venir" ? `${st.soft} ${st.text}` : `${st.bar} text-white`,
                      p.status === "en_pause" && "tl-paused",
                      isCurrent && "z-[1] ring-2 ring-violet-strong ring-offset-2",
                    )}
                    style={{ ...style, animationDelay: `${i * 70}ms` }}
                    title={`${p.name} · ${PHASE_STATUS_LABELS[p.status]}${p.start_date ? ` · ${formatDate(p.start_date)} → ${formatDate(p.end_date)}` : ""}`}
                    data-phase={p.id}
                  >
                    {p.status === "termine" && <Check size={14} className="tl-check shrink-0" aria-hidden />}
                    {p.status === "en_pause" && <Pause size={13} className="shrink-0" aria-hidden />}
                    <span className="truncate">{p.name}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* jalons et points, à leur date */}
          {scale && (milestones.length > 0 || meetings.length > 0) && (
            <div className="relative mt-3 h-7">
              {milestones.map((m) => (
                <span key={m.id} className="absolute -translate-x-1/2" style={{ left: `${scale.at(m.due_date, "mid")}%` }} title={`Jalon : ${m.title} · ${formatDate(m.due_date)}`}>
                  <Diamond size={14} className={m.done ? "fill-success text-success" : "fill-white text-ink"} aria-hidden />
                </span>
              ))}
              {meetings.filter((m) => m.status !== "cancelled").map((m) => {
                const dot = <span className={cn("block size-3 rounded-full border-2 border-white shadow", m.status === "upcoming" ? "bg-violet-strong" : "bg-muted")} />;
                return (
                  <span key={m.id} className="absolute top-3.5 -translate-x-1/2" style={{ left: `${scale.at(m.starts_at.slice(0, 10), "mid")}%` }} title={`Point : ${m.title} · ${formatDate(m.starts_at)}`}>
                    {linkBase ? <Link href={`${linkBase}/points/${m.id}`} aria-label={`Point : ${m.title}`}>{dot}</Link> : dot}
                  </span>
                );
              })}
            </div>
          )}

          {/* aujourd'hui : trait sombre et date du jour, distinct du repère de la phase en cours */}
          {showToday && (
            <div className="pointer-events-none absolute -top-1 bottom-0 z-10" style={{ left: `${todayPos}%` }} data-today={todayPos!.toFixed(2)}>
              <div className="h-full w-0.5 -translate-x-1/2 rounded bg-ink" />
              <span className={cn("absolute bottom-0 translate-y-full rounded-full bg-ink px-2 py-0.5 font-label text-[10px] font-semibold whitespace-nowrap text-white", edgeAlign(todayPos!))}>
                Aujourd&apos;hui · {shortDay(today)}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><Check size={12} /> Terminée</span>
        <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-sm ring-2 ring-violet-strong" /> En cours</span>
        <span className="inline-flex items-center gap-1"><span className="h-3 w-0.5 rounded bg-ink" /> Aujourd&apos;hui</span>
        <span className="inline-flex items-center gap-1"><Diamond size={12} /> Jalon</span>
        <span className="inline-flex items-center gap-1"><span className="size-2.5 rounded-full bg-violet-strong" /> Point de suivi</span>
      </div>
    </div>
  );
}

/** Liste chronologique, lisible sur mobile : même source que la frise. */
export function TimelineList({ phases, milestones, meetings, today, linkBase }: Props) {
  const inPhase = (p: Phase, d: string) => !!p.start_date && !!p.end_date && d >= p.start_date && d <= p.end_date;
  const loose = meetings.filter((m) => !phases.some((p) => inPhase(p, m.starts_at.slice(0, 10))));
  return (
    <ol className="space-y-3">
      {phases.map((p, i) => {
        const st = PHASE_STYLES[p.color] ?? PHASE_STYLES.violet;
        const ms = milestones.filter((m) => m.phase_id === p.id || (!m.phase_id && inPhase(p, m.due_date)));
        const pts = meetings.filter((m) => inPhase(p, m.starts_at.slice(0, 10)));
        const late = isLate(p, today);
        return (
          <li key={p.id} className="row-in relative flex gap-3" style={{ animationDelay: `${i * 40}ms` }}>
            <div className="flex flex-col items-center">
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white", st.dot)}>
                {p.status === "termine" ? <Check size={14} /> : i + 1}
              </span>
              {i < phases.length - 1 && <span className="mt-1 w-0.5 flex-1 rounded bg-line" />}
            </div>
            <div className="min-w-0 flex-1 rounded-xl border border-line bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-display text-base font-bold text-ink">{p.name}</h3>
                <span className={cn("rounded-full px-2 py-0.5 font-label text-[11px] font-semibold", p.status === "termine" ? "bg-success/10 text-success" : p.status === "en_cours" ? `${st.soft} ${st.text}` : p.status === "en_pause" ? "bg-amber-50 text-warning" : "bg-surface text-muted")}>
                  {PHASE_STATUS_LABELS[p.status]}
                </span>
                {late && <span className="rounded-full bg-amber-50 px-2 py-0.5 font-label text-[11px] text-warning">Dépasse la date prévue</span>}
                {(p.start_date || p.end_date) && <span className="ml-auto text-xs text-muted">{formatDate(p.start_date)} → {formatDate(p.end_date)}</span>}
              </div>
              {p.description && <p className="mt-1 text-sm whitespace-pre-line text-muted">{p.description}</p>}
              {p.deliverables && <p className="mt-2 text-sm"><span className="font-semibold text-ink">Livrables : </span><span className="text-muted">{p.deliverables}</span></p>}
              {(ms.length > 0 || pts.length > 0) && (
                <ul className="mt-2 space-y-1 text-sm">
                  {ms.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 text-muted"><Diamond size={12} className={m.done ? "fill-success text-success" : ""} /> {m.title} · {formatDate(m.due_date)}{m.done && " · atteint"}</li>
                  ))}
                  {pts.map((m) => <MeetingLine key={m.id} m={m} linkBase={linkBase} />)}
                </ul>
              )}
            </div>
          </li>
        );
      })}
      {loose.length > 0 && (
        <li className="rounded-xl border border-line bg-white p-4">
          <h3 className="mb-1 font-display text-base font-bold text-ink">Autres points</h3>
          <ul className="space-y-1 text-sm">{loose.map((m) => <MeetingLine key={m.id} m={m} linkBase={linkBase} />)}</ul>
        </li>
      )}
    </ol>
  );
}

function MeetingLine({ m, linkBase }: { m: PortalMeeting; linkBase?: string }) {
  const label = (
    <>
      <Video size={12} aria-hidden /> {m.title} · {formatLongDate(m.starts_at, m.timezone).replace(/ \d{4}$/, "")} {formatTimeShort(m.starts_at, m.timezone)}
      {m.status === "cancelled" && " · annulé"}
      {m.has_recap && " · récapitulatif"}
    </>
  );
  return (
    <li className={cn("flex items-center gap-2", m.status === "cancelled" ? "text-muted line-through" : "text-ink")}>
      {linkBase ? <Link href={`${linkBase}/points/${m.id}`} className="inline-flex items-center gap-2 hover:underline">{label}</Link> : label}
    </li>
  );
}
