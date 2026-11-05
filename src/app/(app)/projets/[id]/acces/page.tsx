import { requireOwner } from "@/lib/auth";
import { companyPeople, getProject, projectMembers } from "@/lib/projects/owner";
import { notFound } from "next/navigation";
import { AccessView } from "./access-view";

export default async function AccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase } = await requireOwner();
  const p = await getProject(supabase, id);
  if (!p) notFound();
  const [members, people] = await Promise.all([projectMembers(supabase, id), companyPeople(supabase, p.company_id)]);
  return <AccessView project={p} members={members} candidates={people.filter((x) => !members.some((m) => m.person_id === x.id))} />;
}
