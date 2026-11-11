import "server-only";
// Ventes côté serveur : lecture (vue sales_overview), confirmation « Marquer comme gagné » (une transaction SQL,
// rejouable sans doublon), suivi après-vente et préparation du projet en arrière-plan.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { centsToDb } from "@/lib/finance/money";
import * as onboarding from "@/lib/projects/onboarding";
import type { SaleRow, SaleStage } from "./rules";

const uuid = z.uuid("Identifiant invalide");
const day = z.iso.date("Date invalide");

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new CrmError(friendlyError(error));
  return data as T;
}

export async function listSales(sb: SupabaseClient): Promise<SaleRow[]> {
  const { data, error } = await sb.from("sales_overview").select("*").order("closed_on", { ascending: false, nullsFirst: false }).limit(2000);
  if (error) throw new CrmError(friendlyError(error));
  return data as SaleRow[];
}

/** Toutes les ventes de la fiche (cycles), la plus récente d'abord. */
export async function companySales(sb: SupabaseClient, companyId: string): Promise<SaleRow[]> {
  const { data, error } = await sb.from("sales_overview").select("*").eq("company_id", uuid.parse(companyId))
    .order("cycle", { ascending: false, nullsFirst: false }).order("closed_on", { ascending: false, nullsFirst: false });
  if (error) throw new CrmError(friendlyError(error));
  return data as SaleRow[];
}

/** La vente qui correspond à l'issue actuelle de la fiche (suivie, perdue ou ancien dossier), ou null. */
export async function getSale(sb: SupabaseClient, companyId: string): Promise<SaleRow | null> {
  const rows = await companySales(sb, companyId);
  return rows.find((r) => r.sale_state === "won") ?? rows.find((r) => r.deal_status === r.company_deal_status && r.sale_state !== "completed") ?? null;
}

/** Ce que rouvrir ou perdre la vente active toucherait : projet, revenu, accès client (décisions à prendre). */
export type DealLinks = {
  sale_id: string; cycle: number; state: string;
  project: { id: string; name: string; status: string; published: boolean } | null;
  mission: { id: string; label: string; kind: "ponctuel" | "recurrent"; amount: number | string | null; status: string; end_date: string | null; invoiced: boolean } | null;
  portal_people: { person_id: string; name: string; other_projects: number }[];
} | null;
export const dealLinks = (sb: SupabaseClient, companyId: string) => rpc<DealLinks>(sb, "deal_links", { p_company: uuid.parse(companyId) });

export const transitionSchema = z.object({
  project: z.enum(["continue", "en_attente", "archive"]).optional(),
  revenue: z.enum(["continue", "stop"]).optional(),
  revenue_stop_on: day.optional(),
  portal: z.enum(["keep", "revoke"]).optional(),
  lost_reason: z.string().trim().max(500, "Motif trop long (500 caractères au plus)").nullish(),
});
export type TransitionOptions = z.input<typeof transitionSchema>;
export type TransitionResult = { status: string; deal_status: string; effects: string[]; portal_kept_other_projects: number };

/** Rouvrir ou perdre avec les décisions sur les éléments liés, en une opération (C03). */
export async function dealTransition(sb: SupabaseClient, companyId: string, status: "open" | "lost", options: TransitionOptions, key: string) {
  const o = transitionSchema.safeParse(options);
  if (!o.success) throw new CrmError(o.error.issues.map((i) => i.message).join(" · "));
  return rpc<TransitionResult>(sb, "deal_transition", { p_company: uuid.parse(companyId), p_status: status, p_options: o.data, p_idempotency_key: z.string().min(8).max(200).parse(key) });
}

/** Client qui revient : la vente actuelle se termine, une nouvelle opportunité s'ouvre sur la même fiche (Q05). */
export const newOpportunity = (sb: SupabaseClient, companyId: string, stageId: string, key: string) =>
  rpc<{ status: string; previous_sale_id: string | null }>(sb, "deal_new_opportunity", { p_company: uuid.parse(companyId), p_stage: uuid.parse(stageId), p_idempotency_key: z.string().min(8).max(200).parse(key) });

