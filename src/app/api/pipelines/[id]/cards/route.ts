import { apiRead } from "@/lib/api";
import { CrmError, friendlyError } from "@/lib/crm/service";

const COLUMNS = "id, name, stage_id, amount, amount_recurring, primary_person_name, next_action_title, next_action_due, deal_status, deal_closed_at, lost_reason";
const STATUSES = ["open", "won", "lost"] as const;

/** Cartes du Kanban par issue (companies.deal_status, la même donnée que la fiche). `?compter=1` : nombre par issue. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const raw = url.searchParams.get("statut") ?? "open";
  const status = (STATUSES as readonly string[]).includes(raw) ? raw : "open";
  return apiRead(async (sb) => {
    if (url.searchParams.get("compter") === "1") {
      const counts = await Promise.all(STATUSES.map(async (s) => {
        const { count, error } = await sb.from("companies").select("id", { count: "exact", head: true })
          .eq("pipeline_id", id).eq("deal_status", s).is("archived_at", null).is("merged_into_id", null);
        if (error) throw new CrmError(friendlyError(error));
        return [s, count ?? 0] as const;
      }));
      return Object.fromEntries(counts) as Record<(typeof STATUSES)[number], number>;
    }
    const { data, error } = await sb
      .from("company_overview")
      .select(COLUMNS)
      .eq("pipeline_id", id)
      .eq("deal_status", status)
      .is("archived_at", null)
      .order(status === "open" ? "updated_at" : "deal_closed_at", { ascending: false, nullsFirst: false })
      .limit(1000);
    if (error) throw new CrmError(friendlyError(error));
    return data;
  });
}
