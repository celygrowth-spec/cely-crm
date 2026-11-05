import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getEventType, listSchedules } from "@/lib/appointments/owner";
import { PageHeader } from "@/components/ui";
import { TypeEditor } from "./type-editor";

export default async function TypeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const isNew = id === "nouveau";
  const [schedules, type] = await Promise.all([listSchedules(supabase), isNew ? null : getEventType(supabase, id)]);
  if (!isNew && !type) notFound();
  const { count } = isNew ? { count: 0 } : await supabase.from("appt_bookings").select("id", { count: "exact", head: true }).eq("event_type_id", id).eq("status", "confirmed").gte("starts_at", new Date().toISOString());
  return (
    <div>
      <PageHeader title={isNew ? "Nouveau type de rendez-vous" : type!.name} description={isNew ? "Durée, lieu, disponibilités et formulaire." : undefined} />
      <TypeEditor type={type} schedules={schedules.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone, is_default: s.is_default }))} upcoming={count ?? 0} />
    </div>
  );
}
