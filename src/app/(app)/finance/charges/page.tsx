import { financeData } from "../load";
import { ChargesView } from "./charges-view";

export default async function ChargesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const data = await financeData();
  const sp = await searchParams;
  return <ChargesView data={data} initial={{ from: sp.du ?? "", to: sp.au ?? "", status: sp.statut ?? "", category: sp.categorie ?? "" }} />;
}
