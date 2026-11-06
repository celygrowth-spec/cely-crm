import "server-only";
// Rattachement manuel et file « Appels à rattacher » (session du propriétaire, sous RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";

export type LinkCandidate = { company_id: string; name: string; website: string | null; archived: boolean; reasons: string[] };

export type CallToLink = {
  id: string;
  title: string;
  occurred_at: string | null;
  duration_minutes: number | null;
  participants: string[];
  link_reason: string | null;
  link_candidates: LinkCandidate[];
  booking_id: string | null;
};

const uuid = z.uuid();

export const linkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), company_id: uuid, person_id: uuid.nullish(), booking_id: uuid.nullish() }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("reset") }),
]);
export type LinkAction = z.infer<typeof linkActionSchema>;

export const callIdSchema = uuid;

export async function listCallsToLink(sb: SupabaseClient): Promise<CallToLink[]> {
  const { data, error } = await sb
    .from("fireflies_calls")
    .select("id, title, occurred_at, duration_minutes, participants, link_reason, link_candidates, booking_id")
    .eq("link_state", "to_link")
    .order("occurred_at", { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw new CrmError(friendlyError(error));
  return data as CallToLink[];
}

export async function applyLinkAction(sb: SupabaseClient, callId: string, a: LinkAction): Promise<void> {
  const { error } =
    a.action === "link"
      ? await sb.rpc("fireflies_link_call", { p_call: callId, p_company: a.company_id, p_person: a.person_id ?? null, p_booking: a.booking_id ?? null })
      : await sb.rpc(a.action === "ignore" ? "fireflies_ignore_call" : "fireflies_reset_call_link", { p_call: callId });
  if (error) throw new CrmError(friendlyError(error));
}

export async function rematchAsOwner(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.rpc("fireflies_rematch", {});
  if (error) throw new CrmError(friendlyError(error));
  return data as number;
}
