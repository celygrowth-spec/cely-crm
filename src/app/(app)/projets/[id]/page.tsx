import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getProject } from "@/lib/projects/owner";
import { ProjectGeneral } from "./general";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  return <ProjectGeneral key={p.updated_at} project={p} />;
}
