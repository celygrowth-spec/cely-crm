import "server-only";
// Passages planifiés (C07, Q02, Q03) : un seul point d'entrée, chaque tâche isolée et rapportée en base
// (dernière réussite, dernière erreur), visibles dans Paramètres › Connecteurs. Fonctionne sans session :
// toutes les écritures passent par des fonctions à clé serveur.
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMime } from "@/lib/mail/mime";
import { decryptSecret, encryptSecret } from "@/lib/mail/crypto";
import { GMAIL_READ_SCOPE, GoogleError, gmailSend, refreshAccess } from "@/lib/mail/google";
import { getMessage, GmailReadError, listRecent, listSince, profileHistoryId } from "@/lib/mail/gmail-read";
import { parseGmailMessage } from "@/lib/mail/inbound";
import { mailConfig } from "@/lib/mail/service";
import { withSignature } from "@/lib/mail/types";
import { dueReminders, isReminderStillValid, markReminder } from "@/lib/appointments/mail-adapter";
import { publicClient, reconcileCalendar, rpc } from "@/lib/appointments/server";
import { syncGoogleChanges } from "@/lib/appointments/google-sync";
import { serverRpcKey } from "@/lib/appointments/secrets";

export type JobName = "agenda" | "rappels" | "gmail" | "fireflies";

async function report(sb: SupabaseClient, job: JobName, ok: boolean, error: string | null, result: unknown) {
  await sb.rpc("job_report", { p_server_key: serverRpcKey(), p_job: job, p_ok: ok, p_error: error, p_result: result ?? null });
}

