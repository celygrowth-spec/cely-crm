import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getCampaignWorkspace } from "@/lib/prospection/service";
import type { Interaction } from "@/lib/crm/types";
import { ActivityFeed } from "./activity-feed";

export default async function ActivitePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const ws = await getCampaignWorkspace(supabase, id);
  if (!ws) notFound();
  const ids = ws.participants.map((p) => p.id);
  const rows: Interaction[] = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await supabase.from("interactions").select("*").in("campaign_participant_id", ids.slice(i, i + 300)).order("occurred_at", { ascending: false }).limit(500);
    rows.push(...((data ?? []) as Interaction[]));
  }
  const { data: byMeta } = await supabase.from("interactions").select("*").eq("meta->>campaign_id", id).order("occurred_at", { ascending: false }).limit(500);
  const seen = new Set(rows.map((r) => r.id));
  for (const r of (byMeta ?? []) as Interaction[]) if (!seen.has(r.id)) rows.push(r);
  rows.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  const companies = Object.fromEntries(ws.participants.map((p) => [p.company_id, p.company.name]));
  const people = Object.fromEntries(ws.people.map((p) => [p.id, `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim()]));
  return <ActivityFeed rows={rows.slice(0, 500)} companies={companies} people={people} />;
}
