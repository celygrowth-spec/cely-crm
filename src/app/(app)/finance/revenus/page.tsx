import { financeData } from "../load";
import { RevenusView } from "./revenus-view";

export default async function RevenusPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const data = await financeData();
  const sp = await searchParams;
  return (
    <RevenusView
      data={data}
      initial={{ client: sp.client ?? "", from: sp.du ?? "", to: sp.au ?? "", status: sp.statut ?? "", view: sp.vue === "paiements" ? "paiements" : "factures" }}
      selectedId={sp.facture ?? null}
    />
  );
}
