import { requireOwner } from "@/lib/auth";
import { listBookings, listEventTypes } from "@/lib/appointments/owner";
import { DEFAULT_TZ, addDaysKey, dayKey, isoWeekday, zonedToUtc } from "@/lib/appointments/time";
import { PageHeader } from "@/components/ui";
import { AgendaView, ViewSwitch } from "./agenda-view";
import { ListView } from "./list-view";

// Agenda : vues Jour, Semaine et Liste sur une seule page (?vue=jour|semaine|liste).
// Le détail d'un rendez-vous (?rdv=<id>) s'ouvre depuis n'importe quelle vue (BookingDetailHost, layout).
export default async function AgendaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();

  if (sp.vue === "liste") {
    const period = sp.periode ?? "a-venir";
    const now = new Date().toISOString();
    const [types, bookings] = await Promise.all([
      listEventTypes(supabase),
      listBookings(supabase, {
        q: sp.q,
        status: sp.statut,
        type: sp.type,
        crm: sp.crm,
        from: period === "a-venir" ? now : sp.du ? zonedToUtc(sp.du, "00:00", DEFAULT_TZ).toISOString() : undefined,
        to: period === "passes" ? now : sp.au ? zonedToUtc(sp.au, "24:00", DEFAULT_TZ).toISOString() : undefined,
      }),
    ]);
    return (
      <div>
        <PageHeader title="Agenda" description="Tous les rendez-vous : recherche, filtres et accès au détail." actions={<ViewSwitch view="liste" date={sp.date} />} />
        <ListView bookings={bookings} types={types.map((t) => ({ id: t.id, name: t.name }))} initial={{ q: sp.q ?? "", statut: sp.statut ?? "", type: sp.type ?? "", crm: sp.crm ?? "", periode: period }} />
      </div>
    );
  }

  const today = dayKey(new Date(), DEFAULT_TZ);
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today;
  const view = sp.vue === "semaine" ? "semaine" : "jour";
  const start = view === "semaine" ? addDaysKey(date, 1 - isoWeekday(date)) : date;
  const days = view === "semaine" ? 7 : 1;
  const bookings = await listBookings(supabase, {
    from: zonedToUtc(addDaysKey(start, -1), "00:00", DEFAULT_TZ).toISOString(),
    to: zonedToUtc(addDaysKey(start, days), "00:00", DEFAULT_TZ).toISOString(),
  });
  return <AgendaView bookings={bookings.filter((b) => b.status !== "cancelled" || sp.annules === "1")} start={start} days={days} view={view} today={today} showCancelled={sp.annules === "1"} />;
}
