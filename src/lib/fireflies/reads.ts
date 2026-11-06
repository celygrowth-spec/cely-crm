import "server-only";
// Lectures et réglages du propriétaire (session, sous RLS). La file et le suivi ne renvoient jamais de transcription.
import type { SupabaseClient } from "@supabase/supabase-js";
import { appointmentsSecretOrNull } from "@/lib/appointments/config";
import { ensureServerKey } from "@/lib/appointments/owner";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { firefliesApiKey, firefliesWebhookSecret } from "./config";
import type { Call, FirefliesStatus, ImportRow, TranscriptLine } from "./types";

function check<T>(res: { data: unknown; error: { message: string; code?: string } | null }): T {
  if (res.error) throw new CrmError(friendlyError(res.error));
  return res.data as T;
}

/** Les routes qui agissent ensuite avec la clé serveur vérifient d'abord que la session est celle du propriétaire. */
export async function assertOwnerSession(sb: SupabaseClient): Promise<void> {
  const { data } = await sb.rpc("is_app_owner");
  if (data !== true) throw new CrmError("Accès refusé.");
}

export type CallFilter = { company?: string; booking?: string; state?: "to_link" | "ignored" };

export async function listCalls(sb: SupabaseClient, f: CallFilter): Promise<Call[]> {
  let q = sb.from("fireflies_call_list").select("*");
  if (f.company) q = q.eq("company_id", f.company);
  if (f.booking) q = q.eq("booking_id", f.booking);
  if (f.state) q = q.eq("link_state", f.state);
  return check<Call[]>(await q.order("occurred_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(200));
}

export async function getTranscript(sb: SupabaseClient, callId: string): Promise<{ lines: TranscriptLine[] } | null> {
  return check(await sb.from("fireflies_call_transcripts").select("lines").eq("call_id", callId).maybeSingle());
}

export async function setCallNote(sb: SupabaseClient, callId: string, note: string): Promise<void> {
  check(await sb.rpc("fireflies_set_call_note", { p_call: callId, p_note: note }));
}

export async function retryJob(sb: SupabaseClient, jobId: string): Promise<void> {
  check(await sb.rpc("fireflies_retry_job", { p_job_id: jobId }));
}

export async function setOwnAddresses(sb: SupabaseClient, emails: string[], domains: string[]): Promise<void> {
  check(await sb.rpc("fireflies_set_own_addresses", { p_emails: emails, p_domains: domains }));
}

const IMPORT_COLUMNS = "job_id, meeting_id, source, display_state, attempts, next_attempt_at, last_error_code, last_error, received_at, title, occurred_at, line_count, call_id";

export async function firefliesStatus(sb: SupabaseClient): Promise<FirefliesStatus> {
  const serverKey = await ensureServerKey(sb);
  const [connection, pending, failed, recent] = await Promise.all([
    sb.from("fireflies_connection").select("account_email, last_webhook_at, last_success_at, last_sync_at, last_error_code, last_error_at, api_paused_until, own_emails, own_domains").maybeSingle(),
    sb.from("fireflies_import_overview").select("job_id", { count: "exact", head: true }).in("job_status", ["pending", "running"]),
    sb.from("fireflies_import_overview").select(IMPORT_COLUMNS).eq("job_status", "failed").order("updated_at", { ascending: false }).limit(50),
    sb.from("fireflies_import_overview").select(IMPORT_COLUMNS).order("received_at", { ascending: false }).limit(20),
  ]);
  if (pending.error) throw new CrmError(friendlyError(pending.error));
  return {
    configured: {
      apiKey: !!firefliesApiKey(),
      webhookSecret: !!firefliesWebhookSecret(),
      serverSecret: !!appointmentsSecretOrNull() && serverKey,
      cronSecret: (process.env.CRON_SECRET ?? "").length >= 16,
    },
    connection: check(connection),
    pending: pending.count ?? 0,
    failed: check<ImportRow[]>(failed),
    recent: check<ImportRow[]>(recent),
  };
}
