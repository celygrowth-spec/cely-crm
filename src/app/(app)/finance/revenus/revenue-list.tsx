"use client";

// Liste unifiée des revenus (ponctuels et mensuels), et détail d'un revenu avec ses échéances.
import { Pencil, Square, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, cn } from "@/components/ui";
import { KindBadge } from "@/components/finance/revenue-forms";
import { TrashButton } from "@/components/trash/trash-button";
import { addMonths } from "@/lib/finance/dates";
import { eur } from "@/lib/finance/money";
import {
  DUE_STATE,
  revenueStatusLabel,
  anchorDate,
  monthlyDues,
  nextOpenDue,
  oneOffDate,
  oneOffRemaining,
  revenueKind,
  revenueStatus,
  type Due,
  type DueState,
  type RevenueKind,
  type RevenueStatus,
} from "@/lib/finance/revenues";
import type { FinanceData, Invoice, Mission } from "@/lib/finance/types";
import { formatDate } from "@/lib/format";

export type RevenueRow =
  | { type: "mission"; id: string; kind: RevenueKind; mission: Mission; status: RevenueStatus; sortDate: string; next: string | null; nextIsDue: boolean; open: Invoice | null; client: string }
  | { type: "invoice"; id: string; kind: "ponctuel"; invoice: Invoice; status: RevenueStatus; sortDate: string; client: string };

type Tone = "neutral" | "violet" | "success" | "danger" | "warning";
const STATUS_TONE: Record<RevenueStatus, Tone> = {
  prevu: "neutral", a_encaisser: "violet", en_retard: "danger", partiel: "warning", encaisse: "success", a_jour: "success", termine: "neutral", a_verifier: "warning",
};
export const StatusBadge = ({ s, kind }: { s: RevenueStatus; kind?: Mission["kind"] }) => <Badge tone={STATUS_TONE[s]}>{revenueStatusLabel(s, kind)}</Badge>;
const DUE_TONE: Record<DueState, Tone> = { prevue: "neutral", a_verifier: "warning", facturee: "violet", partielle: "warning", en_retard: "danger", encaissee: "success" };

const invoiceStatus = (i: Invoice): RevenueStatus =>
  i.status === "payee" ? "encaisse" : i.status === "en_retard" ? "en_retard" : i.status === "partielle" ? "partiel" : "a_encaisser";
const live = (i: Invoice) => i.kind === "facture" && !i.cancelled_at;

/** Revenus = missions (ponctuelles et mensuelles) + factures enregistrées sans revenu (anciennes données). */
export function revenueRows(data: FinanceData): RevenueRow[] {
  const rows: RevenueRow[] = data.missions.map((m) => {
    const mine = data.invoices.filter((i) => i.mission_id === m.id && live(i));
    const open = mine.filter((i) => i.balance > 0).sort((a, b) => (a.due_date ?? a.issue_date).localeCompare(b.due_date ?? b.issue_date))[0] ?? null;
    // ponctuel : tant que tout n'est pas facturé (acompte puis solde, Q06)
    const next = m.kind === "recurrent" ? nextOpenDue(m, data.invoices, data.today) : (oneOffRemaining(m) ?? (mine.length ? 0 : 1)) > 0 ? oneOffDate(m) : null;
    return { type: "mission" as const, id: m.id, kind: revenueKind(m), mission: m, status: revenueStatus(m, data.invoices, data.today), sortDate: next ?? oneOffDate(m) ?? "", next, nextIsDue: !!next && next <= data.today, open, client: m.company_id };
  });
  for (const i of data.invoices) {
    if (!live(i) || i.mission_id) continue;
    rows.push({ type: "invoice", id: i.id, kind: "ponctuel", invoice: i, status: invoiceStatus(i), sortDate: i.due_date ?? i.issue_date, client: i.company_id });
  }
  // à traiter d'abord (retard, à encaisser), puis par date
  const rank: Record<RevenueStatus, number> = { en_retard: 0, a_verifier: 1, partiel: 2, a_encaisser: 3, a_jour: 4, prevu: 5, encaisse: 6, termine: 7 };
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.sortDate.localeCompare(b.sortDate));
}

type Handlers = { onOpen: (r: RevenueRow) => void; onSettle: (m: Mission, date: string, amount: number | null) => void; onPay: (i: Invoice) => void };