/** Exécute une tâche et rapporte son issue ; une tâche en échec n'empêche pas les suivantes. */
export async function runJob(job: JobName, fn: (sb: SupabaseClient) => Promise<unknown>, sb: SupabaseClient = publicClient()) {
  try {
    const result = await fn(sb);
    const skipped = !!result && typeof result === "object" && "skipped" in result;
    await report(sb, job, true, null, result);
    return { job, ok: true, skipped, result };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await report(sb, job, false, msg, null).catch(() => undefined);
    return { job, ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Agenda : la base fait foi (annulations, reports, modifications), puis lecture des changements faits dans Google
// ---------------------------------------------------------------------------
export async function agendaJob(sb: SupabaseClient, origin?: string | null) {
  const pushed = await reconcileCalendar(sb, origin, 50);
  const pulled = await syncGoogleChanges(sb);
  return { pushed, pulled };
}

// ---------------------------------------------------------------------------
// Compte Gmail côté serveur (jeton chiffré, renouvelé si besoin)
// ---------------------------------------------------------------------------
type ServerAccount = { id: string; email: string; display_name: string | null; scopes: string[]; signature: string; refresh_token_enc: string; access_token_enc: string | null; access_token_expires_at: string | null };

async function gmailAccess(sb: SupabaseClient): Promise<{ account: ServerAccount; token: string } | { skipped: string }> {
  const c = mailConfig();
  if (!c) return { skipped: "Gmail n'est pas configuré sur le serveur" };
  const account = await rpc<ServerAccount | null>(sb, "mail_server_account", { p_server_key: serverRpcKey() });
  if (!account) return { skipped: "Aucun compte Gmail connecté" };
  if (account.access_token_enc && account.access_token_expires_at && Date.parse(account.access_token_expires_at) > Date.now() + 60_000) {
    return { account, token: decryptSecret(account.access_token_enc, c.tokenKey) };
  }
  try {
    const t = await refreshAccess(c, decryptSecret(account.refresh_token_enc, c.tokenKey));
    await rpc(sb, "mail_server_store_access", {
      p_server_key: serverRpcKey(), p_id: account.id, p_access_enc: encryptSecret(t.accessToken, c.tokenKey), p_expires: t.expiresAt,
      p_refresh_enc: t.refreshToken ? encryptSecret(t.refreshToken, c.tokenKey) : null,
    });
    return { account, token: t.accessToken };
  } catch (e) {
    if (e instanceof GoogleError && e.code === "revoked") {
      await rpc(sb, "mail_server_mark_reconnect", { p_server_key: serverRpcKey(), p_id: account.id, p_error: e.message });
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Rappels de rendez-vous (Q02) : échéances dues, version et révision vérifiées juste avant l'envoi, un envoi par
// clé, résultat incertain jamais renvoyé, au plus `quota` envois par passage, suspension globale respectée (en base).
// ---------------------------------------------------------------------------
export async function remindersJob(sb: SupabaseClient, opts: { quota?: number; origin?: string | null } = {}) {
  const due = await dueReminders({ sb, limit: opts.quota ?? 20, origin: opts.origin });
  if (!due.length) return { sent: 0, failed: 0, skipped_invalid: 0 };
  const access = await gmailAccess(sb);
  if ("skipped" in access) return access;
  const { account, token } = access;
  let sent = 0, failed = 0, invalid = 0;
  for (const r of due) {
    if (!(await isReminderStillValid(r.reminderId, r.revision, sb))) { invalid++; continue; }
    const rfc = `<rappel-${r.dedupKey.replace(/[^A-Za-z0-9._-]/g, "")}@cely.local>`;
    const record = (status: "accepted" | "failed" | "uncertain", extra: Record<string, unknown> = {}) => rpc(sb, "mail_server_record", {
      p_server_key: serverRpcKey(),
      p: { account_id: account.id, status, company_id: r.crm.companyId, person_id: r.crm.personId, to: [r.to.email], subject: r.subject, body: r.text,
        dedupe_key: `rappel:${r.dedupKey}`, business_type: "appointment_reminder", business_id: r.bookingId, rfc_message_id: rfc, ...extra },
    });
    const raw = buildMime({ from: { email: account.email, name: account.display_name }, to: [r.to.email], subject: r.subject, text: withSignature(r.text, account.signature), messageId: rfc });
    const out = await gmailSend(token, raw);
    if (out.kind === "accepted") {
      await markReminder(r.reminderId, r.revision, { status: "sent", messageId: out.messageId }, sb);
      await record("accepted", { provider_message_id: out.messageId, provider_thread_id: out.threadId });
      sent++;
    } else {
      // incertain : marqué en échec pour ne JAMAIS renvoyer (le message est peut-être parti)
      await markReminder(r.reminderId, r.revision, { status: "failed", error: out.message }, sb);
      await record(out.kind === "uncertain" ? "uncertain" : "failed", { error: out.message });
      failed++;
      if (out.kind === "failed" && (out.code === "quota" || out.code === "unauthorized")) break;
    }
  }
  return { sent, failed, skipped_invalid: invalid };
}

// ---------------------------------------------------------------------------
// Réception Gmail (Q03) : initiale bornée (30 jours, 150 messages), puis incrémentale par historique ; reprise
// bornée (3 jours) si l'historique a expiré. Les doublons sont écartés en base (identifiant Gmail, Message-ID).
// ---------------------------------------------------------------------------
export async function gmailJob(sb: SupabaseClient) {
  const access = await gmailAccess(sb);
  if ("skipped" in access) return access;
  const { account, token } = access;
  if (!account.scopes.includes(GMAIL_READ_SCOPE)) return { skipped: "Lecture Gmail non autorisée : reconnectez Gmail pour recevoir les réponses" };
  const cursor = await rpc<{ history_id: string | null; initial_done_at: string | null } | null>(sb, "mail_sync_cursor", { p_server_key: serverRpcKey(), p_account: account.id });
  let ids: string[] = [];
  let historyId = "";
  let initial = false;
  try {
    if (!cursor?.history_id) {
      historyId = await profileHistoryId(token);
      initial = !cursor?.initial_done_at;
      ids = await listRecent(token, initial ? 30 : 3, initial ? 150 : 100);
    } else {
      ({ ids, historyId } = await listSince(token, cursor.history_id));
    }
  } catch (e) {
    if (e instanceof GmailReadError && e.status === 404) {
      await rpc(sb, "mail_sync_error", { p_server_key: serverRpcKey(), p_account: account.id, p_error: "Historique Gmail expiré : reprise sur 3 jours", p_reset_history: true });
      historyId = await profileHistoryId(token);
      ids = await listRecent(token, 3, 100);
    } else {
      await rpc(sb, "mail_sync_error", { p_server_key: serverRpcKey(), p_account: account.id, p_error: e instanceof Error ? e.message : String(e) }).catch(() => undefined);
      throw e;
    }
  }
  const messages = [];
  for (const id of ids.slice(0, 150)) messages.push(parseGmailMessage(await getMessage(token, id)));
  return rpc(sb, "mail_inbound_ingest", { p_server_key: serverRpcKey(), p_account: account.id, p_messages: messages, p_history_id: historyId, p_initial: initial });
}
