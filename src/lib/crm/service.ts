// Logique métier centralisée : utilisée par les server actions de l'interface ET par
// le connecteur MCP. Chaque fonction reçoit un client Supabase déjà authentifié ;
// les règles fortes (doublons, transactions, droits) sont appliquées en base.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  companyPatchSchema,
  companySchema,
  dateSchema,
  idSchema,
  interactionSchema,
  personSchema,
  taskSchema,
  type CompanyInput,
  type CompanyPatch,
  type InteractionInput,
  type PersonInput,
  type TaskInput,
} from "./schemas";
import type {
  CompanyCore,
  CompanyDetail,
  CompanyTimeline,
  DuplicateCandidate,
  PipelineWithStages,
  SearchResult,
  TodoItem,
} from "./types";

export class CrmError extends Error {}

type PgError = { message: string; code?: string; details?: string | null };

export function friendlyError(error: PgError): string {
  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message)) {
    return error.message.includes("Claude") ? error.message : "Accès refusé.";
  }
  if (error.code === "23503") return "Opération impossible : cet élément est encore utilisé ailleurs.";
  if (error.code === "23505") return "Cet élément existe déjà.";
  if (/fetch failed|network/i.test(error.message)) return "Impossible de joindre la base de données. Réessayez.";
  return error.message;
}

function check<T>(res: { data: T; error: PgError | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}

export type WriteResult =
  | { status: "created" | "saved" | "updated"; id: string }
  | { status: "duplicates"; candidates: DuplicateCandidate[] };

// ---------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------

/** Lit toutes les lignes par pages de 1 000 (limite par défaut de l'API Supabase). */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: PgError | null }>,
): Promise<{ data: T[]; error: string | null }> {
  const size = 1000;
  const out: T[] = [];
  for (let from = 0; from < 50000; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) return { data: out, error: friendlyError(error) };
    out.push(...((data ?? []) as T[]));
    if (!data || data.length < size) break;
  }
  return { data: out, error: null };
}

export async function searchCompanies(sb: SupabaseClient, query: string, includeArchived = false): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  return check(
    await sb.rpc("search_companies", { p_query: q.slice(0, 200), p_include_archived: includeArchived, p_limit: 20 }),
  ) as SearchResult[];
}

/** Partie légère de la fiche : sans l'historique, chargé à part pour ne pas retarder l'ouverture. */
export async function getCompanyCore(sb: SupabaseClient, id: string): Promise<CompanyCore | null> {
  parse(idSchema, id);
  const [companyRes, people, tasks, participants, lists] = await Promise.all([
    sb
      .from("companies")
      .select("*, source:lead_sources(id,name,color), pipeline:pipelines(id,name), stage:stages(id,name)")
      .eq("id", id)
      .maybeSingle(),
    sb.from("people").select("*").eq("company_id", id).order("is_primary", { ascending: false }).order("created_at"),
    sb.from("tasks").select("*").eq("company_id", id).order("done_at", { nullsFirst: true }).order("due_date"),
    sb
      .from("campaign_participants")
      .select("*, campaign:campaigns(id,name,archived_at,status, steps:campaign_steps(position,version,name,step_type,channel,delay_days,message))")
      .eq("company_id", id)
      .order("created_at", { ascending: false }),
    sb.from("list_members").select("list:lists(id,name)").eq("company_id", id),
  ]);
  const company = check(companyRes);
  if (!company) return null;
  return {
    company,
    people: check(people),
    tasks: check(tasks),
    participants: check(participants),
    lists: (check(lists) as unknown as { list: { id: string; name: string } }[]).map((r) => r.list),
  } as CompanyCore;
}