export function RevenueTable({ rows, ...h }: { rows: RevenueRow[] } & Handlers) {
  if (!rows.length) return <EmptyState title="Aucun revenu sur ces critères" />;
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead>
          <tr className="border-b border-line text-left font-label text-[11px] text-muted">
            <th className="px-3 py-2">Client et prestation</th><th>Type</th><th className="text-right">Montant</th><th className="pl-4">Dates</th><th>Statut</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="cursor-pointer border-b border-line last:border-0 hover:bg-surface/60" onClick={() => h.onOpen(r)} data-revenue={r.id}>
              {r.type === "mission" ? <MissionCells r={r} {...h} /> : <InvoiceCells i={r.invoice} s={r.status} onPay={h.onPay} />}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

function MissionCells({ r, onSettle, onPay }: { r: Extract<RevenueRow, { type: "mission" }> } & Handlers) {
  const m = r.mission;
  const monthly = m.kind === "recurrent";
  return (
    <>
      <td className="px-3 py-2"><span className="font-semibold">{m.company_name}</span><span className="block text-xs text-muted">{m.label}</span></td>
      <td><KindBadge kind={r.kind} /></td>
      <td className="text-right font-semibold whitespace-nowrap tabular-nums">{eur(m.amount)}{monthly && <span className="text-xs font-normal text-muted"> /mois</span>}</td>
      <td className="pl-4 text-xs">
        {monthly ? (
          <>
            <span className="block whitespace-nowrap">Dès le {formatDate(anchorDate(m))}{m.end_date ? ` · jusqu'au ${formatDate(m.end_date)}` : " · sans fin"}</span>
            {r.next && <span className="text-muted">Prochaine : {formatDate(r.next)}</span>}
          </>
        ) : <span className="whitespace-nowrap">Prévu le {formatDate(oneOffDate(m))}</span>}
      </td>
      <td><StatusBadge s={r.status} kind={m.kind} /></td>
      <td className="pr-2 text-right whitespace-nowrap">
        {r.open ? <Button size="sm" variant="primary" onClick={stop(() => onPay(r.open!))}>Paiement reçu</Button>
          : r.next && <Button size="sm" variant={r.nextIsDue ? "primary" : "secondary"} onClick={stop(() => onSettle(m, r.next!, monthly ? m.amount : oneOffRemaining(m)))} data-settle>
            {!monthly && r.status !== "prevu" && r.status !== "a_verifier" ? `Encaisser le solde (${eur(oneOffRemaining(m))})` : "Encaisser"}
          </Button>}
      </td>
    </>
  );
}

function InvoiceCells({ i, s, onPay }: { i: Invoice; s: RevenueStatus; onPay: (i: Invoice) => void }) {
  return (
    <>
      <td className="px-3 py-2"><span className="font-semibold">{i.company_name}</span><span className="block text-xs text-muted">{i.reference ?? "Facture enregistrée"}</span></td>
      <td><KindBadge kind="ponctuel" /></td>
      <td className="text-right font-semibold tabular-nums">{eur(i.amount_ttc)}</td>
      <td className="pl-4 text-xs whitespace-nowrap">{i.due_date ? `Échéance ${formatDate(i.due_date)}` : `Émise le ${formatDate(i.issue_date)}`}</td>
      <td><StatusBadge s={s} /></td>
      <td className="pr-2 text-right">{i.balance > 0 && <Button size="sm" variant="primary" onClick={stop(() => onPay(i))}>Paiement reçu</Button>}</td>
    </>
  );
}

// ---------------------------------------------------------------------------
// Détail d'un revenu : échéances (mensuel) ou encaissement prévu (ponctuel)
// ---------------------------------------------------------------------------

export function RevenuePanel({ mission: m, data, onClose, onEdit, onStop, onSettle, onPay, onInvoice, onOpenInvoice }: {
  mission: Mission; data: FinanceData; onClose: () => void; onEdit: () => void; onStop: () => void;
  onSettle: (date: string, amount: number | null) => void; onPay: (i: Invoice) => void; onInvoice: (coverDate: string | null) => void; onOpenInvoice: (id: string) => void;
}) {
  const monthly = m.kind === "recurrent";
  const a = anchorDate(m);
  // historique : 12 derniers mois ; à venir : 6 mois
  const dues: Due[] = monthly && a
    ? monthlyDues(m, data.invoices, addMonths(data.today, -12), addMonths(data.today, 6), data.today)
    : [];
  const status = revenueStatus(m, data.invoices, data.today);
  const mine = data.invoices.filter((i) => i.mission_id === m.id && live(i)).sort((x, y) => y.issue_date.localeCompare(x.issue_date));
  const oneOff = oneOffDate(m);
  const rest = oneOffRemaining(m);
  const ended = !!m.end_date && m.end_date < data.today;
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button className="absolute inset-0 bg-ink/20" aria-label="Fermer le détail" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-label="Détail du revenu" className="relative h-full w-full max-w-md overflow-y-auto border-l border-line bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2"><KindBadge kind={revenueKind(m)} /><StatusBadge s={status} kind={m.kind} /></div>
            <h2 className="mt-1.5 font-display text-xl font-bold">{m.company_name}</h2>
            <p className="text-sm text-muted">{m.label}</p>
          </div>
          <button onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface"><X size={18} /></button>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted">{monthly ? "Montant par mois" : "Montant"}</dt><dd className="font-semibold">{eur(m.amount)}</dd>
          {monthly ? (
            <>
              <dt className="text-muted">Première échéance</dt><dd>{formatDate(a)}</dd>
              <dt className="text-muted">Fin</dt><dd>{m.end_date ? formatDate(m.end_date) : "Sans date de fin"}</dd>
            </>
          ) : (
            <>
              <dt className="text-muted">Encaissement prévu</dt><dd>{formatDate(oneOff)}</dd>
              <dt className="text-muted">Reste à facturer</dt><dd>{eur(rest)}</dd>
            </>
          )}
          <dt className="text-muted">Encaissé au total</dt><dd>{eur(m.received)}</dd>
          <dt className="text-muted">Reste dû (factures)</dt><dd>{eur(m.remaining)}</dd>
        </dl>
        {m.note && <p className="mt-3 rounded-lg bg-surface px-3 py-2 text-sm">{m.note}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={onEdit}><Pencil size={13} /> Modifier{monthly ? " pour la suite" : ""}</Button>
          {monthly && !ended && <Button onClick={onStop}><Square size={13} /> Arrêter</Button>}
          <Button variant="ghost" onClick={() => onInvoice(monthly ? nextOpenDue(m, data.invoices, data.today) : oneOff)}>Saisir une facture détaillée</Button>
          <TrashButton kind="finance_mission" id={m.id} size="md" variant="danger" onDone={onClose}>Supprimer</TrashButton>
        </div>

        {monthly ? (
          <section className="mt-5">
            <h3 className="font-label text-xs font-bold text-muted uppercase">Échéances</h3>
            {dues.length ? (
              <ul className="mt-1 divide-y divide-line text-sm" data-dues>
                {dues.map((d) => <DueLine key={d.date} d={d} onSettle={() => onSettle(d.date, m.amount)} onPay={onPay} onOpenInvoice={onOpenInvoice} />)}
              </ul>
            ) : <p className="mt-1 text-sm text-muted">Aucune échéance sur les 12 derniers et 6 prochains mois.</p>}
            <p className="mt-2 text-xs text-muted">Une échéance reste une prévision tant qu&apos;aucune facture ne la couvre. Encaisser crée la facture et le règlement rattachés : rien n&apos;est compté deux fois.</p>
          </section>
        ) : (
          <section className="mt-5">
            <h3 className="font-label text-xs font-bold text-muted uppercase">Encaissement</h3>
            {oneOff && (rest ?? (mine.length ? 0 : 1)) > 0 && (
              <div className="mt-1 flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm" data-balance>
                <span>{mine.length ? <>Reste à facturer : <strong>{eur(rest)}</strong></> : <>{formatDate(oneOff)} · {eur(rest)}</>}</span>
                <Button size="sm" variant="primary" onClick={() => onSettle(oneOff, rest)}>{mine.length ? `Encaisser le solde (${eur(rest)})` : "Encaisser"}</Button>
              </div>
            )}
            {mine.length > 0 && rest === 0 && <p className="mt-1 text-sm text-muted">Tout le montant prévu est facturé.</p>}
          </section>
        )}

        {mine.length > 0 && (
          <section className="mt-5">
            <h3 className="font-label text-xs font-bold text-muted uppercase">Factures et règlements</h3>
            <ul className="mt-1 divide-y divide-line text-sm">
              {mine.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
                  <button className="flex-1 text-left hover:text-violet-strong" onClick={() => onOpenInvoice(i.id)}>
                    {i.reference ?? `Facture du ${formatDate(i.issue_date)}`}
                    <span className="block text-xs text-muted">{eur(i.amount_ttc)}{i.paid_net > 0 && ` · reçu ${eur(i.paid_net)}`}{i.balance > 0 && ` · reste ${eur(i.balance)}`}</span>
                  </button>
                  {i.balance > 0 && <Button size="sm" onClick={() => onPay(i)}>Paiement reçu</Button>}
                </li>
              ))}
            </ul>
          </section>
        )}
      </aside>
    </div>
  );
}

function DueLine({ d, onSettle, onPay, onOpenInvoice }: { d: Due; onSettle: () => void; onPay: (i: Invoice) => void; onOpenInvoice: (id: string) => void }) {
  return (
    <li className={cn("flex items-center gap-2 py-2", d.state === "encaissee" && "text-muted")} data-due={d.date}>
      <span className="w-28 shrink-0">{formatDate(d.date)}</span>
      <span className="flex-1 font-semibold tabular-nums">{eur(d.amount)}</span>
      <Badge tone={DUE_TONE[d.state]}>{DUE_STATE[d.state]}{d.invoice && d.invoice.balance > 0 && d.invoice.paid_net > 0 ? ` · reste ${eur(d.invoice.balance)}` : ""}</Badge>
      {!d.invoice ? <Button size="sm" variant={d.state === "a_verifier" ? "primary" : "secondary"} onClick={onSettle}>Encaisser</Button>
        : d.invoice.balance > 0 ? <Button size="sm" onClick={() => onPay(d.invoice!)}>Paiement reçu</Button>
        : <Button size="sm" variant="ghost" onClick={() => onOpenInvoice(d.invoice!.id)}>Voir</Button>}
    </li>
  );
}
