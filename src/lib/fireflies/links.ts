import "server-only";
// Rattachement manuel (session du propriétaire, sous RLS).
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";

const uuid = z.uuid();

export const linkActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("link"), company_id: uuid, person_id: uuid.nullish(), booking_id: uuid.nullish() }),
  z.object({ action: z.literal("ignore") }),
  z.object({ action: z.literal("reset") }),
]);
export type LinkAction = z.infer<typeof linkActionSchema>;

export const callIdSchema = uuid;

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
