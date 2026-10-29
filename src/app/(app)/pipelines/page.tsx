import { redirect } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { listPipelines } from "@/lib/crm/service";
import { PageHeader } from "@/components/ui";
import { NewPipeline } from "./new-pipeline";

export default async function PipelinesPage() {
  const { supabase } = await requireOwner();
  const pipelines = await listPipelines(supabase);
  if (pipelines.length) redirect(`/pipelines/${pipelines[0].id}`);
  return (
    <div>
      <PageHeader title="Pipelines" />
      <div className="flex flex-col items-center rounded-xl border border-dashed border-line bg-surface/60 px-6 py-12 text-center">
        <p className="font-display text-lg font-bold">Aucun pipeline pour l&apos;instant</p>
        <p className="mt-1 max-w-md text-sm text-muted">
          Créez votre premier pipeline et ses étapes, par exemple « Prospects » (Qualifié, Rendez-vous prévu) ou « Vente » (Proposition, Négociation).
        </p>
        <div className="mt-4"><NewPipeline primary /></div>
      </div>
    </div>
  );
}
