import "server-only";
// Ventes côté serveur : lecture (vue sales_overview), confirmation « Marquer comme gagné » (une transaction SQL,
// rejouable sans doublon), suivi après-vente et préparation du projet en arrière-plan.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { centsToDb } from "@/lib/finance/money";
import type { CallSummary } from "@/lib/fireflies/types";
import * as onboarding from "@/lib/projects/onboarding";
import type { Prep, PrepItem, SaleRow, SaleStage } from "./rules";

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

export async function getSale(sb: SupabaseClient, companyId: string): Promise<SaleRow | null> {
  const { data, error } = await sb.from("sales_overview").select("*").eq("company_id", uuid.parse(companyId)).maybeSingle();
  if (error) throw new CrmError(friendlyError(error));
  return data as SaleRow | null;
}

/** Ce qu'on peut lier ou préremplir dans « Marquer comme gagné ». */
export async function saleContext(sb: SupabaseClient, companyId: string) {
  const id = uuid.parse(companyId);
  const [company, sale, missions, invoices, projects, files, linked] = await Promise.all([
    sb.from("companies").select("id, name, amount, expected_close_date, deal_status, deal_closed_at").eq("id", id).maybeSingle(),
    sb.from("sales").select("id, mission_id, project_id, documents_ready, signed_on, state").eq("company_id", id).maybeSingle(),
    sb.from("finance_mission_overview").select("id, label, kind, amount, start_date, end_date, status, invoiced_ttc, received").eq("company_id", id).order("created_at", { ascending: false }),
    sb.from("finance_invoice_overview").select("id, reference, issue_date, amount_ht, amount_ttc, mission_id, mission_label, status").eq("company_id", id).eq("kind", "facture").is("cancelled_at", null).order("issue_date", { ascending: false }),
    sb.from("projects").select("id, name, status").eq("company_id", id).neq("status", "archive").order("created_at", { ascending: false }),
    sb.from("company_files").select("id, display_name, category, created_at").eq("company_id", id).in("category", ["Proposition", "Contrat"]).eq("status", "ready").order("created_at", { ascending: false }),
    sb.from("sales").select("mission_id").not("mission_id", "is", null),
  ]);
  for (const r of [company, sale, missions, invoices, projects, files, linked]) if (r.error) throw new CrmError(friendlyError(r.error));
  if (!company.data) throw new CrmError("Fiche introuvable");
  const own = sale.data?.mission_id ?? null;
  const taken = new Set((linked.data ?? []).map((x) => x.mission_id as string).filter((m) => m !== own));
  return {
    company: company.data,
    sale: sale.data,
    missions: (missions.data ?? []).filter((m) => !taken.has(m.id)),
    invoices: (invoices.data ?? []).filter((i) => !i.mission_id || !taken.has(i.mission_id)),
    projects: projects.data ?? [],
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
});
export type ConfirmInput = z.input<typeof confirmSchema>;
export type ConfirmResult = { sale_id: string; project_id: string | null; mission_id: string | null; created: { sale?: boolean; revenue?: boolean; project?: boolean } };

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
      project_name: v.project_name || null,
    },
    p_idempotency_key: z.string().min(8).max(200).parse(key),
  });
}

export const setSaleStage = (sb: SupabaseClient, saleId: string, stage: SaleStage) =>
  rpc<{ sale_id: string; stage: SaleStage }>(sb, "sale_set_stage", { p_sale: uuid.parse(saleId), p_stage: stage });

// ---------------------------------------------------------------------------
// Préparation du projet (arrière-plan) : proposition, Fireflies, diagnostic
// ---------------------------------------------------------------------------

export const PREP_MARK = "[Préparation automatique de l'onboarding]";
const asText = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(" ") : v ?? "").trim();

/**
 * Rassemble ce qui existe déjà sur la fiche et l'inscrit dans la note interne du projet (jamais visible du
 * client), puis liste ce qui manque pour démarrer. Rien n'est publié ni partagé. Rejouable sans effet de bord.
 */
