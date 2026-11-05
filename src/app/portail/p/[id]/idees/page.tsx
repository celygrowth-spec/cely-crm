import { portalLoad } from "@/lib/projects/portal-load";
import type { Idea, PortalProjectView } from "@/lib/projects/types";
import { PortalIdeas } from "@/components/portal/ideas";

export default async function PortalIdeasPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [ideas, project] = await Promise.all([portalLoad<Idea[]>("portal_ideas", { p_project: id }), portalLoad<PortalProjectView>("portal_project", { p_project: id })]);
  return (
    <div>
      <h1 className="mb-4 font-display text-2xl font-bold text-ink">Boîte à idées</h1>
      <PortalIdeas projectId={id} ideas={ideas} readOnly={project.read_only} />
    </div>
  );
}
