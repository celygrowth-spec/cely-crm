import { requireOwner } from "@/lib/auth";
import { listProjects } from "@/lib/projects/owner";
import { ProjectsView } from "./projects-view";

export default async function ProjetsPage({ searchParams }: { searchParams: Promise<{ archives?: string; nouveau?: string; fiche?: string; client?: string }> }) {
  const sp = await searchParams;
  const { supabase } = await requireOwner();
  const projects = await listProjects(supabase, { archived: sp.archives === "1" });
  // « Préparer l'onboarding » (fiche gagnée) : /projets?nouveau=1&client=<id> ouvre la création avec le client prérempli.
  // (« fiche » est déjà pris : partout dans l'application, ?fiche=<id> ouvre le panneau de la fiche.)
  const fiche = sp.client && /^[0-9a-f-]{36}$/i.test(sp.client)
    ? (await supabase.from("companies").select("id, name").eq("id", sp.client).is("merged_into_id", null).maybeSingle()).data
    : null;
  return <ProjectsView projects={projects} archived={sp.archives === "1"} openCreate={sp.nouveau === "1"} company={fiche ?? undefined} />;
}
