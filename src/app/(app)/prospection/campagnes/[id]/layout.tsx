import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import type { CampaignOverview } from "@/lib/prospection/service";
import { CampaignHeader } from "./campaign-header";

export default async function CampaignLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const { data } = await supabase.from("campaign_overview").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  return (
    <div>
      <CampaignHeader c={data as CampaignOverview} />
      {children}
    </div>
  );
}
