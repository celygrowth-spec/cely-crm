import { notFound } from "next/navigation";
import { requireOwner } from "@/lib/auth";
import { getCampaignWorkspace } from "@/lib/prospection/service";
import { contactsForPreview } from "@/lib/prospection/workspace";
import { CampaignSequence } from "./campaign-sequence";

export default async function SequencePage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireOwner();
  const { id } = await params;
  const ws = await getCampaignWorkspace(supabase, id);
  if (!ws) notFound();
  const v = ws.campaign.current_version;
  const steps = ws.steps.filter((s) => s.version === v).sort((a, b) => a.position - b.position);
  const started = ws.participants.filter((p) => p.sequence_version === v && p.status !== "a_preparer").length;
  const versions = [...new Set(ws.participants.filter((p) => p.status !== "a_preparer").map((p) => p.sequence_version))].sort();
  return (
    <CampaignSequence
      campaignId={id}
      name={ws.campaign.name}
      status={ws.campaign.status}
      version={v}
      versionsInUse={versions}
      steps={steps.map((s) => ({ name: s.name, step_type: s.step_type, delay_days: s.delay_days, subject: s.subject, message: s.message, instructions: s.instructions }))}
      started={started}
      contacts={contactsForPreview(ws)}
    />
  );
}
