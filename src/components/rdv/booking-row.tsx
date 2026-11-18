"use client";

import { ExternalLink } from "lucide-react";
import { Badge, cn } from "@/components/ui";
import { DEFAULT_TZ, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import type { Booking } from "@/lib/appointments/types";
import { NextActionButton } from "@/components/next-action";
import { StatusBadge, useOpenBooking } from "./booking-detail";

/** Ligne cliquable d'un rendez-vous (vue d'ensemble, listes courtes). */
export function BookingRow({ b, showDate = true }: { b: Booking; showDate?: boolean }) {
  const open = useOpenBooking();
  return (
    <li>
      <button
        type="button"
        onClick={() => open(b.id)}
        className={cn("row-in flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-left hover:bg-surface", b.status === "cancelled" && "opacity-60")}
      >
        <span className="w-28 shrink-0 font-label text-sm font-semibold text-ink tabular-nums">
          {showDate && <span className="block text-xs font-normal text-muted">{formatLongDate(b.starts_at, DEFAULT_TZ).replace(/ \d{4}$/, "")}</span>}
          {formatTimeShort(b.starts_at, DEFAULT_TZ)} – {formatTimeShort(b.ends_at, DEFAULT_TZ)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ink">{b.first_name} {b.last_name}{(b.crm_company_name ?? b.company_name) && <span className="font-normal text-muted"> · {b.crm_company_name ?? b.company_name}</span>}</span>
          <span className="block truncate text-xs text-muted">{b.event_snapshot.name}</span>
        </span>
        {b.crm_status === "to_link" && b.status === "confirmed" && <Badge tone="warning">À rattacher</Badge>}
        <StatusBadge s={b.display_status} />
        {b.meeting_url && b.status === "confirmed" && (
          <a href={b.meeting_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="rounded-md p-1 text-violet-strong hover:bg-violet-soft" aria-label="Lien de réunion">
            <ExternalLink size={14} />
          </a>
        )}
      </button>
      {/* après le rendez-vous : la prochaine action du parcours de la fiche */}
      {b.company_id && (b.display_status === "done" || b.display_status === "a_renseigner") && <div className="px-3 pb-2 sm:pl-[8.5rem]"><NextActionButton companyId={b.company_id} /></div>}
    </li>
  );
}
