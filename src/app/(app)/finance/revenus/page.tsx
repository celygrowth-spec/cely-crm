import { financeData } from "../load";
import { RevenusView } from "./revenus-view";

export default async function RevenusPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const data = await financeData();
  const sp = await searchParams;
  return (
    <RevenusView
      data={data}
      initial={{
        client: sp.client ?? "", from: sp.du ?? "", to: sp.au ?? "", status: sp.statut ?? "", type: sp.type === "mensuel" || sp.type === "ponctuel" ? sp.type : "",
        view: sp.vue === "paiements" ? "paiements" : sp.vue === "factures" || sp.facture || sp.ids ? "factures" : "revenus",
        ids: sp.ids ? sp.ids.split(",").filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 200) : [],
      }}
      selectedId={sp.facture ?? null}
      revenueId={sp.revenu ?? null}
    />
  );
}
