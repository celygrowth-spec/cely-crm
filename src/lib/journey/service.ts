import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { CrmError, friendlyError } from "@/lib/crm/service";
import type { JourneyRow } from "./rules";

/** État du parcours des fiches concernées (appel, diagnostic, proposition, signature, onboarding), lu en une requête. */
export async function listJourney(sb: SupabaseClient, companyIds?: string[]): Promise<JourneyRow[]> {
  let q = sb.from("company_journey").select("*").limit(2000);
  if (companyIds) {
    if (!companyIds.length) return [];
    q = q.in("company_id", z.array(z.uuid()).max(500).parse(companyIds));
  }
  const { data, error } = await q;
  if (error) throw new CrmError(friendlyError(error));
  return data as JourneyRow[];
}
