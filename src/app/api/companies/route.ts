import { apiRead } from "@/lib/api";
import { CrmError, friendlyError } from "@/lib/crm/service";

// Base de prospects : une page filtrée et triée côté serveur.
export async function GET(req: Request) {
  const u = new URL(req.url).searchParams;
  const filters = { q: u.get("q"), list: u.get("list"), source: u.get("source"), tag: u.get("tag"), status: u.get("status"), pipeline: u.get("pipeline"), archived: u.get("archived") === "1" };
  return apiRead(async (sb) => {
    if (u.get("tags") === "1") {
      const { data, error } = await sb.rpc("company_tags");
      if (error) throw new CrmError(friendlyError(error));
      return data;
    }
    const { data, error } = await sb.rpc("companies_page", {
      p_filters: filters,
      p_sort: u.get("sort") ?? "created",
      p_asc: u.get("asc") === "1",
      p_limit: Number(u.get("limit") ?? 50),
      p_offset: Number(u.get("offset") ?? 0),
      p_ids_only: u.get("ids") === "1",
    });
    if (error) throw new CrmError(friendlyError(error));
    return data;
  });
}
