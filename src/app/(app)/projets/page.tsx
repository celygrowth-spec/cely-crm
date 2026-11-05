import { requireOwner } from "@/lib/auth";
import { listProjects } from "@/lib/projects/owner";
import { ProjectsView } from "./projects-view";

export default async function ProjetsPage({ searchParams }: { searchParams: Promise<{ archives?: string; nouveau?: string; fiche?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const projects = await listProjects(supabase, { archived: sp.archives === "1" });
  return <ProjectsView projects={projects} archived={sp.archives === "1"} openCreate={sp.nouveau === "1"} />;
}
