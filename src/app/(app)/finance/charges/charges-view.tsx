"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Download, Pencil, Plus } from "lucide-react";
import { deleteExpenseAction, payExpenseAction, setExpenseStatusAction } from "@/app/finance-actions";
import { Button, Card, EmptyState, Field, Input, Modal, PageHeader, Select, Spinner, cn } from "@/components/ui";
import { ExpenseBadge, Money, MoneyInput } from "@/components/finance/bits";
import { ExpenseModal, type ExpenseDefaults } from "@/components/finance/forms";
import { expenseDate, settingsAt } from "@/lib/finance/calc";
import { EXPENSE_STATUS } from "@/lib/finance/labels";
import { eur, sumKnown } from "@/lib/finance/money";
import type { Expense, FinanceData } from "@/lib/finance/types";
import { formatDate, todayISO } from "@/lib/format";
import { ChargesTabs } from "./charges-tabs";

type Filters = { from: string; to: string; status: string; category: string };

export function ChargesView({ data, initial }: { data: FinanceData; initial: Filters }) {
  const router = useRouter();
  const [f, setF] = useState(initial);
  const [modal, setModal] = useState<ExpenseDefaults | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);
  const [pending, start] = useTransition();
  const vat = settingsAt(data.settings, data.today)?.vat_enabled ?? false;
  const cat = (id: string | null) => data.categories.find((c) => c.id === id)?.name ?? "Sans catégorie";
  const rows = data.expenses
    .filter((e) => (!f.from || expenseDate(e) >= f.from) && (!f.to || expenseDate(e) <= f.to))
    .filter((e) => !f.status || e.status === f.status)
    .filter((e) => !f.category || (f.category === "none" ? !e.category_id : e.category_id === f.category))
    .sort((a, b) => expenseDate(b).localeCompare(expenseDate(a)));
  const urssafPaid = data.urssaf
    .filter((u) => u.paid_on && (!f.from || u.paid_on >= f.from) && (!f.to || u.paid_on <= f.to))
    .filter(() => !f.status || f.status === "paye")
    .filter(() => !f.category);
  const totalPaid = sumKnown(rows.filter((e) => e.status === "paye").map((e) => e.amount));
  const totalDue = sumKnown(rows.filter((e) => e.status === "a_payer").map((e) => e.amount));
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast.success(msg);
      router.refresh();
    });

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Charges"
        description="Dépenses ponctuelles et échéances d'abonnement. Une échéance ne compte comme payée qu'après validation."
        actions={
          <>
            <a href="/api/finance/export?type=charges" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface"><Download size={14} /> CSV</a>
            <Button variant="primary" onClick={() => setModal({})}><Plus size={15} /> Ajouter une charge</Button>
          </>
        }
      />
      <ChargesTabs />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Input aria-label="Du" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="h-8 w-36" />
        <Input aria-label="Au" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="h-8 w-36" />
        <Select aria-label="Statut" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className="h-8 w-36">
          <option value="">Tous les statuts</option>
          {Object.entries(EXPENSE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </Select>
        <Select aria-label="Catégorie" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} className="h-8 w-56">
          <option value="">Toutes les catégories</option>
          {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          <option value="none">Sans catégorie</option>
        </Select>
        {(f.from || f.to || f.status || f.category) && <Button size="sm" variant="ghost" onClick={() => setF({ from: "", to: "", status: "", category: "" })}>Effacer les filtres</Button>}
      </div>
      <p className="mb-2 text-sm text-muted">Payé : <span className="font-semibold text-ink"><Money value={totalPaid} /></span> · à payer : <span className="font-semibold text-ink"><Money value={totalDue} /></span></p>
      {rows.length || urssafPaid.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line text-left font-label text-[11px] text-muted">
                <th className="px-3 py-2">Date</th><th>Libellé</th><th>Catégorie</th><th className="text-right">{vat ? "TTC" : "Montant"}</th>{vat && <th className="text-right">HT</th>}<th>Statut</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={cn("border-b border-line last:border-0", e.status === "annule" && "text-muted line-through decoration-muted/40")}>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDate(expenseDate(e))}{e.status === "paye" && e.paid_on !== e.planned_date && <span className="block text-[11px] text-muted">prévue {formatDate(e.planned_date)}</span>}</td>
                  <td><span className="font-semibold">{e.label}</span>{e.supplier && <span className="text-xs text-muted"> · {e.supplier}</span>}{e.subscription_id && <span className="block text-[11px] text-muted">Échéance d&apos;abonnement</span>}</td>
                  <td className="text-xs">{cat(e.category_id)}</td>
                  <td className="text-right"><Money value={e.amount} /></td>
                  {vat && <td className="text-right text-xs">{e.amount_ht != null ? eur(e.amount_ht) : "—"}</td>}
                  <td><ExpenseBadge status={e.status} late={e.status === "a_payer" && e.planned_date < data.today} /></td>
                  <td className="pr-2 text-right whitespace-nowrap">
                    {e.status === "a_payer" && <Button size="sm" variant="primary" onClick={() => setPaying(e)}>Valider le paiement</Button>}
                    {e.status === "paye" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Repasser cette charge « à payer » ?") && act(() => setExpenseStatusAction(e.id, "a_payer"), "Charge repassée à payer")}>Annuler le paiement</Button>}
                    {e.status === "annule" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => setExpenseStatusAction(e.id, "a_payer"), "Charge rétablie")}>Rétablir</Button>}
                    {e.status === "a_payer" && <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => setExpenseStatusAction(e.id, "annule"), "Charge annulée")}>Annuler</Button>}
                    {!e.subscription_id && <Button size="sm" variant="ghost" aria-label="Dupliquer" title="Dupliquer" onClick={() => setModal({ from: e })}><Copy size={13} /></Button>}
                    {e.status !== "annule" && <Button size="sm" variant="ghost" aria-label="Modifier" onClick={() => setModal({ expense: e })}><Pencil size={13} /></Button>}
                    {!e.subscription_id && e.status !== "paye" && (
                      <Button size="sm" variant="ghost" className="text-danger" disabled={pending} onClick={() => confirm("Supprimer définitivement cette charge (erreur de saisie) ?") && act(() => deleteExpenseAction(e.id), "Charge supprimée")}>Supprimer</Button>
                    )}
                  </td>
                </tr>
              ))}
              {urssafPaid.map((u) => (
                <tr key={u.id} className="border-b border-line bg-surface/50 last:border-0">
                  <td className="px-3 py-2">{formatDate(u.paid_on)}</td>
                  <td><span className="font-semibold">Cotisations URSSAF {u.period_start.slice(0, 7)}</span><span className="block text-[11px] text-muted">Suivi dans l&apos;onglet URSSAF · compté une seule fois dans la trésorerie</span></td>
                  <td className="text-xs">Cotisations URSSAF</td>
                  <td className="text-right">{eur(u.paid_amount)}</td>
                  {vat && <td />}
                  <td><ExpenseBadge status="paye" /></td>
                  <td className="pr-2 text-right"><a href="/finance/urssaf" className="text-xs font-semibold text-violet-strong">Voir</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState title="Aucune charge" description="Ajoutez une dépense ponctuelle ou un abonnement." action={<Button variant="primary" onClick={() => setModal({})}>Ajouter une charge</Button>} />
      )}
      <ExpenseModal open={!!modal} onClose={() => setModal(null)} defaults={modal ?? {}} categories={data.categories} vatEnabled={vat} />
      <PayExpenseModal expense={paying} onClose={() => setPaying(null)} />
    </div>
  );
}

function PayExpenseModal({ expense, onClose }: { expense: Expense | null; onClose: () => void }) {
  return (
    <Modal open={!!expense} onClose={onClose} title="Valider le paiement">
      {expense && <PayBody expense={expense} onClose={onClose} />}
    </Modal>
  );
}

function PayBody({ expense, onClose }: { expense: Expense; onClose: () => void }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(expense.amount);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount == null) return toast.error("Indiquez le montant payé");
        start(async () => {
          const r = await payExpenseAction(expense.id, date, amount, key);
          if (!r.ok) return void toast.error(r.error);
          toast.success("Paiement validé");
          onClose();
          router.refresh();
        });
      }}
    >
      <p className="text-sm font-semibold">{expense.label}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Montant payé"><MoneyInput value={amount} onChange={setAmount} required aria-label="Montant payé" /></Field>
        <Field label="Date de paiement"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Valider"}</Button>
      </div>
    </form>
  );
}
