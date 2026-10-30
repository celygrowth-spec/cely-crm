"use server";

// Server actions de la prospection v2 : délèguent à src/lib/prospection/service.ts.
import { run } from "@/lib/action";
import * as p from "@/lib/prospection/service";
import type { CampaignStatus, Outcome } from "@/lib/prospection/service";
import type { SequenceStep } from "@/lib/prospection/steps";
import { todayISO } from "@/lib/format";

export async function createCampaignAction(name: string, templateId: string | null) {
  return run((sb) => p.createCampaignDraft(sb, name, templateId));
}
export async function saveSequenceAction(campaignId: string, steps: SequenceStep[]) {
  return run((sb) => p.saveSequence(sb, campaignId, steps));
}
export async function saveTemplateStepsAction(id: string | null, name: string, steps: SequenceStep[]) {
  return run((sb) => p.saveTemplateSteps(sb, id, name, steps));
}
export async function renameCampaignAction(id: string, name: string, description?: string | null) {
  return run((sb) => p.renameCampaign(sb, id, name, description));
}
export async function setCampaignStatusAction(id: string, status: CampaignStatus) {
  return run((sb) => p.setCampaignStatus(sb, id, status));
}
export async function duplicateCampaignAction(id: string) {
  return run((sb) => p.duplicateCampaign(sb, id));
}
export async function saveCampaignAsTemplateAction(id: string, name: string) {
  return run((sb) => p.saveCampaignAsTemplate(sb, id, name));
}
export async function enrollAction(campaignId: string, companyIds: string[], listIds: string[]) {
  return run((sb) => p.enroll(sb, campaignId, companyIds, listIds));
}
export async function activateAction(campaignId: string, ids: string[], confirmConflicts: boolean) {
  return run((sb) => p.activate(sb, campaignId, ids, confirmConflicts));
}
export async function saveDraftAction(participantId: string, position: number, subject: string | null, body: string | null) {
  return run((sb) => p.saveDraft(sb, participantId, position, subject, body), { revalidate: false });
}
export async function completeStepAction(a: Parameters<typeof p.completeStep>[1]) {
  return run((sb) => p.completeStep(sb, a));
}
export async function skipStepAction(participantId: string, idempotencyKey: string) {
  return run((sb) => p.skipStep(sb, participantId, idempotencyKey));
}
export async function undoActionAction(actionId: string) {
  return run((sb) => p.undoAction(sb, actionId));
}
export async function recordReplyAction(participantId: string, content: string, receivedAt: string | null, personId: string | null) {
  return run((sb) => p.recordReply(sb, participantId, content, receivedAt, personId));
}
export async function setOutcomeAction(participantId: string, outcome: Exclude<Outcome, "none">, stageId?: string | null, note?: string | null) {
  return run((sb) => p.setOutcome(sb, participantId, outcome, stageId, note));
}
export async function setDoNotContactAction(companyId: string, value: boolean, reason?: string | null) {
  return run((sb) => p.setDoNotContact(sb, companyId, value, reason));
}
export async function updateParticipantsAction(
  ids: string[],
  action: "postpone" | "resume" | "stop" | "finish" | "set_person" | "unprepare",
  opts: { due?: string | null; reason?: string | null } = {},
) {
  return run(async (sb) => {
    const errors: string[] = [];
    let ok = 0;
    for (const id of ids) {
      try {
        await p.updateParticipant(sb, id, action, opts);
        ok++;
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    return { ok, errors };
  });
}
export async function getFocusQueueAction(campaignId: string | null) {
  return run((sb) => p.getFocusQueue(sb, { campaignId, today: todayISO() }), { revalidate: false });
}
export async function saveViewAction(v: { id?: string | null; scope: string; name: string; config: Record<string, unknown> }) {
  return run((sb) => p.saveView(sb, v));
}
export async function deleteViewAction(id: string) {
  return run((sb) => p.deleteView(sb, id));
}
export async function setPreferenceAction(key: string, value: unknown) {
  return run((sb) => p.setPreference(sb, key, value), { revalidate: false });
}
