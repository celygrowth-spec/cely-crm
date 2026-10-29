import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { fetchAll, listPipelines } from "@/lib/crm/service";
import type { CompanyOverview } from "@/lib/crm/types";
import { Kanban } from "./kanban";

export default async function PipelinePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ statut?: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const { statut } = await searchParams;
  const dealStatus = statut === "won" || statut === "lost" ? statut : "open";
  const pipelines = await listPipelines(supabase);
  const pipeline = pipelines.find((p) => p.id === id);
  if (!pipeline) notFound();
  const { data, error } = await fetchAll<CompanyOverview>((from, to) =>
    supabase
      .from("company_overview")
      .select("*")
      .eq("pipeline_id", id)
      .eq("deal_status", dealStatus)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .range(from, to),
  );
  if (error) return <p className="text-danger">{error}</p>;
  return <Kanban pipeline={pipeline} pipelines={pipelines} cards={data} dealStatus={dealStatus} />;
}
