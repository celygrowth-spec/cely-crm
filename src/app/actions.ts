"use server";

// Server actions de l'interface. Elles délèguent à src/lib/crm/service.ts (logique
// partagée avec le connecteur Claude) ou appellent directement les fonctions SQL.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { redirect } from "next/navigation";
import { run } from "@/lib/action";
import { requireOwner } from "@/lib/auth";
import * as crm from "@/lib/crm/service";
import { CrmError } from "@/lib/crm/service";
import type { CompanyInput, CompanyPatch, InteractionInput, PersonInput, TaskInput } from "@/lib/crm/schemas";
import { channelSchema, idSchema } from "@/lib/crm/schemas";

const name = (max = 120) => z.string().trim().min(1, "Le nom est obligatoire").max(max);

function ok<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(crm.friendlyError(res.error));
  return res.data;
}

function v<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}

const rpc = async (sb: SupabaseClient, fn: string, args: Record<string, unknown>) => ok(await sb.rpc(fn, args));

// ---------------------------------------------------------------------------
// Fiches
// ---------------------------------------------------------------------------

export async function getCompanyAction(id: string) {
  return run((sb) => crm.getCompanyDetail(sb, id), { revalidate: false });
}

export async function searchAction(query: string, includeArchived = false) {
  return run((sb) => crm.searchCompanies(sb, query, includeArchived), { revalidate: false });
}

export async function createCompanyAction(
  company: CompanyInput,
  people: PersonInput[],
  opts: { force?: boolean; idempotencyKey?: string; listId?: string | null; stageId?: string | null },
) {
  return run(async (sb) => {
    const res = await crm.createCompany(sb, { company, people }, opts);
    if (res.status === "created") {
      try {
        if (opts.listId) await crm.addToList(sb, opts.listId, [res.id]);
        if (opts.stageId) await crm.moveCompany(sb, res.id, opts.stageId);
      } catch (e) {
        return { ...res, warning: `Fiche créée, mais l'étape suivante a échoué : ${(e as Error).message}` };
      }
    }
    return { ...res, warning: undefined as string | undefined };
  });
}

export async function updateCompanyAction(id: string, patch: CompanyPatch, force = false) {
  return run((sb) => crm.updateCompany(sb, id, patch, force));
}

export async function upsertPersonAction(companyId: string, person: PersonInput, personId?: string, force = false) {
  return run((sb) => crm.upsertPerson(sb, companyId, person, { personId, force }));
}

export async function deletePersonAction(personId: string) {
  return run((sb) => crm.deletePerson(sb, personId));
}

export async function setArchivedAction(ids: string[], archived: boolean) {
  return run((sb) => crm.setArchived(sb, ids, archived));
}

// ---------------------------------------------------------------------------
// Listes
// ---------------------------------------------------------------------------

export async function createListAction(listName: string, description?: string) {
  return run(async (sb) => {
    const n = v(name(), listName);
    return ok(await sb.from("lists").insert({ name: n, description: description?.trim() || null }).select("id").single()) as {
      id: string;
    };
  });
}

export async function renameListAction(id: string, listName: string, description?: string | null) {
  return run(async (sb) => {
    ok(await sb.from("lists").update({ name: v(name(), listName), description: description?.trim() || null }).eq("id", v(idSchema, id)));
  });
}

export async function deleteListAction(id: string) {
  // les fiches ne sont pas supprimées : seules les appartenances le sont
  return run(async (sb) => {
    ok(await sb.from("lists").delete().eq("id", v(idSchema, id)));
  });
}

export async function addToListAction(listId: string, companyIds: string[]) {
  return run((sb) => crm.addToList(sb, listId, companyIds));
}

export async function removeFromListAction(listId: string, companyIds: string[]) {
  return run((sb) => crm.removeFromList(sb, listId, companyIds));
}

// ---------------------------------------------------------------------------
// Historique et tâches
// ---------------------------------------------------------------------------

export async function addInteractionAction(input: InteractionInput, idempotencyKey?: string) {
  return run((sb) => crm.addInteraction(sb, input, idempotencyKey));
}

export async function createTaskAction(input: TaskInput) {
  return run((sb) => crm.createTask(sb, input));
}

export async function postponeTaskAction(taskId: string, dueDate: string) {
  return run((sb) => crm.postponeTask(sb, taskId, dueDate));
}

