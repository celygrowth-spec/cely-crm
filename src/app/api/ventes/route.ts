import { apiRead } from "@/lib/api";
import { getSale, listSales } from "@/lib/sales/service";

/** Ventes gagnées et perdues (statuts actuels), avec suivi et facturation. `?fiche=<id>` : une seule fiche. */
export async function GET(req: Request) {
  const fiche = new URL(req.url).searchParams.get("fiche");
  return apiRead<unknown>((sb) => (fiche ? getSale(sb, fiche) : listSales(sb)));
}
