import { apiRead } from "@/lib/api";
import { searchCompanies } from "@/lib/crm/service";

export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  return apiRead((sb) => searchCompanies(sb, u.get("q") ?? "", u.get("archived") === "1"));
}
