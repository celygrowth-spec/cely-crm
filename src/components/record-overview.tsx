"use client";

// Onglet Aperçu : prochaine action, prochain rendez-vous, contexte, derniers échanges. Ce qui manque reste discret.
import { useState } from "react";
import { CalendarClock, ExternalLink } from "lucide-react";
import { DEFAULT_TZ, formatRange } from "@/lib/appointments/time";
import { nextBooking, recentExchanges } from "@/lib/crm/record-activity";
import { PROSPECT_STATUS_LABELS } from "@/lib/format";
import type { RecordCtx } from "./company-record";
import { EntryRow, useActivityEntries } from "./record-entry";
import { RecordTodos } from "./todo/record-todos";
import { Skeleton, cn } from "./ui";
import { RecordSiteJourney } from "./record-site-journey";

export function RecordOverview({ ctx }: { ctx: RecordCtx }) {
  const { entries, bookings, loading } = useActivityEntries(ctx, false);
  const booking = nextBooking(bookings);
  const exchanges = recentExchanges(entries);

  return (
    <div className="grid gap-5">
      <RecordTodos companyId={ctx.detail.company.id} />

      {booking && (
        <section className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2.5 text-sm">
          <CalendarClock size={16} className="shrink-0 text-violet-strong" />
          <div className="min-w-0 flex-1">
            <p className="font-label text-xs font-bold text-muted">Prochain rendez-vous</p>
            <p className="font-semibold">{formatRange(booking.starts_at, booking.ends_at, DEFAULT_TZ)}</p>
          </div>
          {booking.meeting_url && (
            <a href={booking.meeting_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-violet-strong hover:underline">
              Rejoindre <ExternalLink size={12} />
            </a>
          )}
        </section>
      )}

      <Context ctx={ctx} />

      <RecordSiteJourney companyId={ctx.detail.company.id} />

      <section>
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="font-label text-xs font-bold tracking-wide text-muted uppercase">Derniers échanges</h3>
          {exchanges.length > 0 && <button type="button" className="text-xs font-semibold text-violet-strong hover:underline" onClick={() => ctx.go("activity")}>Tout voir dans Activité</button>}
        </div>
        {loading && !exchanges.length && <div className="grid gap-2"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>}
        {!loading && !exchanges.length && <p className="text-sm text-muted">Aucun échange pour l&apos;instant.</p>}
        <div className="-mx-2">
          {exchanges.map((e) => <EntryRow key={e.key} entry={e} ctx={ctx} />)}
        </div>
      </section>
    </div>
  );
}


/** Au-delà, le texte risque de dépasser les trois lignes affichées. */
const LONG_CONTEXT = 120;

function Context({ ctx }: { ctx: RecordCtx }) {
  const c = ctx.detail.company;
  const [open, setOpen] = useState(false);
  const edit = () => ctx.go("details", { section: "company", edit: true });
  const statusLabel = c.pipeline_id ? PROSPECT_STATUS_LABELS[c.prospect_status] : null;
  if (!c.description) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
        <span>Aucun besoin renseigné{c.source ? ` · Source : ${c.source.name}` : ""}.</span>
        <button type="button" className="text-xs font-semibold text-violet-strong hover:underline" onClick={edit}>Ajouter</button>
      </p>
    );
  }
  return (
    <section>
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <h3 className="font-label text-xs font-bold tracking-wide text-muted uppercase">Contexte prospect</h3>
        {c.source && <span className="text-xs text-muted">· {c.source.name}</span>}
        {statusLabel && <span className="text-xs text-muted">· {statusLabel}</span>}
      </div>
      <p className={cn("text-sm break-words whitespace-pre-line", !open && "line-clamp-3")}>{open ? c.description : c.description.replace(/\n\s*\n/g, "\n")}</p>
      <div className="mt-0.5 flex gap-3 text-xs font-semibold text-violet-strong">
        {c.description.length > LONG_CONTEXT && <button type="button" className="hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Réduire" : "Lire la suite"}</button>}
        <button type="button" className="hover:underline" onClick={edit}>Modifier</button>
      </div>
    </section>
  );
}
