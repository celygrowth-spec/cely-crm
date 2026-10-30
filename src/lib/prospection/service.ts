// Services métier de la prospection v2. Utilisés par les server actions et, à terme, par le
// connecteur Claude. Les règles fortes (versions, activation, exécution, annulation) sont en SQL.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import type { Interaction, Person } from "@/lib/crm/types";
import { STEP_TYPES, type SequenceStep, type StepType } from "./steps";

type PgError = { message: string; code?: string };
function check<T>(res: { data: T; error: PgError | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}
const uuid = z.uuid("Identifiant invalide");
const rpc = async <T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>) => check(await sb.rpc(fn, args)) as T;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CampaignStatus = "draft" | "active" | "paused" | "finished" | "archived";
export type ParticipantStatus = "a_preparer" | "a_contacter" | "en_cours" | "a_repondu" | "termine" | "arrete";
export type Outcome = "none" | "replied" | "interested" | "not_interested" | "meeting" | "do_not_contact";

export type CampaignOverview = {
  id: string;
  name: string;
  status: CampaignStatus;
  current_version: number;
  template_name: string | null;
  created_at: string;
  updated_at: string;
  channels: string[];
  step_count: number;
  enrolled: number;
  to_prepare: number;
  in_progress: number;
  due_today: number;
  overdue: number;
  contacted: number;
  replied: number;
  interested: number;
  meetings: number;
  not_interested: number;
  moved_to_pipeline: number;
  finished: number;
  stopped: number;
  last_activity_at: string | null;
};

export type CampaignStep = SequenceStep & { id: string; position: number; version: number; channel: string };

export type ParticipantRow = {
  id: string;
  company_id: string;
  person_id: string | null;
  status: ParticipantStatus;
  outcome: Outcome;
  current_step: number;
  sequence_version: number;
  next_due_date: string | null;
  last_done_at: string | null;
  activated_at: string | null;
  stop_reason: string | null;
  moved_to_pipeline_at: string | null;
  created_at: string;
  company: {
    id: string;
    name: string;
    website: string | null;
    domain_norm: string | null;
    do_not_contact: boolean;
    pipeline_id: string | null;
    stage_id: string | null;
    last_interaction_at: string | null;
    prospect_status: string;
  };
};

export type Draft = { participant_id: string; sequence_version: number; step_position: number; subject: string | null; body: string | null; updated_at: string };
export type Conflict = {
  participant_id: string;
  company_id: string;
  other_participant_id: string;
  other_campaign_id: string;
  other_campaign_name: string;
  other_status: string;
  other_last_done_at: string | null;
  other_person_id: string | null;
};
export type LastInteraction = { campaign_participant_id: string; kind: string; content: string | null; occurred_at: string; meta: Record<string, unknown> };

export type CampaignWorkspace = {
  campaign: CampaignOverview & { description: string | null };
  steps: CampaignStep[]; // toutes versions utiles (courante + celles encore suivies)
  participants: ParticipantRow[];
  people: Person[];
  drafts: Draft[];
  conflicts: Conflict[];
  lastInteractions: LastInteraction[];
};

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

export async function listCampaigns(sb: SupabaseClient): Promise<CampaignOverview[]> {
  return check(await sb.from("campaign_overview").select("*").order("updated_at", { ascending: false })) as CampaignOverview[];
}

const PARTICIPANT_SELECT =
  "id, company_id, person_id, status, outcome, current_step, sequence_version, next_due_date, last_done_at, activated_at, stop_reason, moved_to_pipeline_at, created_at, company:companies!inner(id, name, website, domain_norm, do_not_contact, pipeline_id, stage_id, last_interaction_at, prospect_status)";

