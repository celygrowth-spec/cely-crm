"use client";

// « Ajouter un revenu » : UN formulaire pour tous les revenus (ponctuel ou mensuel), et les actions
// d'une échéance (encaisser, facturer) et d'un revenu mensuel (modifier pour la suite, arrêter).
// Chaque enregistrement a sa clé d'idempotence : un double clic n'enregistre qu'une fois.
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";
import { CalendarClock, Repeat } from "lucide-react";
import { addRevenueAction, settleDueAction, stopRevenueAction, updateRevenueAction } from "@/app/finance-actions";
import { Badge, Button, Field, Input, Modal, Spinner, Textarea, cn } from "@/components/ui";
import { todayISO, formatDate } from "@/lib/format";
import { eur, mulDiv } from "@/lib/finance/money";
import { previewDates, revenueKind, type RevenueKind } from "@/lib/finance/revenues";
import type { Mission } from "@/lib/finance/types";
import type { ActionResult } from "@/lib/action";
import { Advanced, MoneyInput } from "./bits";
import { CompanyPicker, type ClientOption } from "./forms";

const monthDay = (d: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));

function useSubmit() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const submit = <T,>(fn: () => Promise<ActionResult<T>>, done: (data: T) => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return void toast.error(res.error);
      done(res.data);
      router.refresh();
    });
  return { pending, submit };
}

export function KindBadge({ kind }: { kind: RevenueKind }) {
  return kind === "mensuel"
    ? <Badge tone="violet"><Repeat size={11} aria-hidden />Mensuel</Badge>
    : <Badge><CalendarClock size={11} aria-hidden />Ponctuel</Badge>;
}

function KindSwitch({ value, onChange }: { value: RevenueKind; onChange: (k: RevenueKind) => void }) {
  return (
    <div role="radiogroup" aria-label="Type de revenu" className="grid grid-cols-2 gap-1 rounded-xl border border-line p-1">
      {(["ponctuel", "mensuel"] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onChange(k)}
          className={cn("flex items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-semibold", value === k ? "bg-ink text-white" : "text-muted hover:bg-surface")}>
          {k === "ponctuel" ? <CalendarClock size={15} aria-hidden /> : <Repeat size={15} aria-hidden />}
          {k === "ponctuel" ? "Ponctuel" : "Mensuel"}
        </button>
      ))}
    </div>
  );
}

