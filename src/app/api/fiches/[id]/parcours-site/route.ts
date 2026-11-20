// Parcours site d'une fiche (section « Parcours site ») : première et dernière source, visites, rendez-vous.
import { z } from "zod";
import { apiRead } from "@/lib/api";
import { CrmError } from "@/lib/crm/service";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return apiRead(async (sb) => {
    if (!z.uuid().safeParse(id).success) throw new CrmError("Fiche introuvable");
    const { data, error } = await sb.rpc("site_company_journey", { p_company: id });
    if (error) throw new CrmError("Parcours site indisponible");
    return data;
  });
}
