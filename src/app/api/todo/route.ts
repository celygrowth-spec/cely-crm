import { apiRead } from "@/lib/api";
import { listTodos } from "@/lib/todo/service";

// To do list : toute la liste, ou les tâches ouvertes d'une fiche (?fiche=<id>).
export async function GET(req: Request) {
  const fiche = new URL(req.url).searchParams.get("fiche");
  return apiRead((sb) => listTodos(sb, fiche ? { companyId: fiche, openOnly: true } : {}));
}
