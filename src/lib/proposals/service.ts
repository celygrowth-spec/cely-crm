import "server-only";
// Proposition : génération (version + devis en une opération), envoi du devis à Make, relances séparées.
// Aucun appel à Make ne part d'ici sans une action du propriétaire dans l'application (contrôle en base).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { assertComplete, rpc, trigger, type TriggerOutcome } from "@/lib/generators/service";
import { QUOTE_SCENARIO } from "@/lib/make/rules";
import { callScenario, type MakeOutcome } from "@/lib/make/service";
import { quotePayload, type ProposalExtras, type ProposalVersion, type Quote } from "./rules";
import { signedProposals, winPlan } from "./signature";

const uuid = z.uuid("Identifiant invalide");
const QUOTE_COLUMNS = "id, status, number, url, signed_on, error, total_ht_cents, requested_at, updated_at";

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}

export type QuoteOutcome = { sent: boolean; error?: string };

/**
 * Envoie le devis à Make, une seule fois : la réservation en base absorbe le double clic. Make injoignable ou lent :
 * le devis passe « à relancer » avec la raison, la proposition reste utilisable.
 */
export async function sendQuote(sb: SupabaseClient, quoteId: string, opts: { fetcher?: typeof fetch; origin?: string | null } = {}): Promise<QuoteOutcome> {
  const claim = await rpc<{ request_id: string; payload: Record<string, unknown> } | null>(sb, "proposal_quote_claim", { p_quote: uuid.parse(quoteId) });
  if (!claim) return { sent: false };
  let out: MakeOutcome;
  try {
    out = await callScenario(sb, QUOTE_SCENARIO.key, "quote.create", claim.request_id, claim.payload, opts);
  } catch {
    out = { ok: false, error: "L'appel à Make n'a pas pu être préparé." };
  }
  await rpc(sb, "proposal_quote_result", { p_quote: quoteId, p_ok: out.ok, p_error: out.ok ? null : out.error });
  return out.ok ? { sent: true } : { sent: false, error: out.error };
}

export type ProposalGenerated = { id: string; version: number; created: boolean; slides: TriggerOutcome; quote: QuoteOutcome & { id: string; reused: boolean } };

/**
 * « Générer » : la version et son devis sont créés ensemble (ou rien). Puis les slides (tâche Claude) et le devis
 * (Make) partent chacun de leur côté : l'échec de l'un ne touche pas l'autre, et chacun se relance seul.
 */
export async function generateProposal(sb: SupabaseClient, id: string, key: string, feedback: string | null, opts: { fetcher?: typeof fetch; makeFetcher?: typeof fetch; origin?: string | null } = {}): Promise<ProposalGenerated> {
  const answers = await assertComplete(sb, id, "proposal");
  const payload = quotePayload(id, answers);
  if (!payload.quote.lines.length) throw new CrmError("Ajoutez au moins une ligne au devis.");
  const v = await rpc<{ id: string; version: number; created: boolean; quote_id: string; quote_created: boolean }>(sb, "proposal_generate", {
    p_id: uuid.parse(id), p_key: z.string().min(8).max(100).parse(key), p_feedback: feedback?.slice(0, 10000) ?? null, p_quote: payload, p_total_cents: payload.quote.total_ht_cents,
  });
  const slides = await trigger(sb, id, "proposal", "slides", `slides:${v.version}`, opts.fetcher);
  const quote = await sendQuote(sb, v.quote_id, { fetcher: opts.makeFetcher, origin: opts.origin });
  return { id: v.id, version: v.version, created: v.created, slides, quote: { ...quote, id: v.quote_id, reused: !v.quote_created } };
}

/** Devis et signature de chaque version d'un dossier de proposition. */
export async function proposalExtras(sb: SupabaseClient, dossierId: string): Promise<ProposalExtras> {
  const versions = check<{ id: string }[]>(await sb.from("generator_versions").select("id").eq("dossier_id", uuid.parse(dossierId)));
  const [rows, scenario] = await Promise.all([
    versions.length ? sb.from("proposal_versions").select("version_id, quote_id, signed_at, signed_via").in("version_id", versions.map((v) => v.id)) : Promise.resolve({ data: [], error: null }),
    sb.from("make_scenarios").select("id").eq("key", QUOTE_SCENARIO.key).maybeSingle(),
  ]);
  const list = check<(Omit<ProposalVersion, "quote"> & { quote_id: string })[]>(rows);
  const quotes = list.length ? check<Quote[]>(await sb.from("quotes").select(QUOTE_COLUMNS).in("id", [...new Set(list.map((r) => r.quote_id))])) : [];
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const dossier = check<{ company_id: string } | null>(await sb.from("generator_dossiers").select("company_id").eq("id", dossierId).maybeSingle());
  const company = dossier ? check<{ deal_status: "open" | "won" | "lost" } | null>(await sb.from("companies").select("deal_status").eq("id", dossier.company_id).maybeSingle()) : null;
  const signedRow = dossier ? (await signedProposals(sb, [dossier.company_id])).find((x) => x.dossier_id === dossierId) ?? null : null;
  let toConfirm: string | null = null;
  if (signedRow && company?.deal_status !== "won") {
    const plan = await winPlan(sb, signedRow);
    toConfirm = plan.auto ? null : plan.reason;
  }
  return {
    versions: Object.fromEntries(list.flatMap(({ quote_id, ...r }) => (byId.has(quote_id) ? [[r.version_id, { ...r, quote: byId.get(quote_id)! }]] : []))),
    makeReady: !!scenario.data,
    signed: signedRow ? { version_id: signedRow.version_id, version: signedRow.version, older: signedRow.version < signedRow.latest_version } : null,
    client: { status: company?.deal_status ?? "open", to_confirm: toConfirm },
  };
}

/** Devis vivants d'un ensemble de fiches (Ventes, cartes) : le plus récent par fiche. */
export async function latestQuotes(sb: SupabaseClient, companyIds: string[]): Promise<Record<string, Quote>> {
  if (!companyIds.length) return {};
  const rows = check<(Quote & { company_id: string })[]>(
    await sb.from("quotes").select(`company_id, ${QUOTE_COLUMNS}`).in("company_id", companyIds).neq("status", "cancelled").order("created_at", { ascending: false }).limit(500),
  );
  const out: Record<string, Quote> = {};
  for (const { company_id, ...q } of rows) out[company_id] ??= q;
  return out;
}

/** Ventes, avec le devis de la proposition (numéro, lien, état renvoyés par Make) sur chaque vente gagnée. */
export async function withQuotes<T extends { company_id: string; deal_status: string }>(sb: SupabaseClient, rows: T[]): Promise<(T & { quote?: Quote })[]> {
  // un devis illisible ne masque jamais les ventes
  const quotes = await latestQuotes(sb, [...new Set(rows.filter((r) => r.deal_status === "won").map((r) => r.company_id))]).catch(() => ({}) as Record<string, Quote>);
  return rows.map((r) => (quotes[r.company_id] ? { ...r, quote: quotes[r.company_id] } : r));
}
