"use client";

// Formulaires courts du module Finance (options avancées repliées).
// Chaque formulaire a sa clé d'idempotence : un double clic n'enregistre qu'une fois.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { AlertTriangle, Search } from "lucide-react";
import { searchAction } from "@/app/actions";
import {
  recordCreditNoteAction,
  recordInvoiceAction,
  recordPaymentAction,
  saveExpenseAction,
  saveMissionAction,
  saveSubscriptionAction,
  updateInvoiceAction,
} from "@/app/finance-actions";
import { Button, Field, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";
import type { SearchResult } from "@/lib/crm/types";
import { todayISO } from "@/lib/format";
import { addDays } from "@/lib/finance/dates";
import { FREQUENCY, MISSION_KIND, MISSION_STATUS } from "@/lib/finance/labels";
import { eur, mulDiv } from "@/lib/finance/money";
import type { Category, Expense, Invoice, Mission, Subscription } from "@/lib/finance/types";
import type { ActionResult } from "@/lib/action";
import { Advanced, CategorySelect, MoneyInput } from "./bits";

function useSubmit() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = (fn: () => Promise<ActionResult<unknown>>, done: () => void, success: string) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(success);
      done();
      router.refresh();
    });
  return { pending, submit };
}

// ---------------------------------------------------------------------------
// Choix du client : une fiche CRM existante (jamais une seconde base clients)
// ---------------------------------------------------------------------------

export type ClientOption = { id: string; name: string };

