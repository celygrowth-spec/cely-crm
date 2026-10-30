"use client";

import { useState } from "react";
import { Card, Field, Input, Select, cn } from "@/components/ui";
import { Legend3, Money, MoneyInput } from "@/components/finance/bits";
import { ForecastChart } from "@/components/finance/charts";
import { ebitda, estimatedBalanceAt, forecast, periodCash, cashOut, simulate, subscriptionActive } from "@/lib/finance/calc";
import { monthLongLabel } from "@/lib/finance/dates";
import { eur, formatRate } from "@/lib/finance/money";
import type { FinanceData } from "@/lib/finance/types";

export function RentabiliteView({ data, from, to, label }: { data: FinanceData; from: string; to: string; label: string }) {
  const cash = periodCash(data, from, to);
  const out = cashOut(data, from, to);
  const balance = estimatedBalanceAt(data, to < data.today ? to : data.today);
  const [includeUrssaf, setIncludeUrssaf] = useState(true);
  const e = ebitda(data, from, to, { includeUrssaf });
  const [horizon, setHorizon] = useState<3 | 6>(3);
  const fc = forecast(data, horizon);

  return (
    <div className="space-y-5">
      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Trésorerie de la période</h2>
        <p className="text-xs text-muted">{label} · encaissements réels − décaissements réels. Ce n&apos;est ni un bénéfice ni un EBITDA.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <div><p className="font-label text-xs text-muted">Encaissements</p><p className="text-lg font-bold">{eur(cash.inflow)}</p></div>
          <div><p className="font-label text-xs text-muted">Décaissements</p><p className="text-lg font-bold">{eur(cash.outflow)}</p><p className="text-[11px] text-muted">charges {eur(out.expenses, { round: true })} · URSSAF {eur(out.urssaf, { round: true })}{out.refunds ? ` · remboursements ${eur(out.refunds, { round: true })}` : ""}</p></div>
          <div><p className="font-label text-xs text-muted">Trésorerie de la période</p><p className="text-lg font-extrabold">{eur(cash.net)}</p></div>
          <div>
            <p className="font-label text-xs text-muted">Solde de trésorerie estimé</p>
            {balance !== null ? <p className="text-lg font-bold">{eur(balance)}</p> : <p className="text-sm text-muted">Renseignez un solde d&apos;ouverture dans les réglages pour l&apos;afficher.</p>}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="font-display text-base font-bold">Calculateur d&apos;EBITDA indicatif</h2>
        <p className="text-xs text-muted">{label} · résultat d&apos;exploitation avant intérêts, impôts, amortissements et provisions, calculé à partir de vos données.</p>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <table className="w-full text-sm">
            <tbody>
              <tr><td className="py-1">Produits d&apos;exploitation (facturé HT, avoirs déduits)</td><td className="text-right font-semibold">{eur(e.income)}</td></tr>
              {e.included.map((c) => <tr key={c.id} className="text-muted"><td className="py-0.5 pl-3">− {c.name}</td><td className="text-right"><Money value={{ cents: c.cents, unknown: c.unknown }} /></td></tr>)}
              {includeUrssaf && <tr className="text-muted"><td className="py-0.5 pl-3">− Cotisations URSSAF de la période (déclarées, sinon estimées)</td><td className="text-right">{eur(e.urssaf)}</td></tr>}
              <tr className="border-t border-line"><td className="py-1.5 font-bold">EBITDA indicatif</td><td className="text-right font-extrabold"><Money value={{ cents: e.value, unknown: e.unknown }} /></td></tr>
            </tbody>
          </table>
          <div className="space-y-2 text-xs text-muted">
            <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={includeUrssaf} onChange={(ev) => setIncludeUrssaf(ev.target.checked)} /> Déduire les cotisations sociales de l&apos;exploitant</label>
            <p><strong className="text-ink">Catégories incluses :</strong> {e.included.length ? e.included.map((c) => c.name).join(", ") : "aucune charge sur la période"}.</p>
            <p><strong className="text-ink">Catégories exclues :</strong> {e.excluded.length ? e.excluded.map((c) => `${c.name} (${eur(c.cents)})`).join(", ") : "aucune"} — réglable par catégorie dans les réglages Finance.</p>
            <p><strong className="text-ink">Toujours exclus :</strong> intérêts et frais financiers, impôt sur le revenu, amortissements et provisions. L&apos;application ne les suit pas ; si vous en saisissez, classez-les dans une catégorie exclue.</p>
            <p><strong className="text-ink">Hypothèses :</strong> produits = facturé de la période (date d&apos;émission) ; charges = charges payées ou à payer datées de la période (montant HT si renseigné, sinon montant payé) ; cotisations des périodes URSSAF qui commencent dans l&apos;intervalle.</p>
            <p className="rounded-md bg-surface px-2 py-1.5">Indicateur de gestion uniquement : ce n&apos;est ni votre revenu personnel disponible, ni un résultat fiscal certifié. En micro-entreprise, l&apos;impôt et les cotisations ne se calculent pas sur ce montant.</p>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-base font-bold">Prévisions</h2>
            <p className="text-xs text-muted">À partir des missions actives, factures à encaisser, charges planifiées, abonnements et cotisations estimées. Les opportunités du pipeline ne sont jamais comptées.</p>
          </div>
          <div role="group" aria-label="Horizon" className="inline-flex rounded-lg border border-line p-0.5">
            {([3, 6] as const).map((h) => (
              <button key={h} aria-pressed={horizon === h} onClick={() => setHorizon(h)} className={cn("rounded-md px-3 py-1 text-xs font-semibold", horizon === h ? "bg-ink text-white" : "text-muted")}>{h} mois</button>
            ))}
          </div>
        </div>
        <div className="mt-2"><Legend3 /></div>
        <ForecastChart months={fc} />
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[720px] text-xs">
            <thead>
              <tr className="text-left text-muted"><th className="py-1">Mois</th><th className="text-right">Entrées réalisées</th><th className="text-right">prévues</th><th className="text-right">estimées</th><th className="text-right">Sorties réalisées</th><th className="text-right">prévues</th><th className="text-right">estimées</th><th className="text-right">dont cotisations</th><th className="text-right">Solde du mois</th><th className="text-right">Trésorerie estimée</th></tr>
            </thead>
            <tbody>
              {fc.map((m) => (
                <tr key={m.month} className="border-t border-line">
                  <td className="py-1 font-semibold capitalize">{monthLongLabel(m.month)}{m.unknown > 0 && <span className="block font-normal text-warning">{m.unknown} montant(s) inconnu(s)</span>}</td>
                  <td className="text-right">{eur(m.inRealise, { round: true })}</td><td className="text-right">{eur(m.inPrevu, { round: true })}</td><td className="text-right italic">{eur(m.inEstime, { round: true })}</td>
                  <td className="text-right">{eur(m.outRealise, { round: true })}</td><td className="text-right">{eur(m.outPrevu, { round: true })}</td><td className="text-right italic">{eur(m.outEstime, { round: true })}</td>
                  <td className="text-right italic">{eur(m.contributions, { round: true })}</td>
                  <td className="text-right font-semibold">{eur(m.net, { round: true })}</td>
                  <td className="text-right">{m.balance !== null ? eur(m.balance, { round: true }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-[11px] text-muted">Mois en cours : le réalisé couvre jusqu&apos;à aujourd&apos;hui. Factures en retard et charges impayées sont rattachées au mois en cours.</p>
        </div>
      </Card>

      <Simulation data={data} />
    </div>
  );
}

function Simulation({ data }: { data: FinanceData }) {
  const [extra, setExtra] = useState<number | null>(null);
  const [pct, setPct] = useState("0");
  const [expense, setExpense] = useState<number | null>(null);
  const [sub, setSub] = useState("");
  const p = Number.parseInt(pct, 10);
  const r = simulate(data, {
    extraRecurring: extra ?? 0,
    revenueChangePct: Number.isFinite(p) ? Math.max(-100, Math.min(500, p)) : 0,
    newMonthlyExpense: expense ?? 0,
    endSubscriptionId: sub || null,
  });
  const subs = data.subscriptions.filter((s) => subscriptionActive(s, data.today) && s.amount != null);
  const row = (l: string, a: number, b: number, strong?: boolean) => (
    <tr className={cn("border-t border-line", strong && "font-bold")}>
      <td className="py-1">{l}</td><td className="text-right">{eur(a)}</td><td className="text-right">{eur(b)}</td>
      <td className={cn("text-right", b - a > 0 ? "text-ink" : "text-muted")}>{b - a === 0 ? "—" : `${b - a > 0 ? "+" : "−"}${eur(Math.abs(b - a))}`}</td>
    </tr>
  );
  return (
    <Card className="p-4">
      <h2 className="font-display text-base font-bold">Simulation</h2>
      <p className="text-xs text-muted">Hypothèses appliquées à la moyenne mensuelle des {r.months} prochains mois de la prévision. Rien n&apos;est enregistré.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-4">
        <Field label="Nouveau client récurrent (HT / mois)"><MoneyInput value={extra} onChange={setExtra} aria-label="Nouveau client récurrent" /></Field>
        <Field label="Variation des recettes (%)"><Input type="number" min={-100} max={500} value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
        <Field label="Nouvelle charge (par mois)"><MoneyInput value={expense} onChange={setExpense} aria-label="Nouvelle charge mensuelle" /></Field>
        <Field label="Arrêt d'un abonnement">
          <Select value={sub} onChange={(e) => setSub(e.target.value)}>
            <option value="">Aucun</option>
            {subs.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </Field>
      </div>
      <table className="mt-4 w-full max-w-2xl text-sm">
        <thead><tr className="text-left font-label text-[11px] text-muted"><th>Par mois</th><th className="text-right">Actuel</th><th className="text-right">Simulé</th><th className="text-right">Écart</th></tr></thead>
        <tbody>
          {row("Recettes prévues et estimées", r.before.in, r.after.in)}
          {row("Charges (hors cotisations)", r.before.out, r.after.out)}
          {row("Cotisations estimées", r.before.contributions, r.after.contributions)}
          {row("Solde mensuel prévisionnel", r.before.net, r.after.net, true)}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">
        Rentabilité estimée (solde / recettes) : {r.before.marginPct ?? "—"} % → <strong className="text-ink">{r.after.marginPct ?? "—"} %</strong>.
        {r.contributionRateMilli ? ` Cotisations sur la variation de recettes au taux de ${formatRate(r.contributionRateMilli)}.` : " Taux de cotisation non disponible : variation de cotisations non estimée."}
        {r.savedSubscription > 0 && ` Économie de l'abonnement : ${eur(r.savedSubscription)} par mois.`}
      </p>
    </Card>
  );
}
