import { apiRead } from "@/lib/api";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { todayISO } from "@/lib/format";

export async function GET() {
  return apiRead(async (sb) => {
    const { data, error } = await sb.rpc("nav_counters", { p_today: todayISO() });
    if (error) throw new CrmError(friendlyError(error));
    return data as { todo: number; due: number; replies: number };
  });
}
