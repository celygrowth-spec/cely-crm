import type { PortalProject } from "@/lib/projects/types";
import { portalLoad } from "@/lib/projects/portal-load";
import { PortalOverview } from "@/components/portal/overview";

export default async function PortalProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await portalLoad<PortalProject>("portal_project", { p_project: id });
  return <PortalOverview project={project} />;
}
