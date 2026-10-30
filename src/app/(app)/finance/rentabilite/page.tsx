import { PageHeader } from "@/components/ui";
import { PeriodSelector } from "@/components/finance/bits";
import { financeData, periodFrom } from "../load";
import { RentabiliteView } from "./rentabilite-view";

export default async function RentabilitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await financeData();
  const { period, prevHref, nextHref } = await periodFrom(searchParams, data.today);
  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader title="Rentabilité" description="Trésorerie réelle, EBITDA indicatif, prévisions et simulation. La simulation n'enregistre rien." />
      <PeriodSelector kind={period.kind} from={period.from} to={period.to} label={period.label} prevHref={prevHref("/finance/rentabilite")} nextHref={nextHref("/finance/rentabilite")} />
      <RentabiliteView data={data} from={period.from} to={period.to} label={period.label} />
    </div>
  );
}