/** Toutes les données d'une campagne en quelques requêtes groupées (aucune requête par ligne). */
export async function getCampaignWorkspace(sb: SupabaseClient, id: string): Promise<CampaignWorkspace | null> {
  uuid.parse(id);
  const [ov, base] = await Promise.all([
    sb.from("campaign_overview").select("*").eq("id", id).maybeSingle(),
    sb.from("campaigns").select("description").eq("id", id).maybeSingle(),
  ]);
  const overview = check(ov) as CampaignOverview | null;
  if (!overview) return null;
  const [steps, participants, conflicts] = await Promise.all([
    sb.from("campaign_steps").select("id, position, version, name, step_type, channel, delay_days, subject, message, instructions").eq("campaign_id", id).order("version").order("position"),
    sb.from("campaign_participants").select(PARTICIPANT_SELECT).eq("campaign_id", id).order("created_at").limit(5000),
    sb.rpc("campaign_conflicts", { p_campaign: id }),
  ]);
  const parts = check(participants) as unknown as ParticipantRow[];
  const companyIds = [...new Set(parts.map((p) => p.company_id))];
  const partIds = parts.map((p) => p.id);
  const chunks = <T,>(arr: T[], n = 300) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

  const people: Person[] = [];
  const drafts: Draft[] = [];
  const lastInteractions: LastInteraction[] = [];
  for (const ids of chunks(companyIds)) people.push(...(check(await sb.from("people").select("*").in("company_id", ids)) as Person[]));
  for (const ids of chunks(partIds)) {
    const [d, li] = await Promise.all([
      sb.from("participant_drafts").select("*").in("participant_id", ids),
      sb.from("interactions").select("campaign_participant_id, kind, content, occurred_at, meta").in("campaign_participant_id", ids).order("occurred_at", { ascending: false }),
    ]);
    drafts.push(...(check(d) as Draft[]));
    const seen = new Set(lastInteractions.map((x) => x.campaign_participant_id));
    for (const row of check(li) as LastInteraction[]) {
      if (!seen.has(row.campaign_participant_id)) {
        seen.add(row.campaign_participant_id);
        lastInteractions.push(row);
      }
    }
  }
  const versions = new Set([overview.current_version, ...parts.map((p) => p.sequence_version)]);
  return {
    campaign: { ...overview, description: (check(base) as { description: string | null } | null)?.description ?? null },
    steps: (check(steps) as CampaignStep[]).filter((s) => versions.has(s.version)),
    participants: parts,
    people,
    drafts,
    conflicts: (check(conflicts) as Conflict[]) ?? [],
    lastInteractions,
  };
}

export type FocusItem = {
  participant: ParticipantRow;
  campaign: { id: string; name: string };
  step: CampaignStep;
  stepCount: number;
  people: Person[];
  draft: Draft | null;
  recent: Interaction[];
  otherCampaigns: { campaign_name: string; status: string; current_step: number; next_due_date: string | null }[];
  pipelineLabel: string | null;
};

