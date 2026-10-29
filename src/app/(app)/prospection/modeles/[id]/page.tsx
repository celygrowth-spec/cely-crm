import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import type { CampaignStep } from "@/lib/crm/types";
import { TemplateEditor } from "./template-editor";

export default async function ModelePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  if (id === "nouveau") return <TemplateEditor id={null} initialName="" initialSteps={[]} />;
  const { data } = await supabase.from("templates").select("id, name, template_steps(position, name, channel, delay_days, message)").eq("id", id).maybeSingle();
  if (!data) notFound();
  const steps = [...(data.template_steps as CampaignStep[])].sort((a, b) => a.position - b.position);
  return <TemplateEditor id={data.id} initialName={data.name} initialSteps={steps} />;
}
