"use client";

// Agenda jour / semaine (fuseau Europe/Paris). Clic sur un rendez-vous : détail rapide.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ButtonLink, PageHeader, cn } from "@/components/ui";
import { useOpenBooking } from "@/components/rdv/booking-detail";
import { DEFAULT_TZ, addDaysKey, dayKey, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import type { Booking } from "@/lib/appointments/types";

const HOUR_PX = 48;

function minutesOfDay(iso: string) {
  const [h, m] = formatTimeShort(iso, DEFAULT_TZ).split(":").map(Number);
  return h * 60 + m;
}

/** Sélecteur de vue de l'Agenda : Jour, Semaine, Liste (même page, ?vue=). */
export function ViewSwitch({ view, date, showCancelled }: { view: "jour" | "semaine" | "liste"; date?: string; showCancelled?: boolean }) {
  const href = (v: string) => `/rendez-vous/agenda?${v === "liste" ? "vue=liste" : `${date ? `date=${date}&` : ""}vue=${v}${showCancelled ? "&annules=1" : ""}`}`;
  return (
    <nav aria-label="Vue de l'agenda" className="flex rounded-lg border border-line p-0.5">
      {([["jour", "Jour"], ["semaine", "Semaine"], ["liste", "Liste"]] as const).map(([v, label]) => (
        <Link key={v} href={href(v)} aria-current={view === v ? "page" : undefined} className={cn("rounded-md px-3 py-1 text-sm font-semibold", view === v ? "bg-ink text-white" : "text-muted hover:text-ink")}>{label}</Link>
      ))}
    </nav>
  );
}

export function AgendaView({ bookings, start, days, view, today, showCancelled }: {
  bookings: Booking[]; start: string; days: number; view: "jour" | "semaine"; today: string; showCancelled: boolean;
}) {
  const open = useOpenBooking();
  const router = useRouter();
  const dayList = Array.from({ length: days }, (_, i) => addDaysKey(start, i));
  const byDay = new Map(dayList.map((d) => [d, bookings.filter((b) => dayKey(b.starts_at, DEFAULT_TZ) === d)]));
  const mins = bookings.flatMap((b) => [minutesOfDay(b.starts_at), minutesOfDay(b.ends_at) || 1440]);
  const firstHour = Math.min(8, ...mins.map((m) => Math.floor(m / 60)));
  const lastHour = Math.max(19, ...mins.map((m) => Math.ceil(m / 60)));
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const step = view === "semaine" ? 7 : 1;
  const href = (d: string, v = view) => `/rendez-vous/agenda?date=${d}&vue=${v}${showCancelled ? "&annules=1" : ""}`;
  const title = view === "semaine"
    ? `Semaine du ${formatLongDate(`${start}T12:00:00Z`, "UTC").replace(/^\w+ /, "")}`
    : formatLongDate(`${start}T12:00:00Z`, "UTC");

  return (
    <div>
      <PageHeader
        title="Agenda"
        description={title}
        actions={
          <>
            <ViewSwitch view={view} date={start} showCancelled={showCancelled} />
            <ButtonLink href={href(addDaysKey(start, -step))} aria-label="Précédent"><ChevronLeft size={16} /></ButtonLink>
            <ButtonLink href={href(today)}>Aujourd&apos;hui</ButtonLink>
            <ButtonLink href={href(addDaysKey(start, step))} aria-label="Suivant"><ChevronRight size={16} /></ButtonLink>
          </>
        }
      />
      <label className="mb-3 flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={showCancelled} onChange={() => router.replace(`/rendez-vous/agenda?date=${start}&vue=${view}${showCancelled ? "" : "&annules=1"}`)} />
        Afficher les annulés
      </label>

      {/* Mobile : liste par jour */}
      <div className="space-y-4 md:hidden">
        {dayList.map((d) => (
          <section key={d}>
            <h2 className={cn("mb-1 text-sm font-semibold", d === today ? "text-violet-strong" : "text-ink")}>{formatLongDate(`${d}T12:00:00Z`, "UTC")}</h2>
            {(byDay.get(d) ?? []).length ? (
              <ul className="divide-y divide-line rounded-xl border border-line bg-white">
                {byDay.get(d)!.map((b) => (
                  <li key={b.id}>
                    <button type="button" onClick={() => open(b.id)} className="flex w-full gap-3 px-3 py-2 text-left">
                      <span className="w-12 font-label text-sm font-semibold tabular-nums">{formatTimeShort(b.starts_at, DEFAULT_TZ)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm">{b.first_name} {b.last_name} · <span className="text-muted">{b.event_snapshot.name}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-muted">Aucun rendez-vous.</p>}
          </section>
        ))}
      </div>

      {/* Desktop : grille horaire */}
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-white md:block">
        <div className="grid" style={{ gridTemplateColumns: `56px repeat(${days}, minmax(120px, 1fr))` }}>
          <div className="border-b border-line" />
          {dayList.map((d) => (
            <Link key={d} href={href(d, "jour")} className={cn("border-b border-l border-line px-2 py-2 text-center text-xs font-semibold", d === today ? "text-violet-strong" : "text-ink")}>
              {formatLongDate(`${d}T12:00:00Z`, "UTC").replace(/ \d{4}$/, "")}
            </Link>
          ))}
          <div className="relative">
            {hours.map((h) => (
              <div key={h} style={{ height: HOUR_PX }} className="pr-2 text-right font-label text-[11px] text-muted">{String(h).padStart(2, "0")}:00</div>
            ))}
          </div>
          {dayList.map((d) => (
            <div key={d} className={cn("relative border-l border-line", d === today && "bg-violet-soft/30")} style={{ height: hours.length * HOUR_PX }}>
              {hours.map((h, i) => <div key={h} className="absolute inset-x-0 border-t border-line/60" style={{ top: i * HOUR_PX }} />)}
              {(byDay.get(d) ?? []).map((b) => {
                const top = ((minutesOfDay(b.starts_at) - firstHour * 60) / 60) * HOUR_PX;
                const height = Math.max(22, ((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 3600_000) * HOUR_PX - 2);
                return (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => open(b.id)}
                    className={cn(
                      "absolute inset-x-1 overflow-hidden rounded-md border px-1.5 py-0.5 text-left text-[11px] leading-tight hover:z-10 hover:shadow",
                      b.status === "cancelled" ? "border-line bg-surface text-muted line-through" : b.display_status === "a_renseigner" ? "border-amber-300 bg-amber-50 text-ink" : "border-violet-line bg-violet-soft text-ink",
                    )}
                    style={{ top, height }}
                  >
                    <span className="font-semibold">{formatTimeShort(b.starts_at, DEFAULT_TZ)} {b.first_name} {b.last_name}</span>
                    <span className="block truncate text-muted">{b.event_snapshot.name}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
