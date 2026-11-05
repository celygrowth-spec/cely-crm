"use client";

// Récapitulatif d'un rendez-vous confirmé : date, heure, fuseau, durée, lieu, ajout à l'agenda, lien privé.
import { useState } from "react";
import { CalendarPlus, Check, Copy, Download, ExternalLink } from "lucide-react";
import { googleCalendarTemplateUrl } from "@/lib/appointments/ics";
import { formatRange, timeZoneLabel } from "@/lib/appointments/time";
import type { PublicBooking } from "@/lib/appointments/types";
import { EventFacts } from "./public-bits";

export function BookingSummary({ booking, tz }: { booking: PublicBooking; tz: string }) {
  return (
    <div className="space-y-3">
      <EventFacts
        duration={booking.event.duration_min}
        location={booking.event.location_kind}
        locationDetail={booking.event.location_detail}
        when={`${formatRange(booking.starts_at, booking.ends_at, tz)} · ${timeZoneLabel(tz, new Date(booking.starts_at))}`}
      />
      {booking.meeting_url && (
        <a
          href={booking.meeting_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 truncate text-sm font-semibold text-violet-strong underline"
        >
          <ExternalLink size={14} aria-hidden /> {booking.meeting_url}
        </a>
      )}
    </div>
  );
}

export function AddToCalendar({ booking, manageUrl }: { booking: PublicBooking; manageUrl: string }) {
  const google = googleCalendarTemplateUrl({
    start: booking.starts_at,
    end: booking.ends_at,
    summary: `${booking.event.name} — ${booking.display_name}`,
    details: `Annuler ou reporter : ${manageUrl}`,
    location: booking.meeting_url ?? booking.event.location_detail,
  });
  const ref = manageUrl.split("/").pop();
  return (
    <div className="flex flex-wrap gap-2">
      <a href={`/api/rdv/ics/${ref}`} className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-3.5 text-sm font-semibold text-ink hover:border-violet hover:bg-violet-soft">
        <Download size={15} aria-hidden /> Fichier .ics (Apple, Outlook…)
      </a>
      <a href={google} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-white px-3.5 text-sm font-semibold text-ink hover:border-violet hover:bg-violet-soft">
        <CalendarPlus size={15} aria-hidden /> Google Agenda
      </a>
    </div>
  );
}

export function PrivateLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-violet-line bg-violet-soft/50 p-4">
      <p className="text-sm font-semibold text-ink">Votre lien personnel pour annuler ou reporter</p>
      <p className="mt-1 text-xs text-muted">Conservez-le : il donne accès à ce rendez-vous uniquement. Ne le partagez pas.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={url} className="inline-flex h-9 items-center rounded-lg bg-ink px-3.5 text-sm font-semibold text-white hover:bg-violet-strong">
          Annuler ou reporter
        </a>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              setCopied(false);
            }
          }}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink hover:border-violet"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Lien copié" : "Copier le lien"}
        </button>
      </div>
    </div>
  );
}
