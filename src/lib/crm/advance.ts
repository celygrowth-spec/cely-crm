import "server-only";
// Faire avancer une fiche sans la quitter : « Ajouter à une pipeline » et « Passer en client ».
// Un seul chemin pour l'interface et Claude : les fonctions SQL company_add_to_pipeline et company_make_client,
// qui enchaînent move_company, sale_confirm et create_task en une transaction (tout ou rien).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { confirmPayload, type ConfirmInput, type ConfirmResult } from "@/lib/sales/service";

const uuid = z.uuid("Identifiant invalide");
const key = z.string().min(8).max(200);

/** Relances de prospection en cours : « stop » (arrêtées) ou « keep » (elles continuent). Jamais décidé à votre place. */
export const followupsSchema = z.enum(["stop", "keep"]).nullish();
export type FollowupsChoice = "stop" | "keep";

export const nextSchema = z.object({
  title: z.string().trim().min(1, "Indiquez la prochaine action, ou décochez-la.").max(300, "Prochaine action trop longue (300 caractères au plus)."),
  due_date: z.iso.date("Indiquez la date de la prochaine action."),
  person_id: uuid.nullish(),
}).nullish();
export type NextTask = { title: string; due_date: string; person_id?: string | null };

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  return r.data;
}

export type AddToPipelineResult = { status: "moved" | "unchanged"; stopped_followups: number; kept_followups: number; pipeline_id: string; stage_id: string; task_id: string | null };

export async function addToPipeline(sb: SupabaseClient, companyId: string, input: { stageId: string; followups?: FollowupsChoice | null; next?: NextTask | null }, idempotencyKey: string) {
  const next = parse(nextSchema, input.next);
  return rpc<AddToPipelineResult>(sb, "company_add_to_pipeline", {
    p_company: parse(uuid, companyId),
    p_stage: parse(uuid, input.stageId),
    p_followups: parse(followupsSchema, input.followups) ?? null,
    p_next: next ? { task: next } : null,
    p_idempotency_key: parse(key, idempotencyKey),
  });
}

export type MakeClientResult = ConfirmResult & { moved: boolean; stopped_followups: number; kept_followups: number; task_id: string | null };

/** Même résultat que Prospection → Pipeline → « Marquer comme gagné » ; `stageId` seulement si la fiche est hors pipeline. */
export async function makeClient(sb: SupabaseClient, companyId: string, input: { stageId?: string | null; followups?: FollowupsChoice | null; sale: ConfirmInput; next?: NextTask | null }, idempotencyKey: string) {
  const next = parse(nextSchema, input.next);
  return rpc<MakeClientResult>(sb, "company_make_client", {
    p_company: parse(uuid, companyId),
    p_stage: input.stageId ? parse(uuid, input.stageId) : null,
    p_followups: parse(followupsSchema, input.followups) ?? null,
    p_sale: confirmPayload(input.sale),
    p_next: next ? { task: next } : null,
    p_idempotency_key: parse(key, idempotencyKey),
  });
}
