"use client";

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { Badge, Button, Card, EmptyState, PageHeader } from "@/components/ui";
import { Money } from "@/components/finance/bits";
import { ExpenseModal, type ExpenseDefaults } from "@/components/finance/forms";
import { annualEquivalent, monthlyEquivalent, settingsAt, subscriptionActive, subscriptionTotals } from "@/lib/finance/calc";
import { FREQUENCY } from "@/lib/finance/labels";
import { eur } from "@/lib/finance/money";
import type { FinanceData } from "@/lib/finance/types";
import { formatDate } from "@/lib/format";
import { ChargesTabs } from "../charges-tabs";

export function SubscriptionsView({ data }: { data: FinanceData }) {
  const [modal, setModal] = useState<ExpenseDefaults | null>(null);
  const vat = settingsAt(data.settings, data.today)?.vat_enabled ?? false;
  const t = subscriptionTotals(data.subscriptions, data.today);
  const cat = (id: string | null) => data.categories.find((c) => c.id === id)?.name ?? "Sans catégorie";
  const subs = [...data.subscriptions].sort((a, b) => Number(subscriptionActive(b, data.today)) - Number(subscriptionActive(a, data.today)) || a.next_due_date.localeCompare(b.next_due_date));
  const unpaid = (id: string) => data.expenses.filter((e) => e.subscription_id === id && e.status === "a_payer").length;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Charges"
        description="Abonnements et charges récurrentes. Chaque échéance devient une charge « à payer » ; l'abonnement lui-même n'est jamais compté."
        actions={<Button variant="primary" onClick={() => setModal({ recurring: true })}><Plus size={15} /> Ajouter un abonnement</Button>}
      />
      <ChargesTabs />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Card className="p-3"><p className="font-label text-xs text-muted">Abonnements actifs</p><p className="font-display text-xl font-extrabold">{t.count}</p></Card>
        <Card className="p-3"><p className="font-label text-xs text-muted">Coût mensuel</p><p className="font-display text-xl font-extrabold"><Money value={t.monthly} /></p></Card>
        <Card className="p-3"><p className="font-label text-xs text-muted">Équivalent annuel</p><p className="font-display text-xl font-extrabold"><Money value={t.annual} /></p></Card>
      </div>
      {subs.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line text-left font-label text-[11px] text-muted">
                <th className="px-3 py-2">Abonnement</th><th>Catégorie</th><th>Fréquence</th><th className="text-right">Par échéance</th><th className="text-right">Par mois</th><th className="text-right">Par an</th>
                <th>Prochaine échéance</th><th>Renouvellement / résiliation</th><th />
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => {
                const active = subscriptionActive(s, data.today);
                const n = unpaid(s.id);
                return (
                  <tr key={s.id} className={`border-b border-line last:border-0 ${active ? "" : "text-muted"}`}>
                    <td className="px-3 py-2"><span className="font-semibold">{s.label}</span>{s.supplier && <span className="text-xs text-muted"> · {s.supplier}</span>}{!active && <Badge className="ml-1">Résilié</Badge>}{n > 0 && <span className="block text-[11px] text-warning">{n} échéance(s) à valider dans Charges</span>}</td>
                    <td className="text-xs">{cat(s.category_id)}</td>
                    <td className="text-xs">{FREQUENCY[s.frequency]}</td>
                    <td className="text-right"><Money value={s.amount} /></td>
                    <td className="text-right">{s.amount != null ? eur(monthlyEquivalent(s.amount, s.frequency)) : "—"}</td>
                    <td className="text-right">{s.amount != null ? eur(annualEquivalent(s.amount, s.frequency)) : "—"}</td>
                    <td className="text-xs">{active ? formatDate(s.next_due_date) : "—"}</td>
                    <td className="text-xs">{s.renewal_date && <>Renouvellement {formatDate(s.renewal_date)}</>}{s.end_date && <span className="block">Fin {formatDate(s.end_date)}</span>}{!s.renewal_date && !s.end_date && "—"}</td>
                    <td className="pr-2 text-right"><Button size="sm" variant="ghost" aria-label="Modifier" onClick={() => setModal({ subscription: s })}><Pencil size={13} /></Button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState title="Aucun abonnement" description="Ajoutez vos logiciels, hébergement, assurances… pour voir leur coût mensuel et annuel." action={<Button variant="primary" onClick={() => setModal({ recurring: true })}>Ajouter un abonnement</Button>} />
      )}
      <ExpenseModal open={!!modal} onClose={() => setModal(null)} defaults={modal ?? {}} categories={data.categories} vatEnabled={vat} />
    </div>
  );
}
