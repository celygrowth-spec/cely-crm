"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ExternalLink, Search } from "lucide-react";
import { Badge, EmptyState, Input, Select, cn } from "@/components/ui";
import { StatusBadge, useOpenBooking } from "@/components/rdv/booking-detail";
import { DEFAULT_TZ, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import { DISPLAY_STATUS_LABELS, type Booking } from "@/lib/appointments/types";

type Filters = { q: string; statut: string; type: string; crm: string; periode: string };

export function ListView({ bookings, types, initial }: { bookings: Booking[]; types: { id: string; name: string }[]; initial: Filters }) {
  const router = useRouter();
  const pathname = usePathname();
  const open = useOpenBooking();
  const [f, setF] = useState(initial);
  const [pending, start] = useTransition();

  // recherche texte : appliquée après une courte pause de frappe
  useEffect(() => {
    if (f.q === initial.q) return;
    const t = setTimeout(() => apply(f), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.q]);

  function apply(next: Filters) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v && !(k === "periode" && v === "a-venir")) sp.set(k, v);
    start(() => router.replace(sp.size ? `${pathname}?${sp.toString()}` : pathname, { scroll: false }));
  }
  const set = (patch: Partial<Filters>) => {
    const next = { ...f, ...patch };
    setF(next);
    if (!("q" in patch)) apply(next);
  };

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <Search size={15} className="absolute top-2.5 left-3 text-muted" />
          <Input value={f.q} onChange={(e) => set({ q: e.target.value })} placeholder="Nom, email, entreprise" className="pl-8" aria-label="Rechercher" />
        </div>
        <Select value={f.periode} onChange={(e) => set({ periode: e.target.value })} className="w-36" aria-label="Période">
          <option value="a-venir">À venir</option>
          <option value="passes">Passés</option>
          <option value="tous">Tous</option>
        </Select>
        <Select value={f.statut} onChange={(e) => set({ statut: e.target.value })} className="w-44" aria-label="Statut">
          <option value="">Tous les statuts</option>
          {(["a_venir", "a_renseigner", "done", "no_show", "cancelled"] as const).map((s) => <option key={s} value={s}>{DISPLAY_STATUS_LABELS[s]}</option>)}
        </Select>
        <Select value={f.type} onChange={(e) => set({ type: e.target.value })} className="w-48" aria-label="Type">
          <option value="">Tous les types</option>
          {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
        <Select value={f.crm} onChange={(e) => set({ crm: e.target.value })} className="w-44" aria-label="Rattachement CRM">
          <option value="">Toutes les fiches</option>
          <option value="to_link">À rattacher</option>
        </Select>
      </div>

      {bookings.length === 0 ? (
        <EmptyState title="Aucun rendez-vous" description="Modifiez les filtres ou partagez le lien d'un type de rendez-vous." />
      ) : (
        <div className={cn("overflow-x-auto rounded-xl border border-line bg-white transition-opacity", pending && "opacity-60")}>
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line bg-surface text-left font-label text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-semibold">Date</th>
                <th className="px-3 py-2 font-semibold">Personne</th>
                <th className="px-3 py-2 font-semibold">Entreprise</th>
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Statut</th>
                <th className="px-3 py-2 font-semibold">Réunion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {bookings.map((b) => (
                <tr key={b.id} onClick={() => open(b.id)} className={cn("cursor-pointer hover:bg-surface", b.status === "cancelled" && "text-muted")}>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    <button type="button" className="text-left font-semibold text-ink hover:underline" onClick={(e) => { e.stopPropagation(); open(b.id); }}>
                      {formatLongDate(b.starts_at, DEFAULT_TZ).replace(/^\w+ /, "")}
                    </button>
                    <span className="block text-xs text-muted">{formatTimeShort(b.starts_at, DEFAULT_TZ)} – {formatTimeShort(b.ends_at, DEFAULT_TZ)}</span>
                  </td>
                  <td className="px-3 py-2"><span className="font-semibold text-ink">{b.first_name} {b.last_name}</span><span className="block text-xs text-muted">{b.email}</span></td>
                  <td className="px-3 py-2">
                    {b.crm_company_name ?? b.company_name ?? "—"}
                    {b.crm_status === "to_link" && b.status === "confirmed" && <Badge tone="warning" className="ml-1">À rattacher</Badge>}
                  </td>
                  <td className="px-3 py-2">{b.event_snapshot.name}</td>
                  <td className="px-3 py-2"><StatusBadge s={b.display_status} /></td>
                  <td className="px-3 py-2">
                    {b.meeting_url && b.status === "confirmed" ? (
                      <a href={b.meeting_url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-violet-strong underline">
                        Lien <ExternalLink size={12} />
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
