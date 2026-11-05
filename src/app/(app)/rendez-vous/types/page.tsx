import { headers } from "next/headers";
import { requireOwner } from "@/lib/auth";
import { appUrl } from "@/lib/appointments/config";
import { getSettings, listEventTypes, listSchedules } from "@/lib/appointments/owner";
import { PageHeader, ButtonLink } from "@/components/ui";
import { TypesView } from "./types-view";

export default async function TypesPage() {
  const { supabase } = await requireOwner();
  const [types, schedules, settings] = await Promise.all([listEventTypes(supabase), listSchedules(supabase), getSettings(supabase)]);
  const h = await headers();
  const host = h.get("host");
  const base = appUrl(host ? `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}` : null);
  return (
    <div>
      <PageHeader
        title="Types de rendez-vous"
        description="Chaque type a sa page publique de réservation, sans compte."
        actions={<ButtonLink href="/rendez-vous/types/nouveau" variant="primary">Nouveau type</ButtonLink>}
      />
      <TypesView types={types} schedules={schedules.map((s) => ({ id: s.id, name: s.name }))} baseUrl={base} settings={settings} />
    </div>
  );
}
