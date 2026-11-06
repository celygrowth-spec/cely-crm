// Accueil Finance : ajouter un revenu en quelques secondes, puis trois chiffres (encaissé, reste à
// encaisser, charges payées), le graphique Réel / Prévisions et « À encaisser ». Le détail
// (facturé, récurrent, clients, URSSAF, rentabilité) reste dans les vues dédiées.
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Card, PageHeader } from "@/components/ui";
import { Money, PeriodSelector } from "@/components/finance/bits";
import { QuickAdd } from "./quick-add";
import { MainChart, ToCollect } from "./home-charts";
import { financeData, periodFrom } from "./load";
import { contractualMrr, forecast, homeKpis, invoicedIn, realSeries, receivableAging, urssafRows, urssafSummary } from "@/lib/finance/calc";
import { addMonths, monthEnd, monthStart } from "@/lib/finance/dates";
import { eur } from "@/lib/finance/money";

function Figure({ label, value, sub, href, tone, hint }: { label: string; value: string; sub?: React.ReactNode; href: string; tone?: "danger"; hint: string }) {
  return (
    <Link href={href} title={hint} data-kpi={label}
      className="group flex min-w-0 flex-col rounded-2xl border border-line bg-white p-3 transition-colors hover:border-violet sm:p-4">
      <span className="flex items-start justify-between gap-1 font-label text-[11px] leading-tight font-semibold text-muted sm:text-xs">
        <span>{label}</span>
        <ArrowRight size={13} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
      </span>
      <span className="mt-1 font-display text-base font-extrabold tracking-tight text-ink tabular-nums sm:text-2xl">{value}</span>
      {sub && <span className={tone === "danger" ? "mt-0.5 text-[11px] font-semibold text-danger sm:text-xs" : "mt-0.5 text-[11px] text-muted sm:text-xs"}>{sub}</span>}
    </Link>
  );
}

export default async function FinanceOverview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await financeData();
  const { period, prevHref, nextHref } = await periodFrom(searchParams, data.today);
  const k = homeKpis(data, period.from, period.to);
  // Réel : les 6 derniers mois jusqu'à la fin de la période (ou toute la période si plus longue)
  const realFrom = period.kind === "mois" ? monthStart(addMonths(period.from, -5)) : period.from;
  const real = realSeries(data, realFrom, monthEnd(period.to));
  const plan6 = forecast(data, 6);
  const plan3 = plan6.slice(0, 4);
  const aging = receivableAging(data);
  const empty = !data.invoices.length && !data.expenses.length && !data.missions.length;
  const range = `du=${period.from}&au=${period.to}`;
  const inv = invoicedIn(data.invoices, period.from, period.to);
  const mrr = contractualMrr(data.missions);
  const us = urssafSummary(urssafRows(data));

  return (
    <div className="max-w-6xl space-y-4">
      <PageHeader title="Finance" actions={<QuickAdd data={data} />} />
      <PeriodSelector kind={period.kind} from={period.from} to={period.to} label={period.label} prevHref={prevHref("/finance")} nextHref={nextHref("/finance")} />

      {empty ? (
        <Card className="flex flex-col items-start gap-3 p-6">
          <div>
            <p className="font-display text-lg font-bold">Commencez par un revenu</p>
            <p className="text-sm text-muted">Ponctuel ou mensuel : il apparaît aussitôt dans vos prévisions, puis dans « Encaissé » quand vous le recevez.</p>
          </div>
          <QuickAdd data={data} only="revenu" />
        </Card>
      ) : (
        <>
          <section aria-label="Chiffres de la période" className="grid grid-cols-3 gap-2 sm:gap-3">
            <Figure label="Encaissé" value={eur(k.received)} href={`/finance/revenus?vue=paiements&${range}`}
              hint="Argent effectivement reçu sur la période, à la date du paiement (remboursements déduits)." />
            <Figure label="Reste à encaisser" value={eur(k.outstanding)} href="/finance/revenus?vue=factures&statut=ouvertes"
              tone={k.late ? "danger" : undefined}
              sub={k.late ? <span className="inline-flex items-center gap-1"><AlertTriangle size={11} aria-hidden /> dont {eur(k.late)} en retard</span> : undefined}
              hint="Solde des factures émises encore ouvertes à la fin de la période (montant − avoirs − paiements reçus à cette date)." />
            <Figure label="Charges payées" value={eur(k.spent)} href={`/finance/charges?${range}&statut=paye`}
              sub={k.spentUrssaf ? `dont URSSAF ${eur(k.spentUrssaf, { round: true })}` : undefined}
              hint="Argent effectivement dépensé sur la période, à la date du paiement (charges et cotisations URSSAF)." />
          </section>

          <MainChart real={real} plan3={plan3} plan6={plan6} />
          <ToCollect buckets={aging} />
        </>
      )}

      <nav aria-label="Vues de détail" className="flex flex-wrap gap-x-5 gap-y-1.5 border-t border-line pt-3 text-xs text-muted">
        <Link className="hover:text-ink" href={`/finance/revenus?vue=factures&${range}`}>Facturé sur la période : <span className="font-semibold text-ink">{eur(inv.ht)}</span></Link>
        <Link className="hover:text-ink" href="/finance/revenus?type=mensuel">Revenu mensuel récurrent : <span className="font-semibold text-ink"><Money value={mrr} /></span></Link>
        <Link className="hover:text-ink" href="/finance/clients">Clients actifs</Link>
        <Link className="hover:text-ink" href="/finance/urssaf">URSSAF à provisionner : <span className="font-semibold text-ink"><Money value={us.toProvision} /></span></Link>
        <Link className="hover:text-ink" href="/finance/rentabilite">Rentabilité →</Link>
      </nav>
    </div>
  );
}