/** Aperçu des prochaines échéances, avant l'enregistrement. */
export function DuePreview({ first, end, amount }: { first: string; end: string | null; amount: number | null }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) return null;
  const dates = previewDates(first, end, 4);
  const more = previewDates(first, end, 5).length > 4;
  return (
    <div className="rounded-xl bg-surface p-3" aria-live="polite" data-preview>
      <p className="font-label text-[11px] font-semibold tracking-wide text-muted uppercase">Prochaines échéances</p>
      <ul className="mt-1.5 space-y-1 text-sm">
        {dates.map((d) => (
          <li key={d} className="flex justify-between gap-2"><span>{monthDay(d)}</span><span className="font-semibold tabular-nums">{amount ? eur(amount) : "—"}</span></li>
        ))}
      </ul>
      <p className="mt-1.5 text-xs text-muted">
        {more ? (end ? `… puis chaque mois jusqu'au ${monthDay(end)}.` : "… puis chaque mois, sans date de fin.") : end ? `Dernière échéance avant le ${monthDay(end)}.` : ""}
        {Number(first.slice(8, 10)) > 28 && " Un jour absent du mois devient le dernier jour de ce mois."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ajouter / modifier un revenu
// ---------------------------------------------------------------------------

export function RevenueModal(props: { open: boolean; onClose: () => void; clients: ClientOption[]; vatEnabled: boolean; edit?: Mission | null; onSaved?: (id: string) => void }) {
  return (
    <Modal open={props.open} onClose={props.onClose} title={props.edit ? "Modifier le revenu" : "Ajouter un revenu"}>
      {props.open && <RevenueBody {...props} />}
    </Modal>
  );
}

function RevenueBody({ onClose, clients, vatEnabled, edit, onSaved }: Parameters<typeof RevenueModal>[0]) {
  const today = todayISO();
  const [key] = useState(() => crypto.randomUUID());
  const [company, setCompany] = useState<ClientOption | null>(edit ? { id: edit.company_id, name: edit.company_name } : null);
  const [label, setLabel] = useState(edit?.label ?? "");
  const [kind, setKind] = useState<RevenueKind>(edit ? revenueKind(edit) : "ponctuel");
  const [amount, setAmount] = useState<number | null>(edit?.amount ?? null);
  const [date, setDate] = useState(edit ? (edit.start_date ?? edit.next_due_date ?? today) : today);
  const [end, setEnd] = useState(edit?.end_date ?? "");
  const [received, setReceived] = useState(false);
  const [paidOn, setPaidOn] = useState(today);
  const [vatRate, setVatRate] = useState(vatEnabled ? "20" : "");
  const [note, setNote] = useState(edit?.note ?? "");
  const { pending, submit } = useSubmit();

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!company) return toast.error("Choisissez le client");
    if (!amount) return toast.error("Indiquez le montant");
    if (edit) {
      return submit(() => updateRevenueAction(edit.id, { label, amount, date, end_date: kind === "mensuel" ? end || null : null, note }), () => {
        toast.success("Revenu modifié pour la suite. Les mois déjà facturés gardent leur montant.");
        onClose();
      });
    }
    submit(
      () => addRevenueAction({
        company_id: company.id, label, kind, amount, date, end_date: kind === "mensuel" ? end || null : null, note,
        received: kind === "ponctuel" && received ? { paid_on: paidOn, amount: null, vat_rate: vatEnabled ? vatRate : null } : null,
      }, key),
      (r) => {
        const where = kind === "mensuel"
          ? `Échéances dans vos prévisions dès le ${monthDay(date)}.`
          : received ? `Compté dans « Encaissé » le ${monthDay(paidOn)}.` : `Dans vos prévisions au ${monthDay(date)}.`;
        toast.success("Revenu enregistré", { description: where, action: onSaved ? { label: "Voir", onClick: () => onSaved(r.id) } : undefined });
        onClose();
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {!edit && <KindSwitch value={kind} onChange={setKind} />}
      {edit && <p className="flex items-center gap-2 text-sm"><KindBadge kind={kind} /> <span className="font-semibold">{company?.name}</span></p>}
      {!edit && (
        <Field label="Client">
          <CompanyPicker value={company} onChange={setCompany} suggestions={clients} />
        </Field>
      )}
      <Field label="Prestation">
        <Input required value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "mensuel" ? "Accompagnement growth" : "Audit SEO"} maxLength={200} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={kind === "mensuel" ? "Montant par mois" : "Montant"} hint={vatEnabled ? "Hors taxes" : undefined}>
          <MoneyInput value={amount} onChange={setAmount} required aria-label={kind === "mensuel" ? "Montant par mois" : "Montant"} />
        </Field>
        <Field label={kind === "mensuel" ? "Premier encaissement prévu" : "Encaissement prévu le"}>
          <Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} aria-label={kind === "mensuel" ? "Premier encaissement prévu" : "Encaissement prévu le"} />
        </Field>
      </div>
      {kind === "mensuel" ? (
        <>
          <Field label="Date de fin (facultatif)" hint="Laissez vide si vous ne la connaissez pas">
            <Input type="date" value={end} min={date} onChange={(e) => setEnd(e.target.value)} aria-label="Date de fin" />
          </Field>
          <DuePreview first={date} end={end || null} amount={amount} />
        </>
      ) : !edit && (
        <div className="rounded-xl border border-line p-3">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} /> J&apos;ai déjà reçu le paiement
          </label>
          {received && (
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Field label="Reçu le"><Input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} aria-label="Reçu le" /></Field>
              {vatEnabled && <Field label="TVA (%)"><Input value={vatRate} onChange={(e) => setVatRate(e.target.value)} inputMode="decimal" /></Field>}
            </div>
          )}
          {received && vatEnabled && amount && /^\d{1,2}([.,]\d{1,2})?$/.test(vatRate) && (
            <p className="mt-1 text-xs text-muted">Montant reçu : {eur(amount + mulDiv(amount, Math.round(Number(vatRate.replace(",", ".")) * 100), 10000))} TTC</p>
          )}
        </div>
      )}
      <Advanced label="Note">
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
// Encaisser (ou facturer) une échéance
// ---------------------------------------------------------------------------

export type SettleTarget = { mission: Mission; date: string; amount: number | null };