/** Ce qu'on peut lier ou préremplir dans « Marquer comme gagné ». */
export async function saleContext(sb: SupabaseClient, companyId: string) {
  const id = uuid.parse(companyId);
  const [company, sale, missions, invoices, projects, files, linked] = await Promise.all([
    sb.from("companies").select("id, name, amount, expected_close_date, deal_status, deal_closed_at").eq("id", id).maybeSingle(),
    sb.from("sales").select("id, cycle, mission_id, project_id, project_removed_at, documents_ready, signed_on, state").eq("company_id", id).in("state", ["won", "reopened"]).maybeSingle(),
    sb.from("finance_mission_overview").select("id, label, kind, amount, start_date, end_date, status, invoiced_ttc, received").eq("company_id", id).order("created_at", { ascending: false }),
    sb.from("finance_invoice_overview").select("id, reference, issue_date, amount_ht, amount_ttc, mission_id, mission_label, status").eq("company_id", id).eq("kind", "facture").is("cancelled_at", null).order("issue_date", { ascending: false }),
    sb.from("projects").select("id, name, status").eq("company_id", id).not("status", "in", "(termine,archive)").order("created_at", { ascending: false }),
    sb.from("company_files").select("id, display_name, category, created_at").eq("company_id", id).in("category", ["Proposition", "Contrat"]).eq("status", "ready").order("created_at", { ascending: false }),
    sb.from("sales").select("id, mission_id, project_id").eq("company_id", id),
  ]);
  for (const r of [company, sale, missions, invoices, projects, files, linked]) if (r.error) throw new CrmError(friendlyError(r.error));
  if (!company.data) throw new CrmError("Fiche introuvable");
  // revenus et projets déjà portés par une autre vente (même passée) : jamais proposés
  const others = (linked.data ?? []).filter((x) => x.id !== sale.data?.id);
  const taken = new Set(others.map((x) => x.mission_id as string | null).filter(Boolean) as string[]);
  const takenProjects = new Set(others.map((x) => x.project_id as string | null).filter(Boolean) as string[]);
  return {
    company: company.data,
    sale: sale.data,
    missions: (missions.data ?? []).filter((m) => !taken.has(m.id)),
    invoices: (invoices.data ?? []).filter((i) => !i.mission_id || !taken.has(i.mission_id)),
    projects: (projects.data ?? []).filter((p) => !takenProjects.has(p.id)),
    files: files.data ?? [],
  };
}
export type SaleContext = Awaited<ReturnType<typeof saleContext>>;

// ---------------------------------------------------------------------------
// « Marquer comme gagné »
// ---------------------------------------------------------------------------

export const confirmSchema = z.object({
  closed_on: day,
  signed_on: day.nullish(),
  documents_ready: z.boolean(),
  revenue: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("plus_tard") }),
    z.object({ mode: z.literal("ponctuel"), amount_cents: z.number().int().positive("Montant invalide"), date: day }),
    z.object({ mode: z.literal("mensuel"), amount_cents: z.number().int().positive("Montant invalide"), date: day, end_date: day.nullish() }),
  ]),
  link_mission_id: uuid.nullish(),
  link_invoice_id: uuid.nullish(),
  link_project_id: uuid.nullish(),
  project_name: z.string().trim().max(160).nullish(),
  /** projet de la vente supprimé : le recréer seulement sur demande explicite */
  create_project: z.boolean().optional(),
}).refine((v) => v.revenue.mode !== "mensuel" || !v.revenue.end_date || v.revenue.end_date >= v.revenue.date, { message: "La date de fin précède la première échéance" });
export type ConfirmInput = z.input<typeof confirmSchema>;
export type ConfirmResult = { sale_id: string; cycle: number; project_id: string | null; mission_id: string | null; created: { sale?: boolean; revenue?: boolean; project?: boolean }; project_removed: boolean };

export async function confirmSale(sb: SupabaseClient, companyId: string, input: ConfirmInput, key: string): Promise<ConfirmResult> {
  const r = confirmSchema.safeParse(input);
  if (!r.success) throw new CrmError(r.error.issues.map((i) => i.message).join(" · "));
  const v = r.data;
  const revenue = v.revenue.mode === "plus_tard" ? { mode: "plus_tard" }
    : { mode: v.revenue.mode, amount: centsToDb(v.revenue.amount_cents), date: v.revenue.date, end_date: v.revenue.mode === "mensuel" ? v.revenue.end_date ?? null : null };
  return rpc<ConfirmResult>(sb, "sale_confirm", {
    p_company: uuid.parse(companyId),
    p_data: {
      closed_on: v.closed_on, signed_on: v.signed_on ?? null, documents_ready: v.documents_ready, revenue,
      link_mission_id: v.link_mission_id ?? null, link_invoice_id: v.link_invoice_id ?? null, link_project_id: v.link_project_id ?? null,
      project_name: v.project_name || null, create_project: v.create_project ?? false,
    },
    p_idempotency_key: z.string().min(8).max(200).parse(key),
  });
}

/** Faire avancer le suivi ; reculer un projet en cours demande `confirm` (Q11). */
export const setSaleStage = (sb: SupabaseClient, saleId: string, stage: SaleStage, confirm = false) =>
  rpc<{ sale_id: string; stage: SaleStage }>(sb, "sale_set_stage", { p_sale: uuid.parse(saleId), p_stage: stage, p_confirm: confirm });

// ---------------------------------------------------------------------------
// Préparation de l'onboarding : une seule source, project_onboarding (K10)
// ---------------------------------------------------------------------------

/** Lance (ou relance) la préparation du projet de la vente ; vos corrections manuelles sont conservées. */
export async function prepareProject(sb: SupabaseClient, projectId: string): Promise<void> {
  await onboarding.prepare(sb, uuid.parse(projectId));
}
