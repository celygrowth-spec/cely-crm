import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getProject, projectPlanning } from "@/lib/projects/owner";
import { PlanningEditor } from "./planning-editor";

export default async function PlanningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  const plan = await projectPlanning(supabase, id);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(new Date());
  return <PlanningEditor key={p.updated_at + plan.phases.length} project={p} initial={plan} today={today} />;
}
