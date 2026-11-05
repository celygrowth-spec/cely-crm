import { requireOwner } from "@/lib/auth";
import { listBlocks, listEventTypes, listSchedules } from "@/lib/appointments/owner";
import { PageHeader } from "@/components/ui";
import { AvailabilityView } from "./availability-view";

export default async function DisponibilitesPage({ searchParams }: { searchParams: Promise<{ planning?: string }> }) {
  const { supabase } = await requireOwner();
  const sp = await searchParams;
  const [schedules, blocks, types] = await Promise.all([listSchedules(supabase), listBlocks(supabase), listEventTypes(supabase)]);
  return (
    <div>
      <PageHeader title="Disponibilités" description="Horaires hebdomadaires, exceptions par date, congés et blocages. Fuseau Europe/Paris par défaut." />
      <AvailabilityView
        schedules={schedules}
        blocks={blocks}
        usage={Object.fromEntries(schedules.map((s) => [s.id, types.filter((t) => t.schedule_id === s.id).map((t) => t.name)]))}
        selectedId={sp.planning ?? null}
      />
    </div>
  );
}
