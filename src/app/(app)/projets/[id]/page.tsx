import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getProject } from "@/lib/projects/owner";
import { OnboardingGenerator } from "@/components/projects/onboarding-generator";
import { OnboardingPanel } from "@/components/projects/onboarding-panel";
import { signedProposalOf } from "@/lib/onboarding-generator/context";
import { ProjectGeneral } from "./general";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  // « Générer l'onboarding » apparaît une fois la proposition signée (ou si un dossier existe déjà)
  const [signed, dossier, people] = await Promise.all([
    signedProposalOf(supabase, p.company_id),
    supabase.from("generator_dossiers").select("id").eq("project_id", p.id).eq("kind", "onboarding").limit(1),
    supabase.from("people").select("id, first_name, last_name, title, email").eq("company_id", p.company_id).order("is_primary", { ascending: false }),
  ]);
  return (
    <>
      <OnboardingPanel projectId={p.id} />
      {(signed || dossier.data?.length) && (
        <OnboardingGenerator projectId={p.id} companyId={p.company_id} people={people.data ?? []} signedVersion={signed?.version ?? null} older={!!signed && signed.version < signed.latest_version} />
      )}
      <ProjectGeneral key={p.updated_at} project={p} />
    </>
  );
}
