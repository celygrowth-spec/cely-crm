"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Download, Pencil, Plus, X } from "lucide-react";
import { cancelInvoiceAction, cancelPaymentAction } from "@/app/finance-actions";
import { Button, Card, EmptyState, Input, PageHeader, Select, cn } from "@/components/ui";
import { InvoiceBadge } from "@/components/finance/bits";
import { TrashButton } from "@/components/trash/trash-button";
import { CreditNoteModal, InvoiceModal, PaymentModal, type InvoiceDefaults } from "@/components/finance/forms";
import { settingsAt } from "@/lib/finance/calc";

import { INVOICE_STATUS } from "@/lib/finance/labels";
import { eur, sum } from "@/lib/finance/money";
import type { FinanceData, Invoice, Mission } from "@/lib/finance/types";
import { RevenueModal, SettleModal, StopModal, type SettleTarget } from "@/components/finance/revenue-forms";
import { REVENUE_STATUS } from "@/lib/finance/revenues";
import { RevenuePanel, RevenueTable, revenueRows } from "./revenue-list";
import { formatDate, formatDateTime } from "@/lib/format";

type Filters = { client: string; from: string; to: string; status: string; type: "" | "ponctuel" | "mensuel"; view: "revenus" | "factures" | "paiements"; ids: string[] };