export function CompanyPicker({ value, onChange, suggestions }: { value: ClientOption | null; onChange: (c: ClientOption | null) => void; suggestions: ClientOption[] }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const req = useRef(0);
  useEffect(() => {
    if (!q.trim()) return;
    const id = ++req.current;
    const t = setTimeout(async () => {
      setLoading(true);
      const res = await searchAction(q);
      if (id !== req.current) return;
      setLoading(false);
      if (res.ok) setResults(res.data);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);

  if (value) {
    return (
      <div className="flex h-9 items-center justify-between rounded-lg border border-line bg-surface px-3 text-sm">
        <span className="font-semibold">{value.name}</span>
        <button type="button" className="text-xs font-semibold text-violet-strong" onClick={() => onChange(null)}>Changer</button>
      </div>
    );
  }
  const shown = q.trim() ? results.map((r) => ({ id: r.id, name: r.name })) : suggestions;
  return (
    <div>
      <div className="relative">
        <Search size={14} className="absolute top-2.5 left-3 text-muted" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Rechercher une fiche du CRM…" className="pl-8" aria-label="Rechercher le client" />
        {loading && <span className="absolute top-2.5 right-3"><Spinner /></span>}
      </div>
      {shown.length > 0 && (
        <ul className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-line">
          {shown.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => onChange(c)} className="w-full px-3 py-1.5 text-left text-sm hover:bg-violet-soft">{c.name}</button>
            </li>
          ))}
        </ul>
      )}
      {q.trim() && !loading && !results.length && (
        <p className="mt-1 text-xs text-muted">Aucune fiche. Créez d&apos;abord la fiche dans le CRM (bouton « Nouvelle fiche »).</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Revenu (facture émise ailleurs)
// ---------------------------------------------------------------------------

export type InvoiceDefaults = { company?: ClientOption | null; missionId?: string | null; from?: Invoice | null; edit?: Invoice | null };

export function InvoiceModal(props: {
  open: boolean;
  onClose: () => void;
  defaults: InvoiceDefaults;
  missions: Mission[];
  vatEnabled: boolean;
  clients: ClientOption[];
}) {
  const title = props.defaults.edit ? "Modifier le revenu" : props.defaults.from ? "Dupliquer le revenu" : "Ajouter un revenu";
  return (
    <Modal open={props.open} onClose={props.onClose} title={title}>
      <InvoiceBody {...props} />
    </Modal>
  );
}

function InvoiceBody({ onClose, defaults, missions, vatEnabled, clients }: Parameters<typeof InvoiceModal>[0]) {
  const src = defaults.edit ?? defaults.from ?? null;
  const today = todayISO();
  const [key] = useState(() => crypto.randomUUID());
  const [company, setCompany] = useState<ClientOption | null>(
    src ? { id: src.company_id, name: src.company_name } : defaults.company ?? null,
  );
  const [missionId, setMissionId] = useState(src?.mission_id ?? defaults.missionId ?? "");
  const [issue, setIssue] = useState(defaults.edit?.issue_date ?? today);
  const [due, setDue] = useState(defaults.edit?.due_date ?? (src ? addDays(today, 30) : addDays(today, 30)));
  const [ht, setHt] = useState<number | null>(src?.amount_ht ?? missions.find((m) => m.id === defaults.missionId)?.amount ?? null);
  const [htKey, setHtKey] = useState(0);
  const [vatRate, setVatRate] = useState(src?.vat_rate ?? (vatEnabled ? "20" : ""));
  const [vat, setVat] = useState<number | null>(src?.vat_amount ?? null);
  const [reference, setReference] = useState(defaults.edit?.reference ?? "");
  const [note, setNote] = useState(src?.note ?? "");
  const [paidNow, setPaidNow] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const companyMissions = missions.filter((m) => m.company_id === company?.id);
  const mission = companyMissions.find((m) => m.id === missionId) ?? null;
  const [cover, setCover] = useState(true);
  const coverDate = !defaults.edit && mission?.kind === "recurrent" ? mission.next_due_date : null;
  const { pending, submit } = useSubmit();

  const pickMission = (id: string) => {
    setMissionId(id);
    const m = companyMissions.find((x) => x.id === id);
    if (!src && ht === null && m?.amount != null) {
      setHt(m.amount);
      setHtKey((k) => k + 1);
    }
  };

  const vatComputed = vatEnabled && ht != null && vatRate && /^\d{1,2}([.,]\d{1,2})?$/.test(vatRate) ? mulDiv(ht, Math.round(Number(vatRate.replace(",", ".")) * 100), 10000) : null;
  const vatValue = vatEnabled ? vat ?? vatComputed : null;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!company) return toast.error("Choisissez le client (fiche CRM)");
    if (!ht) return toast.error("Indiquez le montant HT");
    const input = {
      company_id: company.id,
      mission_id: missionId || null,
      reference,
      issue_date: issue,
      due_date: due || null,
      amount_ht: ht,
      vat_rate: vatEnabled ? vatRate || null : null,
      vat_amount: vatValue,
      note,
      forecast_due_date: coverDate && cover ? coverDate : null,
    };
    if (defaults.edit) submit(() => updateInvoiceAction(defaults.edit!.id, input), onClose, "Revenu modifié");
    else submit(() => recordInvoiceAction(input, key, paidNow ? { paid_on: paidOn } : null), onClose, paidNow ? "Revenu et paiement enregistrés" : "Revenu enregistré");
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-xs text-muted">Enregistrez une facture émise dans votre outil de facturation. Rien n&apos;est envoyé au client.</p>
      <Field label="Client (fiche CRM)">
        {defaults.edit ? <p className="text-sm font-semibold">{company?.name}</p> : <CompanyPicker value={company} onChange={(c) => { setCompany(c); setMissionId(""); }} suggestions={clients} />}
      </Field>
      {company && companyMissions.length > 0 && (
        <Field label="Mission (facultatif)">
          <Select value={missionId} onChange={(e) => pickMission(e.target.value)}>
            <option value="">Sans mission</option>
            {companyMissions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </Field>
      )}
      {coverDate && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={cover} onChange={(e) => setCover(e.target.checked)} />
          Cette facture couvre l&apos;échéance prévue du {coverDate} (l&apos;échéance suivante sera calculée)
        </label>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date d'émission"><Input type="date" required value={issue} onChange={(e) => setIssue(e.target.value)} /></Field>
        <Field label="Échéance de paiement"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={vatEnabled ? "Montant HT" : "Montant (HT, sans TVA)"}><MoneyInput key={htKey} value={ht} onChange={setHt} required aria-label="Montant HT" /></Field>
        <Field label="Référence (facultatif)"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="F-2026-012" /></Field>
      </div>
      {vatEnabled && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Taux TVA (%)"><Input value={vatRate} onChange={(e) => { setVatRate(e.target.value); setVat(null); }} inputMode="decimal" /></Field>
          <Field label="TVA"><MoneyInput key={String(vatComputed)} value={vatValue} onChange={setVat} aria-label="Montant de TVA" /></Field>
          <Field label="TTC"><p className="flex h-9 items-center text-sm font-semibold">{ht != null ? eur(ht + (vatValue ?? 0)) : "—"}</p></Field>
        </div>
      )}
      {!defaults.edit && (
        <label className="flex flex-wrap items-center gap-2 text-sm">
          <input type="checkbox" checked={paidNow} onChange={(e) => setPaidNow(e.target.checked)} />
          Déjà payée en totalité le
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} disabled={!paidNow} className="h-8 w-40" />
        </label>
      )}
      <Advanced>
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Advanced>
      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Paiement reçu (ou remboursement)
// ---------------------------------------------------------------------------

export function PaymentModal({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  return (
    <Modal open={!!invoice} onClose={onClose} title="Enregistrer un paiement">
      {invoice && <PaymentBody invoice={invoice} onClose={onClose} />}
    </Modal>
  );
}

function PaymentBody({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [key] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState<number | null>(invoice.balance || null);
  const [paidOn, setPaidOn] = useState(todayISO());
  const [kind, setKind] = useState<"paiement" | "remboursement">("paiement");
  const [note, setNote] = useState("");
  const { pending, submit } = useSubmit();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!amount) return toast.error("Indiquez le montant");
        submit(() => recordPaymentAction({ invoice_id: invoice.id, paid_on: paidOn, amount, kind, note }, key), onClose, kind === "paiement" ? "Paiement enregistré" : "Remboursement enregistré");
      }}
    >
      <p className="text-sm">
        <span className="font-semibold">{invoice.company_name}</span>
        {invoice.reference && ` · ${invoice.reference}`} · total {eur(invoice.amount_ttc)} · reste dû <span className="font-semibold">{eur(invoice.balance)}</span>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Montant reçu"><MoneyInput value={amount} onChange={setAmount} required aria-label="Montant reçu" /></Field>
        <Field label="Date de réception"><Input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
      </div>
      <p className="text-xs text-muted">Un paiement partiel est accepté : le reste dû est recalculé.</p>
      <Advanced>
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="paiement">Paiement reçu du client</option>
            <option value="remboursement">Remboursement versé au client</option>
          </Select>
        </Field>
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Advanced>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Avoir
// ---------------------------------------------------------------------------

export function CreditNoteModal({ invoice, onClose }: { invoice: Invoice | null; onClose: () => void }) {
  return (
    <Modal open={!!invoice} onClose={onClose} title="Enregistrer un avoir">
      {invoice && <CreditBody invoice={invoice} onClose={onClose} />}
    </Modal>
  );
}

function CreditBody({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const [key] = useState(() => crypto.randomUUID());
  const [ht, setHt] = useState<number | null>(null);
  const [vat, setVat] = useState<number | null>(null);
  const [date, setDate] = useState(todayISO());
  const [reference, setReference] = useState("");
  const { pending, submit } = useSubmit();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ht) return toast.error("Indiquez le montant HT de l'avoir");
        submit(() => recordCreditNoteAction(invoice.id, { issue_date: date, amount_ht: ht, vat_amount: vat, reference }, key), onClose, "Avoir enregistré");
      }}
    >
      <p className="text-xs text-muted">L&apos;avoir réduit ce que doit le client et le chiffre facturé, sans effacer la facture d&apos;origine.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Montant HT de l'avoir"><MoneyInput value={ht} onChange={setHt} required aria-label="Montant HT de l'avoir" /></Field>
        <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="TVA (facultatif)"><MoneyInput value={vat} onChange={setVat} aria-label="TVA de l'avoir" /></Field>
        <Field label="Référence"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer l'avoir"}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Charge ponctuelle ou abonnement
// ---------------------------------------------------------------------------

export type ExpenseDefaults = { expense?: Expense | null; subscription?: Subscription | null; recurring?: boolean; from?: Expense | null };

export function ExpenseModal(props: { open: boolean; onClose: () => void; defaults: ExpenseDefaults; categories: Category[]; vatEnabled: boolean }) {
  const t = props.defaults.subscription ? "Modifier l'abonnement" : props.defaults.expense ? "Modifier la charge" : "Ajouter une charge";
  return (
    <Modal open={props.open} onClose={props.onClose} title={t}>
      <ExpenseBody {...props} />
    </Modal>
  );
}

function ExpenseBody({ onClose, defaults, categories, vatEnabled }: Parameters<typeof ExpenseModal>[0]) {
  const today = todayISO();
  const e0 = defaults.expense ?? defaults.from ?? null;
  const s0 = defaults.subscription ?? null;
  const [key] = useState(() => crypto.randomUUID());
  const [recurring, setRecurring] = useState(!!s0 || !!defaults.recurring);
  const [label, setLabel] = useState(e0?.label ?? s0?.label ?? "");
  const [supplier, setSupplier] = useState(e0?.supplier ?? s0?.supplier ?? "");
  const [categoryId, setCategoryId] = useState(e0?.category_id ?? s0?.category_id ?? "");
  const [amount, setAmount] = useState<number | null>(e0?.amount ?? s0?.amount ?? null);
  const [amountHt, setAmountHt] = useState<number | null>(e0?.amount_ht ?? s0?.amount_ht ?? null);
  const [date, setDate] = useState(defaults.expense?.planned_date ?? s0?.next_due_date ?? today);
  const [status, setStatus] = useState<"a_payer" | "paye">(defaults.expense?.status === "paye" ? "paye" : defaults.expense ? "a_payer" : "paye");
  const [paidOn, setPaidOn] = useState(defaults.expense?.paid_on ?? today);
  const [frequency, setFrequency] = useState<keyof typeof FREQUENCY>(s0?.frequency ?? "mensuel");
  const [renewal, setRenewal] = useState(s0?.renewal_date ?? "");
  const [end, setEnd] = useState(s0?.end_date ?? "");
  const [subStatus, setSubStatus] = useState<"actif" | "resilie">(s0?.status ?? "actif");
  const [note, setNote] = useState(e0?.note ?? s0?.note ?? "");
  const { pending, submit } = useSubmit();
  const social = categories.find((c) => c.id === categoryId)?.name === "Cotisations sociales";
  const editing = !!defaults.expense || !!s0;

  const onSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    if (recurring) {
      const input = {
        label, supplier, category_id: categoryId || null, amount, amount_ht: vatEnabled ? amountHt : null, frequency,
        start_date: s0?.start_date ?? date, next_due_date: date, renewal_date: renewal || null, end_date: end || null, status: subStatus, note,
      };
      submit(() => saveSubscriptionAction(s0?.id ?? null, input, s0 ? undefined : key), onClose, s0 ? "Abonnement modifié" : "Abonnement ajouté : ses échéances apparaîtront « à payer »");
    } else {
      const input = {
        label, supplier, category_id: categoryId || null, amount, amount_ht: vatEnabled ? amountHt : null,
        vat_amount: vatEnabled && amount != null && amountHt != null ? Math.max(amount - amountHt, 0) : null,
        planned_date: date, paid_on: status === "paye" ? paidOn : null, status, note,
      };
      submit(() => saveExpenseAction(defaults.expense?.id ?? null, input, defaults.expense ? undefined : key), onClose, defaults.expense ? "Charge modifiée" : "Charge ajoutée");
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {!editing && (
        <div role="group" aria-label="Type de charge" className="inline-flex rounded-lg border border-line p-0.5">
          <button type="button" aria-pressed={!recurring} onClick={() => setRecurring(false)} className={`rounded-md px-3 py-1 text-xs font-semibold ${!recurring ? "bg-ink text-white" : "text-muted"}`}>Ponctuelle</button>
          <button type="button" aria-pressed={recurring} onClick={() => setRecurring(true)} className={`rounded-md px-3 py-1 text-xs font-semibold ${recurring ? "bg-ink text-white" : "text-muted"}`}>Récurrente / abonnement</button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Libellé"><Input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder={recurring ? "Notion" : "Achat écran"} /></Field>
        <Field label="Catégorie"><CategorySelect categories={categories} value={categoryId} onChange={setCategoryId} /></Field>
      </div>
      {social && (
        <p className="flex gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-warning">
          <AlertTriangle size={14} className="shrink-0" aria-hidden />
          Les cotisations URSSAF se suivent dans l&apos;onglet URSSAF, où leur paiement est déjà compté dans la trésorerie. Ne les saisissez pas aussi ici.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label={vatEnabled ? "Montant TTC payé" : "Montant"} hint={amount === null ? "Laissé vide = montant inconnu (signalé comme incomplet)" : undefined}>
          <MoneyInput value={amount} onChange={setAmount} aria-label="Montant" />
        </Field>
        <Field label={recurring ? (editing ? "Prochaine échéance" : "Première échéance") : "Date prévue"}><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      {recurring ? (
        <Field label="Fréquence">
          <Select value={frequency} onChange={(e) => setFrequency(e.target.value as keyof typeof FREQUENCY)}>
            {Object.entries(FREQUENCY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5"><input type="radio" checked={status === "paye"} onChange={() => setStatus("paye")} /> Payée le</label>
          <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} disabled={status !== "paye"} className="h-8 w-40" />
          <label className="flex items-center gap-1.5"><input type="radio" checked={status === "a_payer"} onChange={() => setStatus("a_payer")} /> À payer</label>
        </div>
      )}
      <Advanced>
        <Field label="Fournisseur"><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} /></Field>
        {vatEnabled && <Field label="Montant HT (pour la TVA déductible et l'EBITDA)"><MoneyInput value={amountHt} onChange={setAmountHt} aria-label="Montant HT" /></Field>}
        {recurring && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date de renouvellement"><Input type="date" value={renewal} onChange={(e) => setRenewal(e.target.value)} /></Field>
            <Field label="Résiliation (dernière échéance)"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
        )}
        {recurring && s0 && (
          <Field label="Statut">
            <Select value={subStatus} onChange={(e) => setSubStatus(e.target.value as typeof subStatus)}>
              <option value="actif">Actif</option>
              <option value="resilie">Résilié (plus aucune échéance)</option>
            </Select>
          </Field>
        )}
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Advanced>
      {recurring && !editing && <p className="text-xs text-muted">Chaque échéance apparaîtra « à payer » dans les charges et ne comptera comme payée qu&apos;après votre validation.</p>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Mission
// ---------------------------------------------------------------------------

export function MissionModal(props: { open: boolean; onClose: () => void; mission: Mission | null; company: ClientOption | null; clients: ClientOption[] }) {
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.mission ? "Modifier la mission" : "Nouvelle mission"}>
      <MissionBody {...props} />
    </Modal>
  );
}

function MissionBody({ onClose, mission, company: c0, clients }: Parameters<typeof MissionModal>[0]) {
  const [key] = useState(() => crypto.randomUUID());
  const [company, setCompany] = useState<ClientOption | null>(mission ? { id: mission.company_id, name: mission.company_name } : c0);
  const [label, setLabel] = useState(mission?.label ?? "");
  const [kind, setKind] = useState<keyof typeof MISSION_KIND>(mission?.kind ?? "recurrent");
  const [status, setStatus] = useState<keyof typeof MISSION_STATUS>(mission?.status ?? "actif");
  const [amount, setAmount] = useState<number | null>(mission?.amount ?? null);
  const [frequency, setFrequency] = useState<keyof typeof FREQUENCY>(mission?.frequency ?? "mensuel");
  const [start, setStart] = useState(mission?.start_date ?? todayISO());
  const [next, setNext] = useState(mission?.next_due_date ?? "");
  const [end, setEnd] = useState(mission?.end_date ?? "");
  const [note, setNote] = useState(mission?.note ?? "");
  const { pending, submit } = useSubmit();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!company) return toast.error("Choisissez le client (fiche CRM)");
        submit(
          () =>
            saveMissionAction(
              mission?.id ?? null,
              { company_id: company.id, label, kind, status, amount, frequency: kind === "recurrent" ? frequency : null, start_date: start || null, next_due_date: next || null, end_date: end || null, note },
              mission ? undefined : key,
            ),
          onClose,
          mission ? "Mission modifiée" : "Mission créée",
        );
      }}
    >
      <Field label="Client (fiche CRM)">
        <CompanyPicker value={company} onChange={setCompany} suggestions={clients} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Mission"><Input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Accompagnement growth" /></Field>
        <Field label="Statut">
          <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {Object.entries(MISSION_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Type">
          <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            {Object.entries(MISSION_KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label={kind === "recurrent" ? "Montant HT par échéance" : "Montant HT total"}><MoneyInput value={amount} onChange={setAmount} aria-label="Montant de la mission" /></Field>
        {kind === "recurrent" ? (
          <Field label="Facturation">
            <Select value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)}>
              {Object.entries(FREQUENCY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
          </Field>
        ) : <div />}
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Début"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Prochaine échéance" hint="Date de facturation prévue"><Input type="date" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <Field label="Fin"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      <Advanced>
        <Field label="Note"><Textarea value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Advanced>
      <p className="text-xs text-muted">Une mission sert aux prévisions. Elle ne crée jamais de facture ni d&apos;encaissement.</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
      </div>
    </form>
  );
}
