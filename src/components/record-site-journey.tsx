"use client";

// Section « Parcours site » de la fiche : frise chronologique des visites de celygrowth.com reliées à la fiche
// (première source, chaque visite avec ses UTM et ses pages, temps passé, dernière source, rendez-vous), et la
// source déclarée par le prospect à côté de la source mesurée.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck, ChevronDown, Globe, MousePointerClick, Send } from "lucide-react";
import { Skeleton, cn } from "@/components/ui";
import { apiGet } from "@/lib/client/query";
import { formatDateTime } from "@/lib/format";
import { CHANNEL_COLOR, touchLabel } from "@/lib/tracking/channels";
import type { Channel } from "@/lib/tracking/sources";

type Touch = { at: string | null; channel: string | null; source: string | null; campaign: string | null; medium?: string | null; entry_page?: string | null };
type Visit = {
  id: string; at: string; channel: string; source: string | null; referrer_host: string | null; utm: Record<string, string>;
  device: string; country: string | null; duration_s: number; pageviews: number; person_id: string | null;
  pages: { path: string; at: string; duration_s: number; scroll_pct: number }[];
  events: { kind: "cta" | "form" | "booking"; at: string; path: string; label: string | null }[];
};
type Booking = { booking_id: string | null; visit_id: string | null; at: string; starts_at: string | null; status: string | null; counted: boolean; person_id: string | null };
export type SiteJourney = {
  first: Touch | null; last: Touch | null;
  declared: { source: string | null; detail: string | null; at: string }[];
  visits: Visit[]; bookings: Booking[]; people: { id: string; name: string | null }[];
};

export function duration(s: number): string {
  if (!s) return "moins d'une seconde";
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return m < 60 ? `${m} min${r ? ` ${String(r).padStart(2, "0")}` : ""}` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
const dot = (channel: string) => CHANNEL_COLOR[channel as Channel]?.light ?? "#898781";
const STATUS: Record<string, string> = { pending: "en cours de confirmation", confirmed: "confirmé", cancelled: "annulé", failed: "non abouti", expired: "non abouti" };

function Source({ title, touch }: { title: string; touch: Touch | null }) {
  return (
    <div className="min-w-0 rounded-lg border border-line px-3 py-2">
      <p className="font-label text-[11px] font-bold tracking-wide text-muted uppercase">{title}</p>
      {touch?.channel ? (
        <>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: dot(touch.channel) }} aria-hidden />
            <span className="truncate">{touchLabel(touch)}</span>
          </p>
          {touch.at && <p className="text-xs text-muted">{formatDateTime(touch.at)}</p>}
        </>
      ) : <p className="mt-0.5 text-sm text-muted">Non mesurée</p>}
    </div>
  );
}

