import { requireOwner } from "@/lib/auth";
import { listCampaigns } from "@/lib/prospection/service";
import { CampaignsList } from "./campaigns-list";

export default async function CampagnesPage() {
  const { supabase } = await requireOwner();
  const [campaigns, templates] = await Promise.all([
    listCampaigns(supabase),
    supabase.from("templates").select("id, name").order("name"),
  ]);
  return <CampaignsList campaigns={campaigns} templates={templates.data ?? []} />;
}
