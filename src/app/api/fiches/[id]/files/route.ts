import { apiRead } from "@/lib/api";
import { listFiles } from "@/lib/crm/files";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead((sb) => listFiles(sb, id));
}