function VisitRow({ v, booking, who, first }: { v: Visit; booking?: Booking; who: string | null; first: boolean }) {
  const [open, setOpen] = useState(false);
  const utm = Object.entries(v.utm ?? {});
  return (
    <li className="relative pl-6">
      <span className="absolute top-1.5 left-0 size-3 rounded-full ring-2 ring-white" style={{ background: dot(v.channel) }} aria-hidden />
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-start gap-2 text-left">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {touchLabel({ channel: v.channel, source: v.source, campaign: v.utm?.campaign })}
            {first && <span className="ml-2 rounded bg-violet-soft px-1.5 py-0.5 text-[11px] font-bold text-violet-strong">Premier contact</span>}
          </span>
          <span className="block text-xs text-muted">
            {formatDateTime(v.at)} · {v.pageviews} page{v.pageviews > 1 ? "s" : ""} · {duration(v.duration_s)}{who ? ` · ${who}` : ""}
          </span>
        </span>
        <ChevronDown size={16} className={cn("mt-1 shrink-0 text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 grid gap-2 rounded-lg bg-surface px-3 py-2 text-xs">
          {utm.length > 0 && (
            <p className="flex flex-wrap gap-1.5">
              {utm.map(([k, val]) => <span key={k} className="rounded border border-line bg-white px-1.5 py-0.5"><span className="text-muted">utm_{k}</span> {val}</span>)}
            </p>
          )}
          {v.referrer_host && v.channel !== "campaign" && <p className="text-muted">Venu de {v.referrer_host}</p>}
          <ol className="grid gap-1">
            {v.pages.map((p, i) => (
              <li key={i} className="flex items-center gap-2">
                <Globe size={12} className="shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-semibold">{p.path}</span>
                <span className="shrink-0 text-muted">{duration(p.duration_s)} · lu à {p.scroll_pct} %</span>
              </li>
            ))}
            {v.events.filter((e) => e.kind !== "booking").map((e, i) => (
              <li key={`e${i}`} className="flex items-center gap-2 text-violet-strong">
                {e.kind === "cta" ? <MousePointerClick size={12} className="shrink-0" aria-hidden /> : <Send size={12} className="shrink-0" aria-hidden />}
                <span className="min-w-0 flex-1 truncate">{e.kind === "cta" ? "Clic vers la prise de rendez-vous" : `Formulaire envoyé${e.label ? ` (${e.label})` : ""}`} · {e.path}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {booking && (
        <p className={cn("mt-2 flex items-center gap-1.5 text-sm font-semibold", booking.counted ? "text-success" : "text-muted line-through")}>
          <CalendarCheck size={14} aria-hidden /> Rendez-vous {STATUS[booking.status ?? "confirmed"] ?? "pris"}
          {booking.starts_at && <span className="font-normal text-muted no-underline"> · {formatDateTime(booking.starts_at)}</span>}
        </p>
      )}
    </li>
  );
}

export function RecordSiteJourney({ companyId }: { companyId: string }) {
  const { data, isLoading, isError } = useQuery({ queryKey: ["fiche", companyId, "parcours-site"], queryFn: () => apiGet<SiteJourney>(`/api/fiches/${companyId}/parcours-site`), staleTime: 60_000 });
  const title = <h3 className="mb-2 font-label text-xs font-bold tracking-wide text-muted uppercase">Parcours site</h3>;
  if (isLoading) return <section data-site-journey>{title}<Skeleton className="h-16 w-full" /></section>;
  if (isError || !data) return null;
  const empty = !data.visits.length && !data.bookings.length && !data.declared.length;
  if (empty) {
    return <section data-site-journey>{title}<p className="text-sm text-muted">Aucune visite de celygrowth.com n&apos;est reliée à cette fiche pour l&apos;instant.</p></section>;
  }
  const name = (id: string | null) => data.people.find((p) => p.id === id)?.name ?? null;
  const several = data.people.length > 1;
  const orphanBookings = data.bookings.filter((b) => !b.visit_id || !data.visits.some((v) => v.id === b.visit_id));
  return (
    <section data-site-journey>
      {title}
      <div className="grid gap-2 sm:grid-cols-3">
        <Source title="Première source" touch={data.first} />
        <Source title="Dernière source" touch={data.last ?? data.first} />
        <div className="min-w-0 rounded-lg border border-line px-3 py-2">
          <p className="font-label text-[11px] font-bold tracking-wide text-muted uppercase">Source déclarée</p>
          {data.declared.length ? data.declared.slice(-1).map((d, i) => (
            <div key={i}>
              <p className="mt-0.5 truncate text-sm font-semibold">{d.source ?? "Autre"}</p>
              {d.detail && <p className="text-xs text-muted">« {d.detail} »</p>}
            </div>
          )) : <p className="mt-0.5 text-sm text-muted">Non renseignée</p>}
        </div>
      </div>
      {data.visits.length > 0 && (
        <ol className="relative mt-4 grid gap-4 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-line">
          {data.visits.map((v, i) => (
            <VisitRow key={v.id} v={v} first={i === 0} who={several ? name(v.person_id) : null} booking={data.bookings.find((b) => b.visit_id === v.id)} />
          ))}
        </ol>
      )}
      {orphanBookings.map((b, i) => (
        <p key={i} className="mt-3 flex items-center gap-1.5 text-sm text-muted">
          <CalendarCheck size={14} aria-hidden /> Rendez-vous pris le {formatDateTime(b.at)} sans visite mesurée du site
        </p>
      ))}
    </section>
  );
}
