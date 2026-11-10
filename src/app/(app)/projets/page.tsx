import { requireOwner } from "@/lib/auth";
import { listProjects, onboardingStatuses } from "@/lib/projects/owner";
import { ProjectsView } from "./projects-view";

export default async function ProjetsPage({ searchParams }: { searchParams: Promise<{ archives?: string; nouveau?: string; fiche?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const [projects, onboarding] = await Promise.all([listProjects(supabase, { archived: sp.archives === "1" }), onboardingStatuses(supabase)]);
  return <ProjectsView projects={projects} onboarding={onboarding} archived={sp.archives === "1"} openCreate={sp.nouveau === "1"} />;
}
