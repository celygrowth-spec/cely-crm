import "server-only";
// Traitement serveur des imports : sans session, avec la clé serveur (voir la migration).
// Rien du contenu des appels n'est journalisé.
import type { SupabaseClient } from "@supabase/supabase-js";
import { ZodError } from "zod";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { fetchTranscript, FirefliesFailure, listTranscriptIds } from "./client";
import { IncompleteTranscript, normalizeTranscript } from "./normalize";

type ClaimedJob = { id: string; meeting_id: string; lock_token: string; attempts: number };

export type DrainResult = { processed: number; failed: number };

// Budget + délai d'un appel Fireflies (25 s) restent sous maxDuration des routes (60 s) : au-delà, le reste
// attend le prochain passage. Une seule tâche prise à la fois : une coupure ne coûte qu'une tentative.
const DRAIN_BUDGET_MS = 30_000;
// Reprises rapprochées dans le même passage : sur Vercel Hobby, le prochain passage planifié peut être à 24 h.
const QUICK_RETRY_DELAYS_MS = [2_000, 8_000];
const QUICK_RETRY_WINDOW_MS = 15_000;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, { p_server_key: serverRpcKey(), ...args });
  if (error) throw new FirefliesFailure("temporary", "database", "Enregistrement en base impossible.");
  return data as T;
}

async function fetchWithQuickRetries(meetingId: string) {
  const started = Date.now();
  for (let i = 0; ; i++) {
    try {
      return await fetchTranscript(meetingId);
    } catch (e) {
      const retriable = e instanceof FirefliesFailure && e.kind === "temporary" && !["not_configured", "auth"].includes(e.code);
      if (!retriable || i >= QUICK_RETRY_DELAYS_MS.length || Date.now() - started > QUICK_RETRY_WINDOW_MS) throw e;
      await wait(QUICK_RETRY_DELAYS_MS[i]);
    }
  }
}

function asFailure(e: unknown): FirefliesFailure {
  if (e instanceof FirefliesFailure) return e;
  if (e instanceof IncompleteTranscript) return new FirefliesFailure("temporary", "incomplete", e.message);
  if (e instanceof ZodError) return new FirefliesFailure("temporary", "invalid_response", "Réponse de Fireflies illisible.");
  return new FirefliesFailure("temporary", "unexpected", "Erreur inattendue pendant l'import.");
}

async function processJob(sb: SupabaseClient, job: ClaimedJob): Promise<boolean> {
  try {
    const { account, transcript } = await fetchWithQuickRetries(job.meeting_id);
    const { call, lines } = normalizeTranscript(transcript);
    await rpc(sb, "fireflies_store_call", {
      p_job_id: job.id,
      p_lock_token: job.lock_token,
      p_account: account,
      p_call: call,
      p_lines: lines,
    });
    return true;
  } catch (e) {
    const f = asFailure(e);
    console.error(`[fireflies] import ${job.id} : ${f.kind} ${f.code}`);
    await rpc(sb, "fireflies_job_failed", {
      p_job_id: job.id,
      p_lock_token: job.lock_token,
      p_kind: f.kind,
      p_code: f.code,
      p_message: f.message,
      p_retry_after: f.retryAfter ?? null,
    }).catch(() => console.error(`[fireflies] import ${job.id} : échec non enregistré, reprise à l'expiration du verrou`));
    return false;
  }
}

/** Traite les tâches dues, dans la limite du temps donné. Plusieurs passages simultanés ne prennent jamais la même tâche. */
export async function drainImports(sb: SupabaseClient, budgetMs = DRAIN_BUDGET_MS): Promise<DrainResult> {
  const deadline = Date.now() + budgetMs;
  const result: DrainResult = { processed: 0, failed: 0 };
  while (Date.now() < deadline) {
    const [job] = (await rpc<ClaimedJob[]>(sb, "fireflies_claim_jobs", { p_limit: 1 })) ?? [];
    if (!job) break;
    if (await processJob(sb, job)) result.processed++;
    else result.failed++;
  }
  return result;
}

const SYNC_WINDOW_MS = 3 * 24 * 3600_000;
const SYNC_PAGE = 50; // maximum de l'API
const SYNC_MAX_PAGES = 5;

/**
 * Rattrapage : met en file les réunions d'une période absentes de la base (webhook perdu ou indisponible).
 * Une réunion déjà connue n'est pas refetchée : une page par passage suffit à ne coûter presque aucun quota.
 */
export async function enqueueRange(sb: SupabaseClient, from: Date, to: Date): Promise<{ seen: number; queued: number }> {
  let seen = 0;
  let queued = 0;
  for (let page = 0; page < SYNC_MAX_PAGES; page++) {
    const ids = await listTranscriptIds(from, to, page * SYNC_PAGE, SYNC_PAGE);
    for (const id of ids) {
      seen++;
      const r = await rpc<string>(sb, "fireflies_enqueue", { p_meeting_id: id, p_event: "sync", p_reprocessed_at: null });
      if (r === "queued") queued++;
    }
    if (ids.length < SYNC_PAGE) break;
  }
  return { seen, queued };
}

export async function syncRecent(sb: SupabaseClient, now = new Date()) {
  const res = await enqueueRange(sb, new Date(now.getTime() - SYNC_WINDOW_MS), now);
  await rpc(sb, "fireflies_sync_done", {});
  return res;
}

/** Reprend les appels à rattacher : un contact ajouté depuis peut désormais les désigner. Les choix manuels ne bougent pas. */
export async function rematchPending(sb: SupabaseClient) {
  return rpc<number>(sb, "fireflies_rematch", {});
}
