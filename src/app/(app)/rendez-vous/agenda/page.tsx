import { requireOwner } from "@/lib/auth";
import { listBookings } from "@/lib/appointments/owner";
import { DEFAULT_TZ, addDaysKey, dayKey, isoWeekday, zonedToUtc } from "@/lib/appointments/time";
import { AgendaView } from "./agenda-view";

export default async function AgendaPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
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
