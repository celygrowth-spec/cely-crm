import "server-only";
// Modifications faites directement dans Google Agenda (périmètre pris en charge) :
// - uniquement les événements créés par l'outil, sur l'agenda de destination ;
// - un événement déplacé ou supprimé dans Google est SIGNALÉ (google_drift) avec l'horaire constaté ;
// - rien n'est modifié automatiquement dans Cely : l'administrateur applique l'horaire de Google
//   (report normal) ou rétablit Google selon la base (reprise).
// Mécanisme durable : jeton de synchronisation incrémentale conservé en base, renouvelé si Google l'expire.
import type { SupabaseClient } from "@supabase/supabase-js";
import * as google from "./google";
import { serverRpcKey } from "./secrets";
import { googleCreds, rpc } from "./server";

export type GoogleDrift = { kind: "moved"; start: string; end: string | null } | { kind: "deleted" };

type BookingRow = { id: string; status: string; starts_at: string; ends_at: string; calendar_target: boolean; google_event_id: string | null };

export function driftFor(b: BookingRow, e: google.ChangedEvent): GoogleDrift | null {
  if (b.status !== "confirmed" || !b.calendar_target) return null;
  if (e.status === "cancelled") return { kind: "deleted" };
  if (e.start && Date.parse(e.start) !== Date.parse(b.starts_at)) return { kind: "moved", start: new Date(e.start).toISOString(), end: e.end ? new Date(e.end).toISOString() : null };
  if (e.end && Date.parse(e.end) !== Date.parse(b.ends_at)) return { kind: "moved", start: new Date(e.start ?? b.starts_at).toISOString(), end: new Date(e.end).toISOString() };
  return null;
}

export async function syncGoogleChanges(sb: SupabaseClient): Promise<{ checked: number; drifts: number } | { skipped: string }> {
  const key = serverRpcKey();
  const creds = await googleCreds(sb).catch(() => null);
  if (!creds?.destination) return { skipped: "Aucun agenda de destination connecté" };
  const token = await rpc<string | null>(sb, "appt_google_events_sync_token", { p_server_key: key });
  let changes: { events: google.ChangedEvent[]; nextSyncToken: string };
  try {
    changes = await google.listEventChanges(creds.token, creds.destination, token);
  } catch (e) {
    if (e instanceof google.GoogleError && e.status === 410) {
      // jeton expiré : synchronisation complète
      changes = await google.listEventChanges(creds.token, creds.destination, null);
    } else {
      await rpc(sb, "appt_google_events_sync_state", { p_token: null, p_error: e instanceof Error ? e.message : String(e), p_server_key: key });
      throw e;
    }
  }
  let drifts = 0;
  for (const e of changes.events) {
    if (!e.bookingId) continue;
    const b = await rpc<BookingRow | null>(sb, "appt_server_booking", { p_server_key: key, p_id: e.bookingId });
    if (!b) continue;
    const d = driftFor(b, e);
    if (d) drifts++;
    await rpc(sb, "appt_google_drift", { p_booking: b.id, p_drift: d, p_server_key: key });
  }
  await rpc(sb, "appt_google_events_sync_state", { p_token: changes.nextSyncToken, p_error: null, p_server_key: key });
  return { checked: changes.events.length, drifts };
}
