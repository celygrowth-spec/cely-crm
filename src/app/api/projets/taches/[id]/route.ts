import { apiRead } from "@/lib/api";
import { taskDetail } from "@/lib/projects/owner";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => taskDetail(sb, id));
}