/** File de la session : étapes dues (aujourd'hui et en retard) des campagnes actives. */
export async function getFocusQueue(sb: SupabaseClient, opts: { campaignId?: string | null; includeUpcoming?: boolean; today: string }): Promise<FocusItem[]> {
  let q = sb
    .from("todo_items")
    .select("id, campaign_id, campaign_name, due_date, sequence_version, step_position, step_count")
    .eq("item_type", "followup")
    .order("due_date")
    .order("company_name")
    .limit(500);
  if (!opts.includeUpcoming) q = q.lte("due_date", opts.today);
  if (opts.campaignId) q = q.eq("campaign_id", opts.campaignId);
  const todo = check(await q) as { id: string; campaign_id: string; campaign_name: string; step_count: number }[];
  if (!todo.length) return [];
  const ids = todo.map((t) => t.id);
  const parts = check(await sb.from("campaign_participants").select(PARTICIPANT_SELECT).in("id", ids)) as unknown as ParticipantRow[];
  const byId = new Map(parts.map((p) => [p.id, p]));
  const companyIds = [...new Set(parts.map((p) => p.company_id))];
  const campaignIds = [...new Set(todo.map((t) => t.campaign_id))];
  const [steps, people, drafts, recent, others, stages] = await Promise.all([
    sb.from("campaign_steps").select("id, position, version, name, step_type, channel, delay_days, subject, message, instructions, campaign_id").in("campaign_id", campaignIds),
    sb.from("people").select("*").in("company_id", companyIds),
    sb.from("participant_drafts").select("*").in("participant_id", ids),
    sb.from("interactions").select("*").in("company_id", companyIds).order("occurred_at", { ascending: false }).limit(Math.min(companyIds.length * 12, 2000)),
    sb.from("campaign_participants").select("id, company_id, status, current_step, next_due_date, campaign:campaigns!inner(name, status)").in("company_id", companyIds).in("status", ["a_contacter", "en_cours", "a_repondu"]),
    sb.from("stages").select("id, name, pipeline:pipelines(name)"),
  ]);
  const stepRows = check(steps) as (CampaignStep & { campaign_id: string })[];
  const peopleRows = check(people) as Person[];
  const draftRows = check(drafts) as Draft[];
  const recentRows = check(recent) as Interaction[];
  const otherRows = check(others) as unknown as { id: string; company_id: string; status: string; current_step: number; next_due_date: string | null; campaign: { name: string; status: string } }[];
  const stageRows = check(stages) as unknown as { id: string; name: string; pipeline: { name: string } | null }[];

  return todo
    .map((t): FocusItem | null => {
      const p = byId.get(t.id);
      if (!p) return null;
      const step = stepRows.find((s) => s.campaign_id === t.campaign_id && s.version === p.sequence_version && s.position === p.current_step);
      if (!step) return null;
      const stage = stageRows.find((s) => s.id === p.company.stage_id);
      return {
        participant: p,
        campaign: { id: t.campaign_id, name: t.campaign_name },
        step,
        stepCount: t.step_count,
        people: peopleRows.filter((x) => x.company_id === p.company_id),
        draft: draftRows.find((d) => d.participant_id === p.id && d.sequence_version === p.sequence_version && d.step_position === p.current_step) ?? null,
        recent: recentRows.filter((r) => r.company_id === p.company_id).slice(0, 12),
        otherCampaigns: otherRows
          .filter((o) => o.company_id === p.company_id && o.id !== p.id)
          .map((o) => ({ campaign_name: o.campaign.name, status: o.status, current_step: o.current_step, next_due_date: o.next_due_date })),
        pipelineLabel: stage ? `${stage.pipeline?.name ?? ""} › ${stage.name}` : null,
      };
    })
    .filter((x): x is FocusItem => x !== null);
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

export const sequenceStepSchema = z.object({
  name: z.string().trim().min(1, "Chaque étape doit avoir un titre").max(120),
  step_type: z.enum(STEP_TYPES),
  delay_days: z.number().int().min(0).max(365),
  subject: z.string().max(300).nullable().optional(),
  message: z.string().max(5000).nullable().optional(),
  instructions: z.string().max(2000).nullable().optional(),
});

function parseSteps(steps: SequenceStep[]) {
  const r = z.array(sequenceStepSchema).min(1, "Ajoutez au moins une étape").max(30).safeParse(steps);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}

export const createCampaignDraft = (sb: SupabaseClient, name: string, templateId?: string | null) =>
  rpc<string>(sb, "create_campaign_draft", { p_name: name.slice(0, 120), p_template: templateId ?? null });

export const saveSequence = (sb: SupabaseClient, campaignId: string, steps: SequenceStep[]) =>
  rpc<{ version: number; new_version: boolean; kept_on_previous?: number }>(sb, "save_campaign_sequence", { p_campaign: uuid.parse(campaignId), p_steps: parseSteps(steps) });

export const saveTemplateSteps = (sb: SupabaseClient, id: string | null, name: string, steps: SequenceStep[]) =>
  rpc<string>(sb, "save_template", { p_id: id, p_name: name, p_steps: parseSteps(steps) });

export async function renameCampaign(sb: SupabaseClient, id: string, name: string, description?: string | null) {
  const n = name.trim();
  if (!n || n.length > 120) throw new CrmError("Nom de campagne invalide (1 à 120 caractères).");
  check(await sb.from("campaigns").update({ name: n, description: description?.trim() || null }).eq("id", uuid.parse(id)));
}

export const setCampaignStatus = (sb: SupabaseClient, id: string, status: CampaignStatus) =>
  rpc<null>(sb, "set_campaign_status", { p_campaign: uuid.parse(id), p_status: status });
export const duplicateCampaign = (sb: SupabaseClient, id: string) => rpc<string>(sb, "duplicate_campaign", { p_campaign: uuid.parse(id) });
export const saveCampaignAsTemplate = (sb: SupabaseClient, id: string, name: string) =>
  rpc<string>(sb, "save_campaign_as_template", { p_campaign: uuid.parse(id), p_name: name });

export const enroll = (sb: SupabaseClient, campaignId: string, companyIds: string[], listIds: string[]) =>
  rpc<{ added: number; blocked: number; already_present: number }>(sb, "enroll_in_campaign", {
    p_campaign: uuid.parse(campaignId),
    p_company_ids: companyIds.map((x) => uuid.parse(x)),
    p_list_ids: listIds.map((x) => uuid.parse(x)),
  });

export type ActivationResult =
  | { status: "activated"; activated: number; blocked: number; conflicts_confirmed: number }
  | { status: "conflicts"; conflicts: (Conflict & { company_name: string })[] };

export const activate = (sb: SupabaseClient, campaignId: string, ids: string[], confirmConflicts: boolean) =>
  rpc<ActivationResult>(sb, "activate_participants", {
    p_campaign: uuid.parse(campaignId),
    p_ids: ids.map((x) => uuid.parse(x)),
    p_confirm_conflicts: confirmConflicts,
  });

export const saveDraft = (sb: SupabaseClient, participantId: string, position: number, subject: string | null, body: string | null) =>
  rpc<null>(sb, "save_participant_draft", { p_participant: uuid.parse(participantId), p_position: position, p_subject: subject, p_body: body });

export type CompleteResult = { status: "done"; action_id: string; finished: boolean; next_due_date: string | null; next_step: number | null };
export const completeStep = (
  sb: SupabaseClient,
  a: { participantId: string; content?: string | null; subject?: string | null; doneAt?: string | null; personId?: string | null; idempotencyKey: string },
) =>
  rpc<CompleteResult>(sb, "complete_step", {
    p_participant: uuid.parse(a.participantId),
    p_content: a.content ?? null,
    p_subject: a.subject ?? null,
    p_done_at: a.doneAt ?? null,
    p_person: a.personId ?? null,
    p_idempotency_key: a.idempotencyKey,
  });

export const skipStep = (sb: SupabaseClient, participantId: string, idempotencyKey: string) =>
  rpc<{ action_id: string; finished: boolean }>(sb, "skip_step", { p_participant: uuid.parse(participantId), p_idempotency_key: idempotencyKey });
export const undoAction = (sb: SupabaseClient, actionId: string) => rpc<{ status: string }>(sb, "undo_participant_action", { p_action: uuid.parse(actionId) });
export const recordReply = (sb: SupabaseClient, participantId: string, content: string, receivedAt: string | null, personId: string | null) => {
  if (!content.trim()) throw new CrmError("Le contenu de la réponse est obligatoire.");
  return rpc<{ paused_followups: number }>(sb, "record_reply", { p_participant: uuid.parse(participantId), p_content: content, p_received_at: receivedAt, p_person: personId });
};
export const setOutcome = (sb: SupabaseClient, participantId: string, outcome: Exclude<Outcome, "none">, stageId?: string | null, note?: string | null) =>
  rpc<{ stopped: number; moved: boolean }>(sb, "set_participant_outcome", { p_participant: uuid.parse(participantId), p_outcome: outcome, p_stage: stageId ?? null, p_note: note ?? null });
export const setDoNotContact = (sb: SupabaseClient, companyId: string, value: boolean, reason?: string | null) =>
  rpc<null>(sb, "set_do_not_contact", { p_company: uuid.parse(companyId), p_value: value, p_reason: reason ?? null });
export const updateParticipant = (sb: SupabaseClient, id: string, action: "postpone" | "resume" | "stop" | "finish" | "set_person" | "unprepare", opts: { due?: string | null; reason?: string | null } = {}) =>
  rpc<{ status: string }>(sb, "update_participant", { p_participant: uuid.parse(id), p_action: action, p_due: opts.due ?? null, p_reason: opts.reason ?? null });

// ---------------------------------------------------------------------------
// Vues enregistrées et préférences
// ---------------------------------------------------------------------------

export type SavedView = { id: string; scope: string; name: string; config: Record<string, unknown>; position: number };

export async function listSavedViews(sb: SupabaseClient, scope: string): Promise<SavedView[]> {
  return check(await sb.from("saved_views").select("*").eq("scope", scope).order("position").order("created_at")) as SavedView[];
}
export async function saveView(sb: SupabaseClient, v: { id?: string | null; scope: string; name: string; config: Record<string, unknown> }) {
  const name = v.name.trim();
  if (!name) throw new CrmError("Nom de vue obligatoire.");
  if (v.id) return check(await sb.from("saved_views").update({ name, config: v.config }).eq("id", uuid.parse(v.id)).select("id").single()) as { id: string };
  return check(await sb.from("saved_views").insert({ scope: v.scope, name, config: v.config }).select("id").single()) as { id: string };
}
export async function deleteView(sb: SupabaseClient, id: string) {
  check(await sb.from("saved_views").delete().eq("id", uuid.parse(id)));
}
export async function getPreference<T>(sb: SupabaseClient, key: string): Promise<T | null> {
  const r = check(await sb.from("user_preferences").select("value").eq("key", key).maybeSingle()) as { value: T } | null;
  return r?.value ?? null;
}
export async function setPreference(sb: SupabaseClient, key: string, value: unknown) {
  check(await sb.from("user_preferences").upsert({ key, value }));
}

export type { StepType };
