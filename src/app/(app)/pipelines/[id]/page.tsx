import { requireOwner } from "@/lib/auth";
import { Kanban } from "./kanban";

// Coquille instantanée : les pipelines viennent de la mise en page, les cartes du cache client.
export default async function PipelinePage({ params }: { params: Promise<{ id: string }> }) {
  await requireOwner();
  const { id } = await params;
  return <Kanban pipelineId={id} />;
}