export function RevenusView({ data, initial, selectedId, revenueId }: { data: FinanceData; initial: Filters; selectedId: string | null; revenueId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [f, setF] = useState<Filters>(initial);
  const [modal, setModal] = useState<InvoiceDefaults | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [crediting, setCrediting] = useState<Invoice | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Mission | null>(null);
  const [stopping, setStopping] = useState<Mission | null>(null);
  const [settling, setSettling] = useState<SettleTarget | null>(null);
  const vat = settingsAt(data.settings, data.today)?.vat_enabled ?? false;
  const clients = useMemo(() => [...new Map(data.invoices.map((i) => [i.company_id, { id: i.company_id, name: i.company_name }])).values()].sort((a, b) => a.name.localeCompare(b.name)), [data.invoices]);
  const missionClients = [...new Map(data.missions.map((m) => [m.company_id, { id: m.company_id, name: m.company_name }])).values()];
  const suggestions = [...new Map([...missionClients, ...clients].map((c) => [c.id, c])).values()];

  const select = (id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("revenu");
    if (id) sp.set("facture", id);
    else sp.delete("facture");
    router.push(`${pathname}?${sp.toString()}`, { scroll: false });
  };
  const openRevenue = (id: string | null) => {
    const sp = new URLSearchParams(params.toString());
    sp.delete("facture");
    if (id) sp.set("revenu", id);
    else sp.delete("revenu");
    router.push(`${pathname}?${sp.toString()}`, { scroll: false });
  };
  const allClients = [...new Map([...suggestions, ...data.missions.map((m) => ({ id: m.company_id, name: m.company_name }))].map((c) => [c.id, c])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const revenues = revenueRows(data)
    .filter((r) => !f.client || r.client === f.client)
    .filter((r) => !f.type || r.kind === f.type)
    .filter((r) => !f.status || (f.status === "a_traiter" ? ["en_retard", "a_encaisser", "partiel", "a_verifier"].includes(r.status) : r.status === f.status));
  const revenue = revenueId ? data.missions.find((m) => m.id === revenueId) ?? null : null;

  const rows = data.invoices
    .filter((i) => !f.client || i.company_id === f.client)
    .filter((i) => !f.ids.length || f.ids.includes(i.id))
    .filter((i) => (!f.from || i.issue_date >= f.from) && (!f.to || i.issue_date <= f.to))
    .filter((i) => !f.status || (f.status === "ouvertes" ? ["a_encaisser", "partielle", "en_retard"].includes(i.status) : i.status === f.status))
    .sort((a, b) => b.issue_date.localeCompare(a.issue_date) || b.created_at.localeCompare(a.created_at));
  const payments = data.payments
    .filter((p) => !p.cancelled_at && (!f.from || p.paid_on >= f.from) && (!f.to || p.paid_on <= f.to))
    .map((p) => ({ p, inv: data.invoices.find((i) => i.id === p.invoice_id)! }))
    .filter(({ inv }) => inv && (!f.client || inv.company_id === f.client))
    .sort((a, b) => b.p.paid_on.localeCompare(a.p.paid_on));
  const live = rows.filter((i) => !i.cancelled_at);
  const selected = selectedId ? data.invoices.find((i) => i.id === selectedId) ?? null : null;

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Revenus"
        description="Ponctuels et mensuels au même endroit. Une échéance reste une prévision tant qu'aucune facture ou aucun règlement ne la couvre. Aucune facture n'est générée ni envoyée."
        actions={
          <>
            <a href="/api/finance/export?type=revenus" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface"><Download size={14} /> Revenus CSV</a>
            <a href="/api/finance/export?type=paiements" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface"><Download size={14} /> Paiements CSV</a>
            {f.view === "factures" && <Button onClick={() => setModal({})}>Enregistrer une facture</Button>}
            <Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Ajouter un revenu</Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <div role="group" aria-label="Affichage" className="inline-flex rounded-lg border border-line p-0.5">
          {(["revenus", "factures", "paiements"] as const).map((v) => (
            <button key={v} aria-pressed={f.view === v} onClick={() => setF({ ...f, view: v, status: "" })} className={cn("rounded-md px-3 py-1 text-xs font-semibold", f.view === v ? "bg-ink text-white" : "text-muted")}>
              {v === "revenus" ? "Revenus" : v === "factures" ? "Factures et avoirs" : "Paiements reçus"}
            </button>
          ))}
        </div>
        {f.view === "revenus" && (
          <div role="group" aria-label="Type" className="inline-flex rounded-lg border border-line p-0.5">
            {([["", "Tous"], ["ponctuel", "Ponctuels"], ["mensuel", "Mensuels"]] as const).map(([k, l]) => (
              <button key={k} aria-pressed={f.type === k} onClick={() => setF({ ...f, type: k })} className={cn("rounded-md px-3 py-1 text-xs font-semibold", f.type === k ? "bg-violet-soft text-violet-strong" : "text-muted")}>{l}</button>
            ))}
          </div>
        )}
        <Select aria-label="Client" value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} className="h-8 w-48">
          <option value="">Tous les clients</option>
          {(f.view === "revenus" ? allClients : clients).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {f.view === "revenus" && (
          <Select aria-label="Statut" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className="h-8 w-44">
            <option value="">Tous les statuts</option>
            <option value="a_traiter">À traiter</option>
            {Object.entries(REVENUE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        )}
        {f.view !== "revenus" && <>
        <Input aria-label="Du" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} className="h-8 w-36" />
        <Input aria-label="Au" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} className="h-8 w-36" />
        </>}
        {f.view === "factures" && (
          <Select aria-label="Statut" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} className="h-8 w-48">
            <option value="">Tous les statuts</option>
            <option value="ouvertes">Non soldées</option>
            {Object.entries(INVOICE_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        )}
        {(f.client || f.from || f.to || f.status || f.type || f.ids.length > 0) && <Button size="sm" variant="ghost" onClick={() => setF({ ...f, client: "", from: "", to: "", status: "", type: "", ids: [] })}>Effacer les filtres</Button>}
      </div>
      {f.ids.length > 0 && f.view === "factures" && <p className="mb-2 text-xs text-muted">{f.ids.length} facture(s) sélectionnée(s) depuis l&apos;accueil.</p>}

      {f.view === "revenus" ? (
        data.missions.length || data.invoices.length ? (
          <RevenueTable
            rows={revenues}
            onOpen={(r) => (r.type === "mission" ? openRevenue(r.id) : select(r.id))}
            onSettle={(m, date, amount) => setSettling({ mission: m, date, amount })}
            onPay={setPaying}
          />
        ) : (
          <EmptyState title="Aucun revenu" description="Ajoutez un revenu ponctuel ou mensuel : il apparaît aussitôt dans vos prévisions." action={<Button variant="primary" onClick={() => setAdding(true)}><Plus size={15} /> Ajouter un revenu</Button>} />
        )
      ) : f.view === "factures" ? (
        rows.length ? (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-line text-left font-label text-[11px] text-muted">
                  <th className="px-3 py-2">Émise le</th><th>Client</th><th>Référence</th><th>Échéance</th><th className="text-right">{vat ? "HT" : "Montant"}</th>
                  {vat && <th className="text-right">TTC</th>}<th className="text-right">Reste dû</th><th>Statut</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={i.id} className={cn("border-b border-line last:border-0 hover:bg-surface/60", i.id === selectedId && "bg-violet-soft/40", i.cancelled_at && "text-muted line-through decoration-muted/40")}>
                    <td className="px-3 py-2 whitespace-nowrap">{formatDate(i.issue_date)}</td>
                    <td><button className="font-semibold hover:text-violet-strong" onClick={() => select(i.id)}>{i.company_name}</button>{i.mission_label && <span className="block text-xs text-muted">{i.mission_label}</span>}</td>
                    <td className="text-xs">{i.reference ?? "—"}</td>
                    <td className="text-xs whitespace-nowrap">{i.due_date ? formatDate(i.due_date) : "—"}</td>
                    <td className="text-right">{i.kind === "avoir" ? "−" : ""}{eur(i.amount_ht)}</td>
                    {vat && <td className="text-right">{i.kind === "avoir" ? "−" : ""}{eur(i.amount_ttc)}</td>}
                    <td className="text-right font-semibold">{i.kind === "facture" && !i.cancelled_at ? eur(i.balance) : "—"}</td>
                    <td><InvoiceBadge status={i.status} /></td>
                    <td className="pr-2 text-right whitespace-nowrap">
                      {i.balance > 0 && <Button size="sm" variant="primary" onClick={() => setPaying(i)}>Paiement reçu</Button>}
                      <Button size="sm" variant="ghost" aria-label="Dupliquer" title="Dupliquer" onClick={() => setModal({ from: i })}><Copy size={13} /></Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line text-sm font-semibold">
                  <td className="px-3 py-2" colSpan={4}>{live.filter((i) => i.kind === "facture").length} facture(s), avoirs déduits</td>
                  <td className="text-right">{eur(sum(live.map((i) => (i.kind === "avoir" ? -i.amount_ht : i.amount_ht))))}</td>
                  {vat && <td className="text-right">{eur(sum(live.map((i) => (i.kind === "avoir" ? -i.amount_ttc : i.amount_ttc))))}</td>}
                  <td className="text-right">{eur(sum(live.map((i) => i.balance)))}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </Card>
        ) : (
          <EmptyState title="Aucune facture" description="Enregistrez une facture émise pour suivre son encaissement." action={<Button variant="primary" onClick={() => setModal({})}>Enregistrer une facture</Button>} />
        )
      ) : payments.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead><tr className="border-b border-line text-left font-label text-[11px] text-muted"><th className="px-3 py-2">Reçu le</th><th>Client</th><th>Facture</th><th>Type</th><th className="text-right">Montant</th></tr></thead>
            <tbody>
              {payments.map(({ p, inv }) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="px-3 py-2">{formatDate(p.paid_on)}</td>
                  <td>{inv.company_name}</td>
                  <td><button className="text-xs font-semibold text-violet-strong" onClick={() => select(inv.id)}>{inv.reference ?? `Facture du ${formatDate(inv.issue_date)}`}</button></td>
                  <td className="text-xs">{p.kind === "paiement" ? "Paiement reçu" : "Remboursement versé"}</td>
                  <td className="text-right font-semibold">{p.kind === "remboursement" ? "−" : ""}{eur(p.amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t border-line font-semibold"><td className="px-3 py-2" colSpan={4}>Total encaissé net</td><td className="text-right">{eur(sum(payments.map(({ p }) => (p.kind === "paiement" ? p.amount : -p.amount))))}</td></tr></tfoot>
          </table>
        </Card>
      ) : (
        <EmptyState title="Aucun paiement sur ces critères" />
      )}

      {selected && (
        <InvoicePanel
          invoice={selected}
          data={data}
          onClose={() => select(null)}
          onPay={() => setPaying(selected)}
          onCredit={() => setCrediting(selected)}
          onEdit={() => setModal({ edit: selected })}
          onDuplicate={() => setModal({ from: selected })}
          onOpen={select}
        />
      )}
      {revenue && !selected && (
        <RevenuePanel
          mission={revenue}
          data={data}
          onClose={() => openRevenue(null)}
          onEdit={() => setEditing(revenue)}
          onStop={() => setStopping(revenue)}
          onSettle={(date, amount) => setSettling({ mission: revenue, date, amount })}
          onPay={setPaying}
          onInvoice={(coverDate) => setModal({ company: { id: revenue.company_id, name: revenue.company_name }, missionId: revenue.id, coverDate })}
          onOpenInvoice={select}
        />
      )}
      <InvoiceModal open={!!modal} onClose={() => setModal(null)} defaults={modal ?? {}} missions={data.missions} vatEnabled={vat} clients={suggestions} invoices={data.invoices} />
      <RevenueModal open={adding || !!editing} onClose={() => { setAdding(false); setEditing(null); }} clients={allClients} vatEnabled={vat} edit={editing} onSaved={openRevenue} />
      <SettleModal target={settling} onClose={() => setSettling(null)} vatEnabled={vat} />
      <StopModal mission={stopping} onClose={() => setStopping(null)} />
      <PaymentModal invoice={paying} onClose={() => setPaying(null)} />
      <CreditNoteModal invoice={crediting} onClose={() => setCrediting(null)} />
    </div>
  );
}

function InvoicePanel({ invoice: i, data, onClose, onPay, onCredit, onEdit, onDuplicate, onOpen }: {
  invoice: Invoice; data: FinanceData; onClose: () => void; onPay: () => void; onCredit: () => void; onEdit: () => void; onDuplicate: () => void; onOpen: (id: string) => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const payments = data.payments.filter((p) => p.invoice_id === i.id).sort((a, b) => a.paid_on.localeCompare(b.paid_on));
  const credits = data.invoices.filter((x) => x.credited_invoice_id === i.id);
  const origin = i.credited_invoice_id ? data.invoices.find((x) => x.id === i.credited_invoice_id) : null;
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, msg: string) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) return void toast.error(r.error);
      toast.success(msg);
      router.refresh();
    });
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button className="absolute inset-0 bg-ink/20" aria-label="Fermer le détail" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Détail du revenu" className="relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-label text-xs text-muted">{i.kind === "avoir" ? "Avoir" : "Facture"} {i.reference && `· ${i.reference}`}</p>
            <h2 className="font-display text-xl font-bold">{i.company_name}</h2>
            {i.mission_label && <p className="text-sm text-muted">{i.mission_label}</p>}
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface"><X size={18} /></button>
        </div>
        <div className="mt-2"><InvoiceBadge status={i.status} /></div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Émise le</dt><dd>{formatDate(i.issue_date)}</dd>
          <dt className="text-muted">Échéance</dt><dd>{i.due_date ? formatDate(i.due_date) : "—"}</dd>
          <dt className="text-muted">Montant HT</dt><dd>{eur(i.amount_ht)}</dd>
          {i.vat_amount != null && <><dt className="text-muted">TVA {i.vat_rate && `(${i.vat_rate} %)`}</dt><dd>{eur(i.vat_amount)}</dd></>}
          <dt className="text-muted">Total TTC</dt><dd className="font-semibold">{eur(i.amount_ttc)}</dd>
          {i.kind === "facture" && <>
            <dt className="text-muted">Avoirs</dt><dd>{eur(i.credited)}</dd>
            <dt className="text-muted">Encaissé</dt><dd>{eur(i.paid_net)}</dd>
            <dt className="text-muted">Reste dû</dt><dd className="font-bold">{eur(i.balance)}</dd>
          </>}
        </dl>
        {i.note && <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm">{i.note}</p>}
        {i.cancelled_at && <p className="mt-3 text-sm text-muted">Annulée le {formatDateTime(i.cancelled_at)}{i.cancel_reason && ` : ${i.cancel_reason}`}</p>}
        {origin && <p className="mt-3 text-sm">Avoir sur <button className="font-semibold text-violet-strong" onClick={() => onOpen(origin.id)}>{origin.reference ?? `la facture du ${formatDate(origin.issue_date)}`}</button></p>}

        {!i.cancelled_at && (
          <div className="mt-4 flex flex-wrap gap-2">
            {i.balance > 0 && <Button variant="primary" onClick={onPay}>Enregistrer un paiement</Button>}
            {i.kind === "facture" && <Button onClick={onCredit}>Avoir</Button>}
            {i.kind === "facture" && <Button onClick={onEdit}><Pencil size={13} /> Modifier</Button>}
            <Button onClick={onDuplicate}><Copy size={13} /> Dupliquer</Button>
            {i.kind === "facture" && i.paid_net === 0 && !payments.some((p) => !p.cancelled_at) && (
              <Button variant="danger" disabled={pending} onClick={() => {
                const reason = prompt("Motif de l'annulation (la ligne reste visible, barrée, hors totaux) :");
                if (reason !== null) act(() => cancelInvoiceAction(i.id, reason), "Revenu annulé");
              }}>Annuler</Button>
            )}
          </div>
        )}

        <div className="mt-3">
          <TrashButton kind="finance_invoice" id={i.id} size="md" variant="danger" onDone={onClose}>
            Supprimer {i.kind === "avoir" ? "l'avoir" : "la facture"}
          </TrashButton>
        </div>

        {i.kind === "facture" && (
          <section className="mt-5">
            <h3 className="font-label text-xs font-bold text-muted uppercase">Paiements</h3>
            {payments.length ? (
              <ul className="mt-1 divide-y divide-line text-sm">
                {payments.map((p) => (
                  <li key={p.id} className={cn("flex items-center gap-2 py-1.5", p.cancelled_at && "text-muted line-through")}>
                    <span className="flex-1">{formatDate(p.paid_on)} · {p.kind === "paiement" ? "reçu" : "remboursement versé"}{p.note && <span className="text-xs text-muted"> · {p.note}</span>}</span>
                    <span className="font-semibold">{p.kind === "remboursement" ? "−" : ""}{eur(p.amount)}</span>
                    {!p.cancelled_at && (
                      <button className="text-xs text-muted hover:text-danger" disabled={pending} onClick={() => confirm("Annuler ce paiement (erreur de saisie) ?") && act(() => cancelPaymentAction(p.id), "Paiement annulé")}>
                        Annuler
                      </button>
                    )}
                    <TrashButton kind="finance_payment" id={p.id} />
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-sm text-muted">Aucun paiement reçu.</p>}
          </section>
        )}
        {credits.length > 0 && (
          <section className="mt-4">
            <h3 className="font-label text-xs font-bold text-muted uppercase">Avoirs</h3>
            <ul className="mt-1 text-sm">{credits.map((c) => <li key={c.id}><button className="text-violet-strong" onClick={() => onOpen(c.id)}>{formatDate(c.issue_date)} · −{eur(c.amount_ttc)}</button></li>)}</ul>
          </section>
        )}
        <p className="mt-6 text-xs text-muted"><Link className="font-semibold text-violet-strong" href={`/finance/clients?tous=1`}>Voir le client et ses missions</Link></p>
      </aside>
    </div>
  );
}