export async function getCompanyTimeline(sb: SupabaseClient, id: string): Promise<CompanyTimeline> {
  parse(idSchema, id);
  const [interactions, claudeLog] = await Promise.all([
    sb.from("interactions").select("*").eq("company_id", id).order("occurred_at", { ascending: false }).limit(200),
    sb
      .from("activity_log")
      .select("id, table_name, operation, summary, created_at")
      .eq("company_id", id)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  return { interactions: check(interactions), claudeLog: check(claudeLog) } as CompanyTimeline;
}

export async function getCompanyDetail(sb: SupabaseClient, id: string): Promise<CompanyDetail | null> {
  const [core, timeline] = await Promise.all([getCompanyCore(sb, id), getCompanyTimeline(sb, id)]);
  return core ? { ...core, ...timeline } : null;
}

export async function listPipelines(sb: SupabaseClient): Promise<PipelineWithStages[]> {
  const data = check(
    await sb.from("pipelines").select("id, name, position, stages(id, name, position)").order("position").order("created_at"),
  ) as PipelineWithStages[];
  return data.map((p) => ({ ...p, stages: [...p.stages].sort((a, b) => a.position - b.position) }));
}

export async function listTodo(sb: SupabaseClient): Promise<TodoItem[]> {
  return check(await sb.from("todo_items").select("*").order("due_date").order("company_name")) as TodoItem[];
}

// ---------------------------------------------------------------------------
// Fiches et personnes
// ---------------------------------------------------------------------------

export async function createCompany(
  sb: SupabaseClient,
  input: { company: CompanyInput; people?: PersonInput[] },
  opts: { force?: boolean; idempotencyKey?: string } = {},
): Promise<WriteResult> {
  const company = parse(companySchema, input.company);
  const people = (input.people ?? []).map((p) => parse(personSchema, p));
  return check(
    await sb.rpc("create_company", {
      p_company: company,
      p_people: people,
      p_force: opts.force ?? false,
      p_idempotency_key: opts.idempotencyKey ?? null,
    }),
  ) as WriteResult;
}

export async function updateCompany(sb: SupabaseClient, id: string, patch: CompanyPatch, force = false): Promise<WriteResult> {
  parse(idSchema, id);
  const data = parse(companyPatchSchema, patch);
  // ne transmettre que les clés réellement fournies
  const p = Object.fromEntries(Object.keys(patch).map((k) => [k, (data as Record<string, unknown>)[k] ?? null]));
  return check(await sb.rpc("update_company", { p_id: id, p_patch: p, p_force: force })) as WriteResult;
}

export async function upsertPerson(
  sb: SupabaseClient,
  companyId: string,
  person: PersonInput,
  opts: { personId?: string; force?: boolean; idempotencyKey?: string } = {},
): Promise<WriteResult> {
  parse(idSchema, companyId);
  const data = parse(personSchema, person);
  return check(
    await sb.rpc("upsert_person", {
      p_company: companyId,
      p_person: data,
      p_person_id: opts.personId ?? null,
      p_force: opts.force ?? false,
      p_idempotency_key: opts.idempotencyKey ?? null,
    }),
  ) as WriteResult;
}

/** Met le contact à la corbeille (accès au portail fermé, restaurable 30 jours) : jamais de suppression directe. */
export async function deletePerson(sb: SupabaseClient, personId: string) {
  parse(idSchema, personId);
  const { error } = await sb.rpc("trash_put", { p_kind: "person", p_id: personId });
  if (error) throw new CrmError(friendlyError(error));
}

export async function setArchived(sb: SupabaseClient, ids: string[], archived: boolean): Promise<number> {
  ids.forEach((id) => parse(idSchema, id));
  return check(await sb.rpc("set_archived", { p_ids: ids, p_archived: archived })) as number;
}

export async function addToList(sb: SupabaseClient, listId: string, companyIds: string[]) {
  parse(idSchema, listId);
  companyIds.forEach((id) => parse(idSchema, id));
  check(
    await sb
      .from("list_members")
      .upsert(companyIds.map((company_id) => ({ list_id: listId, company_id })), { ignoreDuplicates: true }),
  );
}

export async function removeFromList(sb: SupabaseClient, listId: string, companyIds: string[]) {
  check(await sb.from("list_members").delete().eq("list_id", listId).in("company_id", companyIds));
}

// ---------------------------------------------------------------------------
// Historique et tâches
// ---------------------------------------------------------------------------

export async function addInteraction(
  sb: SupabaseClient,
  input: InteractionInput,
  idempotencyKey?: string,
): Promise<{ id: string; paused_followups: number }> {
  const d = parse(interactionSchema, input);
  return check(
    await sb.rpc("add_interaction", {
      p_company: d.company_id,
      p_kind: d.kind,
      p_content: d.content ?? null,
      p_occurred_at: d.occurred_at ?? null,
      p_person: d.person_id ?? null,
      p_channel: d.channel ?? null,
      p_content_origin: d.content_origin ?? "user",
      p_idempotency_key: idempotencyKey ?? null,
    }),
  ) as { id: string; paused_followups: number };
}

export async function createTask(sb: SupabaseClient, input: TaskInput, idempotencyKey?: string) {
  const d = parse(taskSchema, input);
  return check(
    await sb.rpc("create_task", {
      p_company: d.company_id,
      p_title: d.title,
      p_due: d.due_date,
      p_person: d.person_id ?? null,
      p_idempotency_key: idempotencyKey ?? null,
    }),
  ) as { status: string; id: string };
}

export async function postponeTask(sb: SupabaseClient, taskId: string, dueDate: string) {
  parse(idSchema, taskId);
  parse(dateSchema, dueDate);
  const res = check(await sb.from("tasks").update({ due_date: dueDate }).eq("id", taskId).is("done_at", null).select("id"));
  if (!res?.length) throw new CrmError("Tâche introuvable ou déjà terminée.");
}

export async function setTaskDone(sb: SupabaseClient, taskId: string, done: boolean) {
  parse(idSchema, taskId);
  const res = check(
    await sb.from("tasks").update({ done_at: done ? new Date().toISOString() : null }).eq("id", taskId).select("id"),
  );
  if (!res?.length) throw new CrmError("Tâche introuvable.");
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export async function moveCompany(
  sb: SupabaseClient,
  companyId: string,
  stageId: string | null,
  opts: { stopFollowups?: boolean; idempotencyKey?: string } = {},
): Promise<{ status: string; stopped_followups?: number }> {
  parse(idSchema, companyId);
  if (stageId) parse(idSchema, stageId);
  return check(
    await sb.rpc("move_company", {
      p_company: companyId,
      p_stage: stageId,
      p_stop_followups: opts.stopFollowups ?? true,
      p_idempotency_key: opts.idempotencyKey ?? null,
    }),
  ) as { status: string; stopped_followups?: number };
}

export type DealStatus = "open" | "won" | "lost";
export type DealClosing = { lostReason?: string | null; closedOn?: string | null; amount?: number | null };
export type DealResult = { status: "ok" | "unchanged"; deal_status: DealStatus; deal_closed_at?: string | null; stage_id?: string | null; projects?: string | null };

const closingSchema = z.object({
  lostReason: z.string().max(500, "Motif trop long (500 caractères au plus)").nullish(),
  closedOn: z.iso.date("Date de signature invalide").nullish(),
  amount: z.number().nonnegative("Montant invalide").max(9_999_999_999, "Montant trop élevé").nullish(),
});

/**
 * Gagné, perdu, rouvert : la seule porte d'entrée, partagée par la fiche et le Kanban.
 * L'étape n'est jamais changée par une clôture ; rouvrir ramène à la dernière étape.
 */
export async function setDealStatus(sb: SupabaseClient, companyId: string, status: DealStatus, closing: DealClosing = {}): Promise<DealResult> {
  parse(idSchema, companyId);
  parse(z.enum(["open", "won", "lost"]), status);
  const c = parse(closingSchema, closing);
  return check(await sb.rpc("set_deal_status", {
    p_company: companyId,
    p_status: status,
    p_lost_reason: status === "lost" ? c.lostReason ?? null : null,
    p_closed_on: status === "won" ? c.closedOn ?? null : null,
    p_amount: status === "won" ? c.amount ?? null : null,
  })) as DealResult;
}