export async function setTaskDoneAction(taskId: string, done: boolean) {
  return run((sb) => crm.setTaskDone(sb, taskId, done));
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export async function moveCompanyAction(companyId: string, stageId: string | null, stopFollowups = true) {
  return run((sb) => crm.moveCompany(sb, companyId, stageId, { stopFollowups }));
}

export async function setDealStatusAction(companyId: string, status: "open" | "won" | "lost", lostReason?: string) {
  return run((sb) => crm.setDealStatus(sb, companyId, status, lostReason));
}

export async function createPipelineAction(pipelineName: string, stageNames: string[]) {
  return run(async (sb) => {
    const n = v(name(80), pipelineName);
    const stages = stageNames.map((s) => s.trim()).filter(Boolean);
    if (!stages.length) throw new CrmError("Ajoutez au moins une étape.");
    stages.forEach((s) => v(name(80), s));
    const { count } = await sb.from("pipelines").select("id", { count: "exact", head: true });
    const p = ok(await sb.from("pipelines").insert({ name: n, position: count ?? 0 }).select("id").single()) as { id: string };
    const ins = await sb.from("stages").insert(stages.map((s, i) => ({ pipeline_id: p.id, name: s, position: i })));
    if (ins.error) {
      await sb.from("pipelines").delete().eq("id", p.id);
      throw new CrmError(crm.friendlyError(ins.error));
    }
    return p;
  });
}

export async function renamePipelineAction(id: string, pipelineName: string) {
  return run(async (sb) => {
    ok(await sb.from("pipelines").update({ name: v(name(80), pipelineName) }).eq("id", v(idSchema, id)));
  });
}

export async function deletePipelineAction(id: string, replacementStageId: string | null) {
  return run((sb) => rpc(sb, "delete_pipeline", { p_pipeline: id, p_replacement_stage: replacementStageId }));
}

export async function createStageAction(pipelineId: string, stageName: string) {
  return run(async (sb) => {
    const { data } = await sb.from("stages").select("position").eq("pipeline_id", pipelineId).order("position", { ascending: false }).limit(1);
    ok(await sb.from("stages").insert({ pipeline_id: v(idSchema, pipelineId), name: v(name(80), stageName), position: (data?.[0]?.position ?? -1) + 1 }));
  });
}

export async function renameStageAction(id: string, stageName: string) {
  return run(async (sb) => {
    ok(await sb.from("stages").update({ name: v(name(80), stageName) }).eq("id", v(idSchema, id)));
  });
}

export async function reorderStagesAction(pipelineId: string, stageIds: string[]) {
  return run((sb) => rpc(sb, "reorder_stages", { p_pipeline: pipelineId, p_stage_ids: stageIds }));
}

export async function deleteStageAction(id: string, replacementId: string | null) {
  return run((sb) => rpc(sb, "delete_stage", { p_stage: id, p_replacement: replacementId }));
}

// ---------------------------------------------------------------------------
// Sources du lead
// ---------------------------------------------------------------------------

export async function createSourceAction(sourceName: string) {
  return run(async (sb) => {
    const { count } = await sb.from("lead_sources").select("id", { count: "exact", head: true });
    ok(await sb.from("lead_sources").insert({ name: v(name(80), sourceName), position: (count ?? 0) + 1 }));
  });
}

export async function renameSourceAction(id: string, sourceName: string) {
  return run(async (sb) => {
    ok(await sb.from("lead_sources").update({ name: v(name(80), sourceName) }).eq("id", v(idSchema, id)));
  });
}

export async function deleteSourceAction(id: string) {
  // les fiches qui utilisaient cette source la perdent (champ vidé), elles ne sont pas supprimées
  return run(async (sb) => {
    ok(await sb.from("lead_sources").delete().eq("id", v(idSchema, id)));
  });
}

// ---------------------------------------------------------------------------
// Modèles et campagnes
// ---------------------------------------------------------------------------

const stepSchema = z.object({
  name: z.string().trim().min(1, "Chaque étape doit avoir un nom").max(120),
  channel: channelSchema,
  delay_days: z.number().int().min(0).max(365),
  message: z.string().max(5000).nullable().optional(),
});

export async function saveTemplateAction(id: string | null, templateName: string, steps: z.input<typeof stepSchema>[]) {
  return run(async (sb) => {
    const parsed = steps.map((s) => v(stepSchema, s));
    return (await rpc(sb, "save_template", { p_id: id, p_name: v(name(), templateName), p_steps: parsed })) as string;
  });
}

export async function duplicateTemplateAction(id: string) {
  return run(async (sb) => (await rpc(sb, "duplicate_template", { p_id: id })) as string);
}

export async function deleteTemplateAction(id: string) {
  // les campagnes déjà lancées gardent leur copie des étapes
  return run(async (sb) => {
    ok(await sb.from("templates").delete().eq("id", v(idSchema, id)));
  });
}

export async function createCampaignAction(campaignName: string, templateId: string, listIds: string[]) {
  return run(
    async (sb) =>
      (await rpc(sb, "create_campaign", { p_name: campaignName, p_template: templateId, p_list_ids: listIds })) as {
        id: string;
        added?: number;
        already_present?: number;
      },
  );
}

export async function addListsToCampaignAction(campaignId: string, listIds: string[]) {
  return run(
    async (sb) => (await rpc(sb, "add_lists_to_campaign", { p_campaign: campaignId, p_list_ids: listIds })) as { added: number; already_present: number },
  );
}

export async function addCompaniesToCampaignAction(campaignId: string, companyIds: string[]) {
  return run(
    async (sb) =>
      (await rpc(sb, "add_companies_to_campaign", { p_campaign: campaignId, p_company_ids: companyIds })) as { added: number; already_present: number },
  );
}

export async function archiveCampaignAction(id: string, archived: boolean) {
  return run(async (sb) => {
    ok(await sb.from("campaigns").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", v(idSchema, id)));
  });
}

export async function markStepSentAction(participantId: string, content: string, sentAt: string | null, personId: string | null, idempotencyKey: string) {
  return run((sb) => crm.markStepSent(sb, participantId, content, sentAt, personId, idempotencyKey));
}

export async function recordReplyAction(participantId: string, content: string, receivedAt: string | null) {
  return run((sb) => crm.recordReply(sb, participantId, content, receivedAt));
}

export async function updateParticipantAction(
  participantId: string,
  action: "postpone" | "resume" | "stop" | "finish" | "set_person",
  opts: { due?: string | null; reason?: string | null } = {},
) {
  return run((sb) => crm.updateParticipant(sb, participantId, action, opts));
}

// ---------------------------------------------------------------------------
// Doublons, fusion, import
// ---------------------------------------------------------------------------

export async function dismissDuplicateAction(a: string, b: string) {
  return run(async (sb) => {
    const [x, y] = [v(idSchema, a), v(idSchema, b)].sort();
    ok(await sb.from("duplicate_dismissals").upsert({ company_a: x, company_b: y }, { ignoreDuplicates: true }));
  });
}

export async function mergeCompaniesAction(keepId: string, mergeId: string, fields: Record<string, "keep" | "merged">, pipelineFrom: "keep" | "merged") {
  return run(
    async (sb) =>
      (await rpc(sb, "merge_companies", { p_keep: keepId, p_merge: mergeId, p_fields: fields, p_pipeline_from: pipelineFrom })) as {
        kept_id: string;
        people_moved: number;
        campaign_conflicts: number;
      },
  );
}

export type ImportCheckGroup = {
  key: string;
  name: string;
  website: string | null;
  emails: string[];
  linkedins: string[];
  person_names: string[];
  row_hashes: string[];
};

export async function importCheckAction(groups: ImportCheckGroup[]) {
  return run(
    async (sb) => {
      if (groups.length > 5000) throw new CrmError("Fichier trop volumineux (5 000 entreprises maximum par import).");
      return (await rpc(sb, "import_check", { p_groups: groups })) as {
        key: string;
        candidates: { company_id: string; name: string; website: string | null; strength: "exact" | "similar"; reasons: string[] }[];
        already_imported_company_ids: string[];
      }[];
    },
    { revalidate: false },
  );
}

export async function importCommitAction(idempotencyKey: string, filename: string, groups: unknown[], listId: string | null) {
  return run(
    async (sb) =>
      (await rpc(sb, "import_commit", { p_idempotency_key: idempotencyKey, p_filename: filename, p_groups: groups, p_list_id: listId })) as {
        created: number;
        completed: number;
        skipped: number;
        people: number;
        replayed?: boolean;
        errors: { rows: number[]; message: string }[];
      },
  );
}

export async function signOutAction() {
  const { supabase } = await requireOwner();
  await supabase.auth.signOut();
  redirect("/login");
}
