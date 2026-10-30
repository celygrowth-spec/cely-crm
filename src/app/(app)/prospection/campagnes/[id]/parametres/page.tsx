import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getCampaignWorkspace } from "@/lib/prospection/service";
import { CampaignSettings } from "./campaign-settings";

export default async function ParametresCampagnePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const ws = await getCampaignWorkspace(supabase, id);
  if (!ws) notFound();
  const versions = [...new Set(ws.steps.map((s) => s.version))].sort();
  return <CampaignSettings c={ws.campaign} versions={versions} />;
}
