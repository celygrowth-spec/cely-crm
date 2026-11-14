import { apiRead } from "@/lib/api";
import { CrmError, friendlyError } from "@/lib/crm/service";
import { todayISO } from "@/lib/format";
import { inboxCounts, refreshIfStale } from "@/lib/lemlist/inbox";

export async function GET() {
  return apiRead(async (sb) => {
    // Messages lemlist : comptes relus s'ils datent de plus de 5 minutes (3 s au plus), puis non-lus.
    // Une erreur lemlist ne doit jamais empêcher les autres compteurs.
    const messages = await refreshIfStale(sb).then(() => inboxCounts(sb)).catch(() => ({ unread: 0, awaiting: 0 }));
    const { data, error } = await sb.rpc("nav_counters", { p_today: todayISO() });
    if (error) throw new CrmError(friendlyError(error));
    return { ...(data as { todo: number; due: number; replies: number }), messages: messages.unread };
  });
}
