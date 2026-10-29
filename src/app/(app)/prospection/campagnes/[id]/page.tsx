import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import type { CampaignStep, ParticipantStatus, Person } from "@/lib/crm/types";
import { CampaignView, type Row } from "./campaign-view";

export default async function CampagnePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const { data: campaign } = await supabase
    .from("campaigns")
    .select("id, name, template_name, archived_at, created_at, campaign_steps(position, name, channel, delay_days, message), campaign_lists(list_id)")
    .eq("id", id)
    .maybeSingle();
  if (!campaign) notFound();
  const { data: participants } = await supabase
    .from("campaign_participants")
    .select("id, company_id, person_id, current_step, status, next_due_date, last_done_at, stop_reason, company:companies(id, name, archived_at)")
    .eq("campaign_id", id)
    .order("next_due_date", { nullsFirst: false })
    .limit(5000);
  const pIds = (participants ?? []).map((p) => p.id);
  const cIds = (participants ?? []).map((p) => p.company_id);
  const [{ data: people }, { data: messages }] = await Promise.all([
    cIds.length ? supabase.from("people").select("*").in("company_id", cIds) : Promise.resolve({ data: [] }),
    pIds.length
      ? supabase.from("interactions").select("campaign_participant_id, kind, content, occurred_at").in("campaign_participant_id", pIds).in("kind", ["message_out", "message_in"]).order("occurred_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);
  const lastMsg = new Map<string, { kind: string; content: string | null; occurred_at: string }>();
  (messages ?? []).forEach((m) => { if (!lastMsg.has(m.campaign_participant_id!)) lastMsg.set(m.campaign_participant_id!, m); });
  const steps = [...(campaign.campaign_steps as CampaignStep[])].sort((a, b) => a.position - b.position);
  const rows: Row[] = (participants ?? []).map((p) => {
    const company = p.company as unknown as { id: string; name: string; archived_at: string | null };
    return {
      id: p.id,
      company_id: p.company_id,
      company_name: company.name,
      archived: !!company.archived_at,
      person_id: p.person_id,
      current_step: p.current_step,
      status: p.status as ParticipantStatus,
      next_due_date: p.next_due_date,
      stop_reason: p.stop_reason,
      steps,
      people: ((people ?? []) as Person[]).filter((x) => x.company_id === p.company_id),
      last: lastMsg.get(p.id) ?? null,
    };
  });
  return (
    <CampaignView
      campaign={{ id: campaign.id, name: campaign.name, template_name: campaign.template_name, archived: !!campaign.archived_at, listIds: (campaign.campaign_lists as { list_id: string }[]).map((l) => l.list_id) }}
      steps={steps}
      rows={rows}
    />
  );
}
