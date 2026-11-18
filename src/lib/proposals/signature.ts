import "server-only";
// Signature d'une proposition, puis passage en client par la logique existante (« Passer en client » : fiche gagnée,
// vente, revenu, projet et sa préparation d'onboarding). Deux chemins, un seul résultat, une seule fois :
//   * Make renvoie « devis signé » : la base marque la proposition signée (make_return) ;
//   * « Marquer comme signée » dans l'application, pour une signature arrivée hors Make.
// Le passage en client se fait ensuite avec la session du propriétaire (finalizeSignature), sous une clé liée au
// devis : rejoué, il ne crée ni seconde vente ni second projet.
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { makeClient } from "@/lib/crm/advance";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { todayISO } from "@/lib/format";
import { rpc } from "@/lib/generators/service";
import { prepareProject, saleContext, type ConfirmInput } from "@/lib/sales/service";
import type { QuotePayload } from "./rules";

const uuid = z.uuid("Identifiant invalide");

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}

export type SignedProposal = { company_id: string; dossier_id: string; version_id: string; version: number; latest_version: number; quote_id: string; signed_at: string; signed_on: string | null; payload: QuotePayload };

/** Proposition signée de chaque fiche demandée (la plus récente par fiche). */
export async function signedProposals(sb: SupabaseClient, companyIds?: string[]): Promise<SignedProposal[]> {
  let q = sb.from("proposal_signed").select("company_id, dossier_id, version_id, version, latest_version, quote_id, signed_at, signed_on, payload").order("signed_at", { ascending: false }).limit(200);
  if (companyIds) q = q.in("company_id", companyIds.map((c) => uuid.parse(c)));
  const rows = check<SignedProposal[]>(await q);
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.company_id) && seen.add(r.company_id));
}

const addMonths = (day: string, months: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Revenu déduit des lignes du devis : tout mensuel, tout ponctuel, sinon « à renseigner plus tard ». Rien d'estimé. */
export function revenueFromQuote(p: QuotePayload): ConfirmInput["revenue"] {
  const lines = p.quote.lines;
  const sum = (l: typeof lines) => l.reduce((n, x) => n + Math.round(x.quantity * x.unit_price_cents), 0);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(p.quote.start_date) ? p.quote.start_date : null;
  if (!start || !lines.length) return { mode: "plus_tard" };
  if (lines.every((l) => l.recurrence === "one_off") && sum(lines) > 0) return { mode: "ponctuel", amount_cents: sum(lines), date: start };
  if (lines.every((l) => l.recurrence === "monthly")) {
    // une ligne mensuelle porte un prix par mois : la quantité compte les mois, pas le montant mensuel
    const monthly = lines.reduce((n, x) => n + x.unit_price_cents, 0);
    if (monthly > 0) return { mode: "mensuel", amount_cents: monthly, date: start, end_date: p.quote.duration_months ? addMonths(start, p.quote.duration_months) : null };
  }
  return { mode: "plus_tard" };
}

export type WinPlan = { auto: true; stageId: null; sale: ConfirmInput } | { auto: false; reason: string };

/** Le passage en client est automatique quand tout se déduit du devis ; sinon je confirme moi-même, avec la raison. */
export async function winPlan(sb: SupabaseClient, s: SignedProposal): Promise<WinPlan> {
  const company = check<{ name: string; deal_status: string; pipeline_id: string | null } | null>(await sb.from("companies").select("name, deal_status, pipeline_id").eq("id", s.company_id).maybeSingle());
  if (!company) return { auto: false, reason: "Fiche introuvable." };
  if (company.deal_status === "lost") return { auto: false, reason: "L'opportunité est marquée perdue : rouvrez-la depuis la fiche." };
  if (!company.pipeline_id) return { auto: false, reason: "La fiche n'est dans aucune pipeline : choisissez l'étape par laquelle passe la vente." };
  const ctx = await saleContext(sb, s.company_id);
  if (ctx.projects.length) return { auto: false, reason: "La fiche a déjà un projet actif : choisissez de le lier ou d'en créer un nouveau." };
  if (ctx.missions.length) return { auto: false, reason: "Un revenu existe déjà pour ce client : choisissez de le lier ou d'en créer un nouveau." };
  const signed = s.signed_on && s.signed_on <= todayISO() ? s.signed_on : todayISO();
  return {
    auto: true, stageId: null,
    sale: { closed_on: signed, signed_on: signed, documents_ready: true, revenue: revenueFromQuote(s.payload), project_name: `Mission ${company.name}` },
  };
}

export type Finalized = { company_id: string; status: "already_client" | "won" | "to_confirm"; reason?: string; project_id?: string | null };

/**
 * Proposition signée → client, par la logique existante. Une fiche déjà cliente n'est pas retouchée ; la clé liée au
 * devis rend l'opération rejouable sans doublon. Les relances de prospection en cours sont arrêtées.
 */
export async function finalizeSignature(sb: SupabaseClient, s: SignedProposal): Promise<Finalized> {
  const company = check<{ deal_status: string } | null>(await sb.from("companies").select("deal_status").eq("id", s.company_id).maybeSingle());
  if (company?.deal_status === "won") return { company_id: s.company_id, status: "already_client" };
  const plan = await winPlan(sb, s);
  if (!plan.auto) return { company_id: s.company_id, status: "to_confirm", reason: plan.reason };
  const r = await makeClient(sb, s.company_id, { stageId: null, followups: "stop", sale: plan.sale, next: null }, `proposition-signee:${s.quote_id}`);
  // comme dans l'interface : la préparation de l'onboarding suit ; un échec ne défait pas la vente (relançable)
  if (r.project_id) await prepareProject(sb, r.project_id).catch(() => null);
  return { company_id: s.company_id, status: "won", project_id: r.project_id };
}

/** Signatures reçues de Make pendant mon absence : passage en client à mon retour dans le CRM. */
export async function finalizePending(sb: SupabaseClient): Promise<Finalized[]> {
  const signed = await signedProposals(sb);
  if (!signed.length) return [];
  const open = new Set(check<{ id: string }[]>(await sb.from("companies").select("id").in("id", signed.map((s) => s.company_id)).eq("deal_status", "open")).map((c) => c.id));
  const out: Finalized[] = [];
  for (const s of signed.filter((x) => open.has(x.company_id)).slice(0, 10)) {
    out.push(await finalizeSignature(sb, s).catch((e) => ({ company_id: s.company_id, status: "to_confirm" as const, reason: e instanceof CrmError ? e.message : "Passage en client impossible pour le moment." })));
  }
  return out;
}

/** « Marquer comme signée » : même résultat que le retour de Make, une seule fois. */
export async function markSigned(sb: SupabaseClient, versionId: string): Promise<Finalized & { already: boolean; older: boolean }> {
  const r = await rpc<{ already: boolean; company_id: string }>(sb, "proposal_mark_signed", { p_version: uuid.parse(versionId) });
  const [s] = await signedProposals(sb, [r.company_id]);
  if (!s) throw new CrmError("Signature introuvable.");
  return { ...(await finalizeSignature(sb, s)), already: r.already, older: s.version < s.latest_version };
}
