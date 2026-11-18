import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { PreviewOnboarding } from "@/components/discovery/flow-hosts";
import { CrmError } from "@/lib/crm/service";
import { discoveryPreview } from "@/lib/discovery/service";
import type { DiscoveryView } from "@/lib/discovery/types";

// « Voir comme le client » : même contenu que le portail (discovery_preview), parcours en mémoire, rien n'est écrit.
export default async function DiscoveryPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  let view: DiscoveryView;
  try {
    view = await discoveryPreview(supabase, id);
  } catch (e) {
    if (e instanceof CrmError) notFound();
    throw e;
  }
  return <PreviewOnboarding initial={view} />;
}
