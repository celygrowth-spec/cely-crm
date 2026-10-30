import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getCampaignWorkspace, listSavedViews } from "@/lib/prospection/service";
import { ParticipantsTable } from "./participants-table";

export default async function ProspectsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ vue?: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const { vue } = await searchParams;
  const [ws, views] = await Promise.all([getCampaignWorkspace(supabase, id), listSavedViews(supabase, "participants")]);
  if (!ws) notFound();
  return <ParticipantsTable ws={ws} savedViews={views} initialView={vue ?? "tous"} />;
}
