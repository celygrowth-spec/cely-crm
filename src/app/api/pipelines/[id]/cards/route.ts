import { apiRead } from "@/lib/api";
import { CrmError, friendlyError } from "@/lib/crm/service";

const COLUMNS = "id, name, stage_id, amount, primary_person_name, next_action_title, next_action_due";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const status = new URL(req.url).searchParams.get("statut") ?? "open";
  return apiRead(async (sb) => {
    const { data, error } = await sb
      .from("company_overview")
      .select(COLUMNS)
      .eq("pipeline_id", id)
      .eq("deal_status", status)
      .is("archived_at", null)
      .order("updated_at", { ascending: false })
      .limit(1000);
    if (error) throw new CrmError(friendlyError(error));
    return data;
  });
}
