// Éléments communs des pages publiques de réservation.
import Image from "next/image";
import { CalendarClock, Clock, MapPin, Phone, Video } from "lucide-react";
import type { LocationKind } from "@/lib/appointments/types";
import { LOCATION_LABELS } from "@/lib/appointments/types";

export function Brand({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-3">
      <Image src="/brand/cely-logo.svg" alt="Cely Growth" width={84} height={29} priority />
      {name !== "Cely Growth" && <span className="text-sm font-semibold text-muted">{name}</span>}
    </div>
  );
}

export function LocationIcon({ kind, size = 16 }: { kind: LocationKind; size?: number }) {
  const Icon = kind === "video" ? Video : kind === "phone" ? Phone : MapPin;
  return <Icon size={size} aria-hidden />;
}

export function EventFacts({
  duration,
  location,
  locationDetail,
  hasLink,
  when,
}: {
  duration: number;
  location: LocationKind;
  locationDetail?: string | null;
  hasLink?: boolean;
  when?: string | null;
}) {
  return (
    <ul className="space-y-2 text-sm text-muted">
      {when && (
        <li className="flex items-start gap-2 font-semibold text-ink">
          <CalendarClock size={16} className="mt-0.5 shrink-0 text-violet-strong" aria-hidden />
          <span>{when}</span>
        </li>
      )}
      <li className="flex items-center gap-2">
        <Clock size={16} aria-hidden /> {duration >= 60 && duration % 60 === 0 ? `${duration / 60} h` : `${duration} min`}
      </li>
      <li className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0"><LocationIcon kind={location} /></span>
        <span>
          {LOCATION_LABELS[location]}
          {location === "video" && hasLink && <span className="block text-xs">Lien de réunion fourni à la confirmation</span>}
          {location === "phone" && <span className="block text-xs">Appel au numéro que vous indiquerez</span>}
          {locationDetail && <span className="block text-xs">{locationDetail}</span>}
        </span>
      </li>
    </ul>
  );
}

export function Unavailable({ title, text }: { title: string; text: string }) {
  return (
    <div className="mx-auto max-w-lg rounded-2xl border border-line bg-white p-8 text-center">
      <div className="mb-6 flex justify-center">
        <Brand name="Cely Growth" />
      </div>
      <h1 className="font-display text-xl font-bold text-ink">{title}</h1>
      <p className="mt-2 text-sm text-muted">{text}</p>
    </div>
  );
}

export function formatDuration(min: number) {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}
