import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getEventType, getReminderSettings, listReminderRules, listSchedules } from "@/lib/appointments/owner";
import { DEFAULT_TZ, formatLongDate, formatTimeShort } from "@/lib/appointments/time";
import { ReminderRules } from "@/components/rdv/reminder-rules";
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
      <div className="space-y-5">
        <TypeEditor type={type} schedules={schedules.map((s) => ({ id: s.id, name: s.name, timezone: s.timezone, is_default: s.is_default }))} upcoming={count ?? 0} />
        {isNew ? (
          <p className="max-w-3xl rounded-xl border border-dashed border-line p-4 text-sm text-muted">Rappels : enregistrez d&apos;abord ce type pour configurer ses rappels.</p>
        ) : (
          <div className="max-w-3xl"><Reminders typeId={id} enabled={type!.reminders_enabled} /></div>
        )}
      </div>
    </div>
  );
}

async function Reminders({ typeId, enabled }: { typeId: string; enabled: boolean }) {
  const { supabase } = await requireOwner();
  const [rules, settings, recent] = await Promise.all([
    listReminderRules(supabase, typeId),
    getReminderSettings(supabase),
    supabase.from("appt_bookings").select("id, first_name, last_name, starts_at").eq("event_type_id", typeId).eq("status", "confirmed").order("starts_at", { ascending: false }).limit(10),
  ]);
  const bookings = ((recent.data ?? []) as { id: string; first_name: string; last_name: string; starts_at: string }[]).map((b) => ({
    id: b.id,
    label: `${b.first_name} ${b.last_name} · ${formatLongDate(b.starts_at, DEFAULT_TZ).replace(/^\S+ /, "")} ${formatTimeShort(b.starts_at, DEFAULT_TZ)}`,
  }));
  return <ReminderRules typeId={typeId} initialEnabled={enabled} initialRules={rules} bookings={bookings} mailConnectedAt={settings.mailConnectedAt} paused={settings.paused} />;
}
