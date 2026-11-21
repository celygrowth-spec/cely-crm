import "server-only";
// Lecture de l'index de la boîte avec la session du propriétaire (les politiques d'accès filtrent en base).
import type { SupabaseClient } from "@supabase/supabase-js";
import { CrmError } from "@/lib/crm/service";
import type { BoxStatus } from "./box-types";

export async function boxStatus(sb: SupabaseClient): Promise<BoxStatus> {
  const { data: accounts, error } = await sb.from("mail_accounts").select("id, email, status, is_default, connected_at").neq("status", "disconnected")
    .order("is_default", { ascending: false }).order("connected_at", { ascending: false }).limit(1);
  if (error) throw new CrmError(`Lecture de la boîte impossible : ${error.message}`);
  const account = accounts?.[0];
  if (!account) return { state: "none", email: null, message: "Aucun compte Gmail connecté.", messages: 0, last_sync_at: null, started_at: null };
  const base = { email: account.email as string, messages: 0, last_sync_at: null as string | null, started_at: null as string | null };
  if (account.status !== "connected") return { ...base, state: "error", message: "Google a retiré l'accès à ce compte. Reconnectez Gmail ci-dessous : la synchronisation reprendra où elle s'est arrêtée." };

  const { data: sync } = await sb.from("mailbox_sync").select("backfill_started_at, backfill_done_at, last_sync_at, error_code, last_error").eq("account_id", account.id).maybeSingle();
  const { count } = await sb.from("mailbox_messages").select("message_id", { count: "exact", head: true }).eq("account_id", account.id);
  const seen = { ...base, messages: count ?? 0, last_sync_at: (sync?.last_sync_at as string | null) ?? null, started_at: (sync?.backfill_started_at as string | null) ?? null };
  if (!sync) return { ...seen, state: "pending", message: "La première synchronisation n'a pas encore commencé." };
  if (sync.last_error) return { ...seen, state: "error", message: sync.last_error as string };
  if (!sync.backfill_done_at) return { ...seen, state: "initial", message: "Première lecture de la boîte en cours, des messages les plus récents aux plus anciens." };
  return { ...seen, state: "ready", message: "La boîte est à jour." };
}