export function SettleModal({ target, onClose, vatEnabled }: { target: SettleTarget | null; onClose: () => void; vatEnabled: boolean }) {
  return (
    <Modal open={!!target} onClose={onClose} title="Encaisser l'échéance">
      {target && <SettleBody target={target} onClose={onClose} vatEnabled={vatEnabled} />}
    </Modal>
  );
}

function SettleBody({ target, onClose, vatEnabled }: { target: SettleTarget; onClose: () => void; vatEnabled: boolean }) {
  const [key] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState<number | null>(target.amount);
  const [vatRate, setVatRate] = useState(vatEnabled ? "20" : "");
  const vat = vatEnabled && amount && /^\d{1,2}([.,]\d{1,2})?$/.test(vatRate) ? mulDiv(amount, Math.round(Number(vatRate.replace(",", ".")) * 100), 10000) : 0;
  const total = (amount ?? 0) + vat;
  const [received, setReceived] = useState(true);
  const [paidOn, setPaidOn] = useState(todayISO());
  const [paid, setPaid] = useState<number | null>(null); // null = totalité
  const [reference, setReference] = useState("");
  const { pending, submit } = useSubmit();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!amount) return toast.error("Indiquez le montant");
        submit(
          () => settleDueAction(target.mission.id, {
            due_date: target.date, amount, vat_rate: vatEnabled ? vatRate : null, reference,
            paid_on: received ? paidOn : null, paid_amount: received ? paid : null,
          }, key),
          () => {
            toast.success(received ? (paid && paid < total ? `Paiement partiel enregistré : reste ${eur(total - paid)} à encaisser` : "Échéance encaissée") : "Facture enregistrée : à encaisser");
            onClose();
          },
        );
      }}
    >
      <p className="text-sm">
        <span className="font-semibold">{target.mission.company_name}</span> · {target.mission.label}<br />
        <span className="text-muted">Échéance du {monthDay(target.date)}</span>
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={vatEnabled ? "Montant HT dû" : "Montant dû"}><MoneyInput value={amount} onChange={setAmount} required aria-label="Montant dû" /></Field>
        {vatEnabled ? <Field label="TVA (%)"><Input value={vatRate} onChange={(e) => setVatRate(e.target.value)} inputMode="decimal" /></Field> : <div />}
      </div>
      <div className="rounded-xl border border-line p-3">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} /> Paiement reçu
        </label>
        {received ? (
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Field label="Reçu le"><Input type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} aria-label="Reçu le" /></Field>
            <Field label="Montant reçu" hint={`Totalité : ${eur(total)}`}><MoneyInput value={paid} onChange={setPaid} placeholder={eur(total).replace(/\s?€/, "")} aria-label="Montant reçu" /></Field>
          </div>
        ) : <p className="mt-1 text-xs text-muted">La facture sera enregistrée « à encaisser » ; vous ajouterez le règlement à sa réception.</p>}
      </div>
      <Advanced label="Référence de facture">
        <Field label="Référence (facultatif)"><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="F-2026-012" /></Field>
      </Advanced>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : received ? "Encaisser" : "Enregistrer la facture"}</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Arrêter un revenu mensuel
// ---------------------------------------------------------------------------

export function StopModal({ mission, onClose }: { mission: Mission | null; onClose: () => void }) {
  return (
    <Modal open={!!mission} onClose={onClose} title="Arrêter le revenu mensuel">
      {mission && <StopBody mission={mission} onClose={onClose} />}
    </Modal>
  );
}

function StopBody({ mission, onClose }: { mission: Mission; onClose: () => void }) {
  const [end, setEnd] = useState(todayISO());
  const { pending, submit } = useSubmit();
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submit(() => stopRevenueAction(mission.id, end), () => { toast.success(`Plus aucune échéance après le ${formatDate(end)}`); onClose(); }); }}>
      <p className="text-sm"><span className="font-semibold">{mission.company_name}</span> · {mission.label}</p>
      <Field label="Dernier jour" hint="Les échéances après cette date disparaissent des prévisions. L'historique est conservé.">
        <Input type="date" required value={end} min={mission.start_date ?? undefined} onChange={(e) => setEnd(e.target.value)} aria-label="Dernier jour" />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="danger" disabled={pending}>{pending ? <Spinner /> : "Arrêter"}</Button>
      </div>
    </form>
  );
}
