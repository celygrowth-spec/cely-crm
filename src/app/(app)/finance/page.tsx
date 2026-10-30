import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Card, PageHeader, Badge } from "@/components/ui";
import { Kpi, Money, PeriodSelector, UrssafBadge } from "@/components/finance/bits";
import { CashChart, CategoryChart } from "@/components/finance/charts";
import { QuickAdd } from "./quick-add";
import { financeData, periodFrom } from "./load";
import { hasActivity, monthlyCashSeries, paidByCategory, periodKpis, upcomingDeadlines, urssafRows, urssafSummary } from "@/lib/finance/calc";
import { addMonths, monthStart } from "@/lib/finance/dates";
import { eur } from "@/lib/finance/money";
import { formatDate, relativeDay } from "@/lib/format";

function Delta({ now, before }: { now: number; before: number }) {
  if (before === 0 && now === 0) return null;
  const d = now - before;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  return <span>{sign}{eur(Math.abs(d), { round: true })} vs période précédente ({eur(before, { round: true })})</span>;
}

export default async function FinanceOverview({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const data = await financeData();
  const { period, previous, prevHref, nextHref, query } = await periodFrom(searchParams, data.today);
  const k = periodKpis(data, period.from, period.to);
  const prev = periodKpis(data, previous.from, previous.to);
  const compare = hasActivity(data, previous.from, previous.to);
  const seriesFrom = period.kind === "mois" ? monthStart(addMonths(period.from, -5)) : period.from;
  const series = monthlyCashSeries(data, seriesFrom, period.to);
  const cats = paidByCategory(data, period.from, period.to);
  const deadlines = upcomingDeadlines(data).slice(0, 8);
  const rows = urssafRows(data);
  const us = urssafSummary(rows);
  const late = data.invoices.filter((i) => i.status === "en_retard").sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? ""));
  const empty = !data.invoices.length && !data.expenses.length && !data.missions.length;
  const vat = data.settings.at(-1)?.vat_enabled;

  return (
    <div className="max-w-6xl space-y-5">
      <PageHeader
        title="Finance"
        description="Votre cockpit : ce qui est facturé, encaissé, dû, dépensé et à mettre de côté. Montants réels uniquement, prévisions signalées comme telles."
        actions={<QuickAdd data={data} />}
      />
      <PeriodSelector kind={period.kind} from={period.from} to={period.to} label={period.label} prevHref={prevHref("/finance")} nextHref={nextHref("/finance")} />

      {empty && (
        <Card className="p-4 text-sm">
          <p className="font-semibold">Pour commencer</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-muted">
            <li>Créez une <Link className="font-semibold text-violet-strong" href="/finance/clients">mission</Link> pour un client du CRM.</li>
            <li>Enregistrez vos <Link className="font-semibold text-violet-strong" href="/finance/revenus">revenus</Link> (factures émises) et leurs paiements.</li>
            <li>Ajoutez vos <Link className="font-semibold text-violet-strong" href="/finance/charges">charges et abonnements</Link>.</li>
            <li>Indiquez dans l&apos;onglet <Link className="font-semibold text-violet-strong" href="/finance/urssaf">URSSAF</Link> les périodes déjà déclarées ou payées.</li>
          </ol>
        </Card>
      )}

      <section aria-label="Indicateurs" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <Kpi title={`Facturé ${vat ? "HT" : ""}`} value={eur(k.invoiced.ht)} sub={compare ? <Delta now={k.invoiced.ht} before={prev.invoiced.ht} /> : `${k.invoiced.count} facture(s)`}
          definition="Somme des factures émises sur la période (date d'émission), avoirs déduits, factures annulées exclues. Facturé ne veut pas dire encaissé."
          href={`/finance/revenus?${query}`} />
        <Kpi title="Encaissé" value={eur(k.received)} sub={compare ? <Delta now={k.received} before={prev.received} /> : undefined}
          definition="Paiements réellement reçus des clients pendant la période (date de réception), remboursements déduits."
          href={`/finance/revenus?${query}&vue=paiements`} />
        <Kpi title="Paiements en attente" value={eur(k.pending)} tone={k.late ? "danger" : undefined}
          sub={k.late ? <span className="inline-flex items-center gap-1 font-semibold text-danger"><AlertTriangle size={12} aria-hidden /> dont {eur(k.late)} en retard ({k.lateCount})</span> : `${k.openCount} facture(s) ouverte(s), aucune en retard`}
          definition="À ce jour : reste dû sur les factures non soldées (montant TTC − avoirs − paiements). « En retard » : échéance de paiement dépassée."
          href="/finance/revenus?statut=ouvertes" />
        <Kpi title="Charges payées" value={eur(k.expensesPaid)} sub={compare ? <Delta now={k.expensesPaid} before={prev.expensesPaid} /> : undefined}
          definition="Charges validées comme payées pendant la période (date de paiement). Les cotisations URSSAF sont comptées à part."
          href={`/finance/charges?${query}&statut=paye`} />
        <Kpi title="Charges à venir (30 j)" value={<Money value={k.upcoming} />}
          sub={k.overdueExpenses.cents || k.overdueExpenses.unknown ? <span className="text-danger">+ <Money value={k.overdueExpenses} /> en retard</span> : undefined}
          definition="Charges « à payer » prévues dans les 30 prochains jours, y compris les échéances d'abonnement. Un montant non renseigné est signalé, jamais compté zéro."
          href="/finance/charges?statut=a_payer" />
        <Kpi title="Trésorerie de la période" value={eur(k.cash.net)} tone={k.cash.net < 0 ? "warning" : undefined}
          sub={<>Entrées {eur(k.cash.inflow, { round: true })} · sorties {eur(k.cash.outflow, { round: true })}{k.estimatedBalance !== null && <> · solde estimé {eur(k.estimatedBalance, { round: true })}</>}</>}
          definition="Encaissements réels − décaissements réels de la période (charges payées, cotisations URSSAF payées, remboursements). Le solde estimé n'apparaît que si un solde d'ouverture est renseigné dans les réglages."
          href="/finance/rentabilite" />
        <Kpi title="Cotisations à provisionner" value={<Money value={k.toProvision} />}
          definition="Somme, pour les périodes URSSAF non payées : montant déclaré s'il existe, sinon estimation au taux en vigueur sur le chiffre d'affaires encaissé. À mettre de côté."
          href="/finance/urssaf" />
        <Kpi title="Clients actifs" value={k.activeClients} definition="Fiches CRM ayant au moins une mission au statut « Actif »." href="/finance/clients" />
        <Kpi title="Revenu mensuel récurrent" value={<Money value={k.mrr} />}
          definition="Contractuel : somme des missions récurrentes actives ramenées au mois (HT). C'est une prévision, distincte du facturé et de l'encaissé."
          href="/finance/clients?type=recurrent" />
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4 lg:col-span-2">
          <h2 className="font-display text-base font-bold">Encaissements et décaissements réels</h2>
          <p className="mb-2 text-xs text-muted">Par mois, d&apos;après les paiements et charges enregistrés.</p>
          {series.some((s) => s.in || s.out) ? <CashChart series={series} /> : <p className="py-10 text-center text-sm text-muted">Aucun mouvement réel sur cette période.</p>}
          {series.some((s) => s.in || s.out) && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer font-semibold text-muted">Voir en tableau</summary>
              <table className="mt-2 w-full">
                <thead><tr className="text-left text-muted"><th className="py-1">Mois</th><th className="text-right">Entrées</th><th className="text-right">Sorties</th><th className="text-right">Solde</th></tr></thead>
                <tbody>{series.map((s) => <tr key={s.month} className="border-t border-line"><td className="py-1">{s.month.slice(0, 7)}</td><td className="text-right">{eur(s.in)}</td><td className="text-right">{eur(s.out)}</td><td className="text-right font-semibold">{eur(s.net)}</td></tr>)}</tbody>
              </table>
            </details>
          )}
        </Card>
        <Card className="p-4">
          <h2 className="font-display text-base font-bold">URSSAF</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            <li className="flex justify-between"><UrssafBadge state="a_preparer" /><span>{us.a_preparer}</span></li>
            <li className="flex justify-between"><UrssafBadge state="a_declarer" /><span className="font-semibold">{us.a_declarer}</span></li>
            <li className="flex justify-between"><UrssafBadge state="declare" /><span className="font-semibold">{us.declare}</span></li>
            <li className="flex justify-between"><UrssafBadge state="paye" /><span>{us.paye}</span></li>
          </ul>
          <p className="mt-3 text-xs text-muted">À provisionner : <span className="font-semibold text-ink"><Money value={us.toProvision} /></span></p>
          {rows[0] && <p className="mt-1 text-xs text-muted">Période en cours : {rows[0].start} → {rows[0].end}, échéance {formatDate(rows[0].deadline)}</p>}
          <Link href="/finance/urssaf" className="mt-2 inline-block text-xs font-semibold text-violet-strong">Ouvrir le suivi URSSAF →</Link>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <h2 className="font-display text-base font-bold">Charges payées par catégorie</h2>
          <p className="mb-2 text-xs text-muted">{period.label} · cotisations URSSAF comptées une seule fois.</p>
          {cats.length ? (
            <>
              <CategoryChart rows={cats} />
              <ul className="sr-only">{cats.map((c) => <li key={c.id}>{c.name} : {eur(c.cents)}</li>)}</ul>
            </>
          ) : <p className="py-8 text-center text-sm text-muted">Aucune charge payée sur la période.</p>}
        </Card>
        <Card className="p-4">
          <h2 className="font-display text-base font-bold">Prochaines échéances</h2>
          {deadlines.length ? (
            <ul className="mt-2 divide-y divide-line text-sm">
              {deadlines.map((d, i) => (
                <li key={i} className="flex items-center gap-2 py-1.5">
                  <Badge tone={d.late ? "danger" : "neutral"}>{d.late && <AlertTriangle size={11} aria-hidden />}{relativeDay(d.date)}</Badge>
                  <Link href={d.href} className="min-w-0 flex-1 truncate hover:text-violet-strong">
                    <span className="text-xs text-muted">{d.kind === "client" ? "Client · " : d.kind === "urssaf" ? "URSSAF · " : "Charge · "}</span>{d.label}
                  </Link>
                  <Money value={d.amount} className="text-xs font-semibold" />
                </li>
              ))}
            </ul>
          ) : <p className="py-8 text-center text-sm text-muted">Rien dans les 45 prochains jours.</p>}
        </Card>
        <Card className="p-4">
          <h2 className="font-display text-base font-bold">Paiements clients en retard</h2>
          {late.length ? (
            <ul className="mt-2 divide-y divide-line text-sm">
              {late.slice(0, 8).map((i) => (
                <li key={i.id} className="flex items-center gap-2 py-1.5">
                  <Link href={`/finance/revenus?facture=${i.id}`} className="min-w-0 flex-1 truncate hover:text-violet-strong">
                    {i.company_name}{i.reference && <span className="text-muted"> · {i.reference}</span>}
                    <span className="block text-xs text-danger">Échéance {formatDate(i.due_date)}</span>
                  </Link>
                  <span className="font-semibold">{eur(i.balance)}</span>
                </li>
              ))}
            </ul>
          ) : <p className="py-8 text-center text-sm text-muted">Aucun paiement en retard.</p>}
        </Card>
      </div>
    </div>
  );
}
