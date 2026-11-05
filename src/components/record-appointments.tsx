"use client";

// Rendez-vous d'une fiche, avec les réponses au formulaire. Le détail complet (report, annulation,
// qualification) s'ouvre dans l'espace Rendez-vous.
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/client/query";
import { DEFAULT_TZ, formatRange } from "@/lib/appointments/time";
import type { Booking } from "@/lib/appointments/types";
import { StatusBadge } from "./rdv/booking-detail";
import { Skeleton } from "./ui";

export function RecordAppointments({ companyId }: { companyId: string }) {
  const q = useQuery({
    queryKey: ["appt-company", companyId],
    queryFn: ({ signal }) => apiGet<Booking[]>(`/api/fiches/${companyId}/rendez-vous`, signal),
  });
  if (q.isLoading) return <Skeleton className="h-12 w-full" />;
  if (q.isError) return <p className="text-sm text-danger">{q.error.message}</p>;
  const list = q.data ?? [];
  if (!list.length) return <p className="text-sm text-muted">Aucun rendez-vous réservé.</p>;
  return (
    <ul className="space-y-2">
      {list.map((b) => (
        <li key={b.id} className="rounded-lg border border-line p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{b.event_snapshot.name}</span>
            <StatusBadge s={b.display_status} />
            <Link href={`/rendez-vous/liste?periode=tous&rdv=${b.id}`} className="ml-auto text-xs font-semibold text-violet-strong underline">Détail</Link>
          </div>
          <p className="text-xs text-muted">{formatRange(b.starts_at, b.ends_at, DEFAULT_TZ)} · {b.first_name} {b.last_name}</p>
          {b.answers.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs font-semibold text-muted">Réponses au formulaire ({b.answers.length})</summary>
              <dl className="mt-1 space-y-1 text-xs">
                {b.answers.map((a) => <div key={a.id}><dt className="font-semibold text-ink">{a.label}</dt><dd className="whitespace-pre-line text-muted">{a.value}</dd></div>)}
              </dl>
            </details>
          )}
          {b.internal_note && <p className="mt-1 text-xs whitespace-pre-line text-muted">Note : {b.internal_note}</p>}
        </li>
      ))}
    </ul>
  );
}
