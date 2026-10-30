import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getCampaignWorkspace } from "@/lib/prospection/service";
import { Preparation } from "./preparation";

export default async function PreparationPage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const ws = await getCampaignWorkspace(supabase, id);
  if (!ws) notFound();
  return <Preparation ws={ws} />;
}
