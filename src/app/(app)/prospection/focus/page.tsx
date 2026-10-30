import { requireOwner } from "@/lib/auth";
import { todayISO } from "@/lib/format";
import { getFocusQueue } from "@/lib/prospection/service";
import { FocusSession } from "./focus-session";

export default async function FocusPage({ searchParams }: { searchParams: Promise<{ campagne?: string; depart?: string }> }) {
  const { supabase } = await requireOwner();
  const { campagne, depart } = await searchParams;
  const items = await getFocusQueue(supabase, { campaignId: campagne ?? null, today: todayISO() });
  const ordered = depart ? [...items.filter((i) => i.participant.id === depart), ...items.filter((i) => i.participant.id !== depart)] : items;
  return <FocusSession items={ordered} campaignName={campagne ? (items[0]?.campaign.name ?? null) : null} />;
}
