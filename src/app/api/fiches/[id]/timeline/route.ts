import { apiRead } from "@/lib/api";
import { getCompanyTimeline } from "@/lib/crm/service";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => getCompanyTimeline(sb, id));
}
