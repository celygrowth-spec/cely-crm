"use client";

// Accueil Finance : grand graphique à onglets (Réel / Prévisions) et graphique compact « À encaisser ».
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AgingChart, PlanChart, PlanLegend, RealChart } from "@/components/finance/charts";
import { cn } from "@/components/ui";
import type { AgingBucket, ForecastMonth } from "@/lib/finance/calc";
import { eur, sum } from "@/lib/finance/money";
import { monthLabel } from "@/lib/finance/dates";

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-lg border border-line bg-white p-0.5">
      {options.map(([k, l]) => (
        <button key={k} type="button" role="tab" aria-selected={value === k} onClick={() => onChange(k)}
          className={cn("rounded-md px-3 py-1 text-xs font-semibold", value === k ? "bg-ink text-white" : "text-muted hover:text-ink")}>{l}</button>
      ))}
    </div>
  );
}

export function MainChart({ real, plan3, plan6 }: { real: { month: string; in: number; out: number }[]; plan3: ForecastMonth[]; plan6: ForecastMonth[] }) {
  const [tab, setTab] = useState<"reel" | "prev">("reel");
  const [h, setH] = useState<"3" | "6">("3");
  const plan = h === "3" ? plan3 : plan6;
  const realEmpty = !real.some((r) => r.in || r.out);
  const planIn = sum(plan.map((m) => m.inRealise + m.inPrevu + m.inEstime));
  const planOut = sum(plan.map((m) => m.outRealise + m.outPrevu + m.outEstime));
  return (
    <section aria-labelledby="graph-titre" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="graph-titre" className="sr-only">Évolution</h2>
        <Seg label="Vue du graphique" value={tab} onChange={setTab} options={[["reel", "Réel"], ["prev", "Prévisions"]]} />
        {tab === "prev" && <Seg label="Horizon" value={h} onChange={setH} options={[["3", "3 mois"], ["6", "6 mois"]]} />}
        <p className="ml-auto text-xs text-muted">
          {tab === "reel"
            ? `${monthLabel(real[0]?.month ?? "")} → ${monthLabel(real.at(-1)?.month ?? "")} · par date de paiement`
            : <>Entrées <span className="font-semibold text-ink">{eur(planIn, { round: true })}</span> · sorties <span className="font-semibold text-ink">{eur(planOut, { round: true })}</span></>}
        </p>
      </div>
      <div className="mt-3">
        {tab === "reel" ? (
          realEmpty ? <p className="py-16 text-center text-sm text-muted">Aucun encaissement ni charge payée sur ces mois.</p> : <RealChart series={real} />
        ) : (
          <>
            <PlanChart months={plan} />
            <PlanLegend />
            <p className="mt-2 text-xs text-muted">Hachuré : prévisions (échéances mensuelles, revenus ponctuels, abonnements, cotisations estimées). Une échéance déjà facturée apparaît dans « Factures à encaisser », jamais deux fois.</p>
          </>
        )}
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer font-semibold text-muted">Voir en tableau</summary>
        <table className="mt-2 w-full">
          <thead><tr className="text-left text-muted"><th className="py-1">Mois</th><th className="text-right">Entrées</th><th className="text-right">Sorties</th></tr></thead>
          <tbody>
            {tab === "reel"
              ? real.map((s) => <tr key={s.month} className="border-t border-line"><td className="py-1">{monthLabel(s.month)}</td><td className="text-right">{eur(s.in)}</td><td className="text-right">{eur(s.out)}</td></tr>)
              : plan.map((m) => <tr key={m.month} className="border-t border-line"><td className="py-1">{monthLabel(m.month)}</td><td className="text-right">{eur(m.inRealise + m.inPrevu + m.inEstime)}</td><td className="text-right">{eur(m.outRealise + m.outPrevu + m.outEstime)}</td></tr>)}
          </tbody>
        </table>
      </details>
    </section>
  );
}

export function ToCollect({ buckets }: { buckets: AgingBucket[] }) {
  const router = useRouter();
  const total = sum(buckets.map((b) => b.total));
  const late = buckets.find((b) => b.key === "retard")!;
  return (
    <section aria-labelledby="a-encaisser" className="rounded-2xl border border-line bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="a-encaisser" className="font-display text-base font-bold">À encaisser</h2>
        <p className="text-xs text-muted">Factures ouvertes par échéance · {eur(total)}{late.total > 0 && <span className="font-semibold text-danger"> · dont {eur(late.total)} en retard</span>}</p>
      </div>
      {total === 0 ? <p className="py-8 text-center text-sm text-muted">Aucune facture en attente de paiement.</p> : (
        <>
          <AgingChart buckets={buckets.filter((b) => b.key !== "sans" || b.total > 0)} onOpen={(ids) => router.push(`/finance/revenus?vue=factures&ids=${ids.join(",")}`)} />
          <ul className="sr-only">{buckets.map((b) => <li key={b.key}>{b.label} : {eur(b.total)}</li>)}</ul>
          <p className="text-xs text-muted">Cliquez sur une barre pour ouvrir les factures concernées. Les revenus seulement prévus figurent dans « Prévisions ».</p>
        </>
      )}
    </section>
  );
}
