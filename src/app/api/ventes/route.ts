import { apiRead } from "@/lib/api";
import { latestQuotes } from "@/lib/proposals/service";
import { getSale, listSales } from "@/lib/sales/service";

/** Ventes gagnées et perdues (statuts actuels), avec suivi et facturation. `?fiche=<id>` : une seule fiche. */
export async function GET(req: Request) {
  const fiche = new URL(req.url).searchParams.get("fiche");
  return apiRead<unknown>(async (sb) => {
    if (fiche) return getSale(sb, fiche);
    // le devis de la proposition (numéro, lien, état renvoyés par Make) accompagne chaque vente gagnée
    const rows = await listSales(sb);
    const quotes = await latestQuotes(sb, [...new Set(rows.filter((r) => r.deal_status === "won").map((r) => r.company_id))]).catch(() => ({}) as Record<string, never>);
    return rows.map((r) => (quotes[r.company_id] ? { ...r, quote: quotes[r.company_id] } : r));
  });
}
