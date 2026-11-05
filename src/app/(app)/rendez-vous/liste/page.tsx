import { requireOwner } from "@/lib/auth";
import { listBookings, listEventTypes } from "@/lib/appointments/owner";
import { DEFAULT_TZ, zonedToUtc } from "@/lib/appointments/time";
import { PageHeader } from "@/components/ui";
import { ListView } from "./list-view";

export default async function RdvListPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
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
      <PageHeader title="Liste des rendez-vous" description="Recherche, filtres et accès au détail." />
      <ListView bookings={bookings} types={types.map((t) => ({ id: t.id, name: t.name }))} initial={{ q: sp.q ?? "", statut: sp.statut ?? "", type: sp.type ?? "", crm: sp.crm ?? "", periode: period }} />
    </div>
  );
}
