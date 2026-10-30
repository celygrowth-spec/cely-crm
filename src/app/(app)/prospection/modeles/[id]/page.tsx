import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import type { SequenceStep } from "@/lib/prospection/steps";
import { TemplateEditor } from "./template-editor";

export default async function ModelePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  if (id === "nouveau") return <TemplateEditor id={null} name="Nouveau modèle" steps={[]} />;
  const { data } = await supabase
    .from("templates")
    .select("id, name, template_steps(position, name, step_type, delay_days, subject, message, instructions)")
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const steps = [...(data.template_steps as (SequenceStep & { position: number })[])].sort((a, b) => a.position - b.position);
  return <TemplateEditor id={data.id} name={data.name} steps={steps.map((s) => ({ name: s.name, step_type: s.step_type, delay_days: s.delay_days, subject: s.subject, message: s.message, instructions: s.instructions }))} />;
}
