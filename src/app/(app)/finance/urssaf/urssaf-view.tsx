"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Download, ExternalLink } from "lucide-react";
import { urssafDeclareAction, urssafPayAction, urssafResetAction, urssafSetDeadlineAction } from "@/app/finance-actions";
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Spinner } from "@/components/ui";
import { Money, MoneyInput, UrssafBadge } from "@/components/finance/bits";
import { rateAt, settingsAt, urssafRows, urssafSummary, type UrssafRow } from "@/lib/finance/calc";
import { PERIODICITY, REGIME } from "@/lib/finance/labels";
import { eur, formatRate, milliToRate } from "@/lib/finance/money";
import type { FinanceData } from "@/lib/finance/types";
import { formatDate, todayISO } from "@/lib/format";

const periodLabel = (r: { start: string; end: string }) => {
  const f = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
  const a = f.format(new Date(r.start + "T12:00:00Z"));
  return r.start.slice(0, 7) === r.end.slice(0, 7) ? a : `${a} → ${f.format(new Date(r.end + "T12:00:00Z"))}`;
};

export function UrssafView({ data }: { data: FinanceData }) {
  const router = useRouter();
  const rows = urssafRows(data);
  const sum = urssafSummary(rows);
  const s = settingsAt(data.settings, data.today);
  const social = s ? rateAt(data.rates, s.regime, "social", data.today) : null;
  const cfp = s ? rateAt(data.rates, s.regime, "cfp", data.today) : null;
  const [declaring, setDeclaring] = useState<UrssafRow | null>(null);
  const [paying, setPaying] = useState<UrssafRow | null>(null);
  const [pending, start] = useTransition();
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
        title="URSSAF"
        description="Trois suivis distincts par période : estimé (calcul de l'application), déclaré (vos chiffres, figés) et payé. Rien n'est transmis à l'Urssaf."
        actions={<a href="/api/finance/export?type=urssaf" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-semibold hover:bg-surface"><Download size={14} /> CSV</a>}
      />
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <Card className="p-4 md:col-span-2">
          <p className="font-label text-xs text-muted">Régime en vigueur</p>
          <p className="font-semibold">{s ? REGIME[s.regime] : "Non configuré"} · déclaration {s ? PERIODICITY[s.periodicity].toLowerCase() : "—"}</p>
          {s?.regime !== "manual" && (
            <p className="mt-1 text-sm">
              Taux actuel : {social ? <strong>{formatRate(social.rate_milli)}</strong> : <span className="text-warning">non renseigné</span>}
              {cfp && <> + formation professionnelle {formatRate(cfp.rate_milli)}</>} du chiffre d&apos;affaires HT encaissé.
              {social?.source_url && <> <a href={social.source_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-xs font-semibold text-violet-strong">Source <ExternalLink size={11} /></a> (vérifiée le {formatDate(social.verified_on)})</>}
            </p>
          )}
          {s?.acre && <p className="mt-1 text-sm text-warning">ACRE : l&apos;application ne calcule pas le taux réduit. Saisissez les montants indiqués par l&apos;Urssaf.</p>}
          {s?.versement_liberatoire && <p className="mt-1 text-sm text-warning">Versement libératoire : non inclus dans les estimations.</p>}
          <p className="mt-2 text-xs text-muted">
            Base : chiffre d&apos;affaires HT réellement encaissé sur la période (aucune déduction). Les charges enregistrées ne réduisent jamais cette base.
            Échéance : fin du mois suivant la période (règle générale), modifiable si l&apos;Urssaf l&apos;a déplacée. <Link href="/finance/parametres" className="font-semibold text-violet-strong">Réglages et sources</Link>
          </p>
        </Card>
        <Card className="p-4">
          <p className="font-label text-xs text-muted">À provisionner</p>
          <p className="font-display text-2xl font-extrabold"><Money value={sum.toProvision} /></p>
          <p className="mt-1 text-xs text-muted">{sum.a_declarer} à déclarer · {sum.declare} déclarée(s) à payer · {sum.paye} payée(s)</p>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-sm">
          <thead>
            <tr className="border-b border-line text-left font-label text-[11px] text-muted">
              <th className="px-3 py-2">Période</th><th>État</th><th className="text-right">CA encaissé HT</th><th className="text-right">Estimé</th><th>Échéance</th><th>Déclaré</th><th>Payé</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.start + r.end} className="border-b border-line align-top last:border-0">
                <td className="px-3 py-2 font-semibold capitalize">{periodLabel(r)}</td>
                <td><UrssafBadge state={r.state} /></td>
                <td className="text-right">{eur(r.estimate.base)}</td>
                <td className="text-right">
                  {r.estimate.status === "estime" ? (
                    <>
                      {eur(r.estimate.total)}
                      <span className="block text-[11px] text-muted">{formatRate(r.estimate.socialRate.rate_milli)}{r.estimate.cfpRate && ` + ${formatRate(r.estimate.cfpRate.rate_milli)}`}{r.state === "a_preparer" && " · en cours"}</span>
                      {r.estimate.warnings.map((w) => <span key={w} className="block text-[11px] text-warning">{w}</span>)}
                    </>
                  ) : <span className="text-xs text-muted" title={r.estimate.reason}>{r.estimate.status === "manuel" ? "Suivi manuel" : r.estimate.status === "taux_manquant" ? "Taux manquant" : "Non calculé"}</span>}
                </td>
                <td className="text-xs whitespace-nowrap">
                  <span className={r.deadline < data.today && r.state !== "paye" ? "font-semibold text-danger" : undefined}>{formatDate(r.deadline)}</span>
                  <span className="block text-[11px] text-muted">{r.deadlineOrigin === "saisie" ? "saisie par vous" : "règle officielle"}</span>
                  {r.state !== "paye" && (
                    <button className="text-[11px] font-semibold text-violet-strong" disabled={pending} onClick={() => {
                      const d = prompt("Échéance (AAAA-MM-JJ), vide pour revenir à la règle officielle :", r.deadline);
                      if (d !== null) act(() => urssafSetDeadlineAction(r.start, r.end, d.trim() || null), "Échéance enregistrée");
                    }}>Modifier</button>
                  )}
                </td>
                <td className="text-xs">
                  {r.record?.declared_on ? (
                    <>
                      <span className="font-semibold">{eur(r.record.declared_amount)}</span> le {formatDate(r.record.declared_on)}
                      {r.record.declared_base != null && <span className="block text-[11px] text-muted">base déclarée {eur(r.record.declared_base)}</span>}
                      {r.discrepancy && (
                        <span className="mt-0.5 flex items-start gap-1 text-[11px] font-semibold text-warning">
                          <AlertTriangle size={11} className="mt-0.5 shrink-0" aria-hidden />
                          Écart avec les données actuelles{r.discrepancy.base !== null && ` : base ${r.discrepancy.base > 0 ? "+" : "−"}${eur(Math.abs(r.discrepancy.base))}`}
                          {r.discrepancy.amount !== null && ` · montant ${r.discrepancy.amount > 0 ? "+" : "−"}${eur(Math.abs(r.discrepancy.amount))}`}
                        </span>
                      )}
                      {r.record.estimate_amount_at_declaration != null && <span className="block text-[11px] text-muted">estimation au moment de la déclaration : {eur(r.record.estimate_amount_at_declaration)}</span>}
                    </>
                  ) : "—"}
                </td>
                <td className="text-xs">{r.record?.paid_on ? <><span className="font-semibold">{eur(r.record.paid_amount)}</span> le {formatDate(r.record.paid_on)}</> : r.state === "paye" ? "Rien à payer" : "—"}{r.record?.reference && <span className="block text-[11px] text-muted">Réf. {r.record.reference}</span>}</td>
                <td className="pr-2 text-right whitespace-nowrap">
                  {!r.record?.declared_on && <Button size="sm" variant={r.state === "a_declarer" ? "primary" : "secondary"} onClick={() => setDeclaring(r)}>{r.end < data.today ? "Déjà déclaré" : "Déclarer"}</Button>}
                  {r.state === "declare" && <Button size="sm" variant="primary" onClick={() => setPaying(r)}>Déjà payé</Button>}
                  {r.record?.declared_on && (
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
                      const what = r.record!.paid_on ? "payment" : "declaration";
                      if (confirm(what === "payment" ? "Retirer le paiement enregistré (erreur de saisie) ?" : "Retirer la déclaration enregistrée (erreur de saisie) ?")) act(() => urssafResetAction(r.record!.id, what), "Correction enregistrée");
                    }}>Corriger</Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <p className="mt-2 text-xs text-muted">Une cotisation payée apparaît une seule fois dans les décaissements, même si elle est aussi affichée dans les charges.</p>
      <DeclareModal row={declaring} onClose={() => setDeclaring(null)} />
      <PayModal row={paying} onClose={() => setPaying(null)} />
    </div>
  );
}

function DeclareModal({ row, onClose }: { row: UrssafRow | null; onClose: () => void }) {
  return (
    <Modal open={!!row} onClose={onClose} title="Enregistrer la déclaration">
      {row && <DeclareBody row={row} onClose={onClose} />}
    </Modal>
  );
}

function DeclareBody({ row, onClose }: { row: UrssafRow; onClose: () => void }) {
  const router = useRouter();
  const est = row.estimate;
  const [key] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(todayISO());
  const [base, setBase] = useState<number | null>(est.base);
  const [amount, setAmount] = useState<number | null>(est.status === "estime" ? est.total : null);
  const [paid, setPaid] = useState(false);
  const [paidOn, setPaidOn] = useState(todayISO());
  const [paidAmount, setPaidAmount] = useState<number | null>(null);
  const [reference, setReference] = useState("");
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount == null) return toast.error("Indiquez le montant déclaré");
        start(async () => {
          const r = await urssafDeclareAction(
            {
              start: row.start, end: row.end, declared_on: date, base, amount, reference,
              estimate: { base: est.base, amount: est.status === "estime" ? est.total : null, rate: est.status === "estime" ? milliToRate(est.socialRate.rate_milli + (est.cfpRate?.rate_milli ?? 0)) : null },
              paid_on: paid ? paidOn : null, paid_amount: paid ? paidAmount ?? amount : null,
            },
            key,
          );
          if (!r.ok) return void toast.error(r.error);
          toast.success(paid ? "Déclaration et paiement enregistrés" : "Déclaration enregistrée");
          onClose();
          router.refresh();
        });
      }}
    >
      <p className="text-sm capitalize">{periodLabel(row)}</p>
      <p className="text-xs text-muted">Reportez les chiffres de votre déclaration sur autoentrepreneur.urssaf.fr. Ils seront figés, même si vos données ou les taux changent ensuite.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Chiffre d'affaires déclaré" hint={`Encaissé selon l'application : ${eur(est.base)}`}><MoneyInput value={base} onChange={setBase} aria-label="Chiffre d'affaires déclaré" /></Field>
        <Field label="Cotisations déclarées" hint={est.status === "estime" ? `Estimation : ${eur(est.total)}` : est.reason}><MoneyInput value={amount} onChange={setAmount} required aria-label="Cotisations déclarées" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date de déclaration"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Référence (facultatif)"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Déjà payé</label>
      {paid && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Montant payé"><MoneyInput value={paidAmount ?? amount} onChange={setPaidAmount} aria-label="Montant payé" /></Field>
          <Field label="Date de paiement"><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        </div>
      )}
      {est.status === "estime" && amount != null && amount !== est.total && <Badge tone="warning"><AlertTriangle size={11} aria-hidden /> Écart de {eur(Math.abs(amount - est.total))} avec l&apos;estimation</Badge>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
      </div>
    </form>
  );
}

function PayModal({ row, onClose }: { row: UrssafRow | null; onClose: () => void }) {
  return (
    <Modal open={!!row} onClose={onClose} title="Enregistrer le paiement">
      {row && <PayBody row={row} onClose={onClose} />}
    </Modal>
  );
}

function PayBody({ row, onClose }: { row: UrssafRow; onClose: () => void }) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(row.record?.declared_amount ?? null);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (amount == null) return toast.error("Indiquez le montant payé");
        start(async () => {
          const r = await urssafPayAction({ id: row.record!.id, paid_on: date, amount, reference: null }, key);
          if (!r.ok) return void toast.error(r.error);
          toast.success("Paiement enregistré");
          onClose();
          router.refresh();
        });
      }}
    >
      <p className="text-sm capitalize">{periodLabel(row)} · déclaré {eur(row.record?.declared_amount)}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Montant payé"><MoneyInput value={amount} onChange={setAmount} required aria-label="Montant payé" /></Field>
        <Field label="Date de paiement"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Annuler</Button>
        <Button type="submit" variant="primary" disabled={pending}>{pending ? <Spinner /> : "Enregistrer"}</Button>
      </div>
    </form>
  );
}