export async function prepareSale(sb: SupabaseClient, saleId: string): Promise<void> {
  const id = uuid.parse(saleId);
  if (!(await rpc<boolean>(sb, "sale_prep_claim", { p_sale: id }))) return; // déjà en cours
  try {
    const { data: s, error } = await sb.from("sales").select("id, company_id, project_id, mission_id, documents_ready").eq("id", id).single();
    if (error || !s) throw new CrmError("Vente introuvable");
    const [project, files, calls, diag, members, mission] = await Promise.all([
      s.project_id ? sb.from("projects").select("id, name, start_date, end_date, internal_note").eq("id", s.project_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      sb.from("company_files").select("display_name, category, created_at").eq("company_id", s.company_id).in("category", ["Proposition", "Contrat"]).eq("status", "ready").order("created_at", { ascending: false }),
      sb.from("fireflies_calls").select("title, occurred_at, summary, summary_state").eq("company_id", s.company_id).order("occurred_at", { ascending: false, nullsFirst: false }).limit(3),
      sb.from("diagnostics").select("id, status, created_at, diagnostic_versions(version, status)").eq("company_id", s.company_id).order("created_at", { ascending: false }).limit(1),
      s.project_id ? sb.from("project_members").select("person_id").eq("project_id", s.project_id) : Promise.resolve({ data: [], error: null }),
      s.mission_id ? sb.from("finance_missions").select("kind, amount, start_date, end_date").eq("id", s.mission_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    for (const r of [project, files, calls, diag, members, mission]) if (r.error) throw new CrmError(friendlyError(r.error));
    const props = (files.data ?? []).filter((f) => f.category === "Proposition");
    const contracts = (files.data ?? []).filter((f) => f.category === "Contrat");
    const callList = (calls.data ?? []) as { title: string; occurred_at: string | null; summary: CallSummary; summary_state: string }[];
    const d = (diag.data ?? [])[0] as { id: string; status: string; diagnostic_versions?: { version: number; status: string }[] } | undefined;
    const lastVersion = (d?.diagnostic_versions ?? []).filter((x) => x.status === "ready").sort((a, b) => b.version - a.version)[0];
    const memberIds = ((members.data ?? []) as { person_id: string }[]).map((m) => m.person_id);
    const emails = memberIds.length ? await sb.from("people").select("email").in("id", memberIds).not("email", "is", null) : { data: [], error: null };
    if (emails.error) throw new CrmError(friendlyError(emails.error));
    const withEmail = (emails.data ?? []).length > 0;
    const p = project.data as { id: string; name: string; start_date: string | null; end_date: string | null; internal_note: string | null } | null;
    const fiche = `/fiches/${s.company_id}`;
    const items: PrepItem[] = [
      { key: "proposition", label: "Proposition acceptée sur la fiche", done: props.length > 0, required: true, href: fiche, hint: "Ajoutez-la dans les documents de la fiche, catégorie « Proposition »." },
      { key: "contrat", label: "Devis ou contrat signé", done: !!s.documents_ready || contracts.length > 0, required: false, href: fiche, hint: "Catégorie « Contrat » dans les documents de la fiche." },
      { key: "contact", label: "Contact client avec un email dans le projet", done: withEmail, required: true, href: p ? `/projets/${p.id}/acces` : null, hint: "Pour l'invitation au portail, quand vous le déciderez." },
      { key: "dates", label: "Date de démarrage du projet", done: !!p?.start_date, required: true, href: p ? `/projets/${p.id}` : null, hint: null },
      { key: "contexte", label: "Compte rendu Fireflies ou diagnostic", done: callList.length > 0 || !!lastVersion, required: false, href: fiche, hint: "Facultatif : enrichit la préparation." },
    ];
    const prep: Prep = { items, sources: { propositions: props.length, contracts: contracts.length, calls: callList.length, diagnostic: !!lastVersion } };

    // Note interne du projet : uniquement si elle est vide ou si elle vient d'une préparation précédente
    if (p && (!p.internal_note?.trim() || p.internal_note.startsWith(PREP_MARK))) {
      const m = mission.data as { kind: string; amount: string | number | null; start_date: string | null; end_date: string | null } | null;
      const lines = [
        PREP_MARK,
        "Contenu privé : rien n'est visible du client avant votre partage.",
        "",
        "Périmètre — proposition acceptée",
        ...(props.length ? props.map((f) => `• ${f.display_name}`) : ["• À ajouter sur la fiche (catégorie « Proposition »)."]),
        ...(contracts.length ? ["", "Devis / contrat", ...contracts.map((f) => `• ${f.display_name}`)] : []),
        ...(m ? ["", "Revenu prévu", `• ${m.kind === "recurrent" ? "Mensuel" : "Ponctuel"} : ${m.amount ?? "?"} € HT${m.start_date ? `, à partir du ${m.start_date}` : ""}${m.end_date ? ` jusqu'au ${m.end_date}` : ""}`] : []),
        ...(callList.length ? ["", "Appels Fireflies", ...callList.map((c) => {
          const sum = asText(c.summary?.overview) || asText(c.summary?.short_summary) || asText(c.summary?.gist);
          const actions = asText(c.summary?.action_items);
          return `• ${c.title}${c.occurred_at ? ` (${c.occurred_at.slice(0, 10)})` : ""}${sum ? ` — ${sum.slice(0, 600)}` : ""}${actions ? `\n  Actions : ${actions.slice(0, 400)}` : ""}`;
        })] : []),
        ...(lastVersion ? ["", "Diagnostic", `• Version ${lastVersion.version} disponible sur la fiche (onglet Diagnostic).`] : []),
      ];
      const note = lines.join("\n").slice(0, 10000);
      const up = await sb.from("projects").update({ internal_note: note }).eq("id", p.id);
      if (up.error) throw new CrmError(friendlyError(up.error));
    }
    if (p) {
      // préparation détaillée du projet (points à compléter, sources, analyse par Claude) : elle tient aussi
      // à jour sales.prep et sales.prep_state, pour que Ventes et Projets affichent le même état
      await rpc(sb, "onboarding_ensure", { p_project: p.id });
      await onboarding.prepare(sb, p.id);
      await onboarding.requestAnalysis(sb, p.id);
      return;
    }
    const missing = items.filter((i) => i.required && !i.done).length;
    await rpc(sb, "sale_prep_save", { p_sale: id, p_state: missing ? "incomplete" : "ready", p_prep: prep, p_error: null });
  } catch (e) {
    const message = e instanceof CrmError ? e.message : "Préparation interrompue.";
    if (!(e instanceof CrmError)) console.error(e);
    await sb.rpc("sale_prep_save", { p_sale: id, p_state: "failed", p_prep: null, p_error: message });
  }
}
