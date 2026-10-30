"use client";

// Briques d'interface du module Finance.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Circle, CircleDashed, Clock, Info, Ban, FileMinus, CircleDot } from "lucide-react";
import { Badge, cn, Input, Select } from "@/components/ui";
import { centsToInput, eur, parseEuroInput, type KnownSum } from "@/lib/finance/money";
import { EXPENSE_STATUS, INVOICE_STATUS, URSSAF_STATE } from "@/lib/finance/labels";
import type { ExpenseStatus, InvoiceStatus } from "@/lib/finance/types";
import type { UrssafState } from "@/lib/finance/calc";

/** Montant avec signalement des montants inconnus (jamais affichés comme zéro). */
export function Money({ value, unknown = 0, className }: { value: number | null | KnownSum; unknown?: number; className?: string }) {
  const cents = value !== null && typeof value === "object" ? value.cents : value;
  const unk = value !== null && typeof value === "object" ? value.unknown : unknown;
  if (cents === null) return <span className={cn("text-muted italic", className)}>Montant inconnu</span>;
  return (
    <span className={className}>
      {eur(cents)}
      {unk > 0 && (
        <span className="ml-1 inline-flex items-center gap-0.5 align-middle font-label text-[11px] font-semibold text-warning">
          <AlertTriangle size={11} aria-hidden /> incomplet : {unk} montant{unk > 1 ? "s" : ""} inconnu{unk > 1 ? "s" : ""}
        </span>
      )}
    </span>
  );
}

const invoiceTone: Record<InvoiceStatus, Parameters<typeof Badge>[0]["tone"]> = {
  a_encaisser: "violet",
  partielle: "warning",
  payee: "success",
  en_retard: "danger",
  annulee: "neutral",
  avoir: "neutral",
};
const invoiceIcon: Record<InvoiceStatus, ReactNode> = {
  a_encaisser: <Circle size={11} aria-hidden />,
  partielle: <CircleDot size={11} aria-hidden />,
  payee: <CheckCircle2 size={11} aria-hidden />,
  en_retard: <AlertTriangle size={11} aria-hidden />,
  annulee: <Ban size={11} aria-hidden />,
  avoir: <FileMinus size={11} aria-hidden />,
};
export function InvoiceBadge({ status }: { status: InvoiceStatus }) {
  return <Badge tone={invoiceTone[status]}>{invoiceIcon[status]}{INVOICE_STATUS[status]}</Badge>;
}

export function ExpenseBadge({ status, late }: { status: ExpenseStatus; late?: boolean }) {
  if (status === "paye") return <Badge tone="success"><CheckCircle2 size={11} aria-hidden />{EXPENSE_STATUS.paye}</Badge>;
  if (status === "annule") return <Badge><Ban size={11} aria-hidden />{EXPENSE_STATUS.annule}</Badge>;
  return late ? <Badge tone="danger"><AlertTriangle size={11} aria-hidden />À payer · en retard</Badge> : <Badge tone="violet"><Clock size={11} aria-hidden />{EXPENSE_STATUS.a_payer}</Badge>;
}

export function UrssafBadge({ state }: { state: UrssafState }) {
  const map: Record<UrssafState, [Parameters<typeof Badge>[0]["tone"], ReactNode]> = {
    a_preparer: ["neutral", <CircleDashed key="i" size={11} aria-hidden />],
    a_declarer: ["warning", <AlertTriangle key="i" size={11} aria-hidden />],
    declare: ["violet", <Clock key="i" size={11} aria-hidden />],
    paye: ["success", <CheckCircle2 key="i" size={11} aria-hidden />],
  };
  return <Badge tone={map[state][0]}>{map[state][1]}{URSSAF_STATE[state]}</Badge>;
}

/** Indicateur avec définition accessible et lien vers les lignes concernées. */
export function Kpi({
  title,
  value,
  sub,
  definition,
  href,
  tone,
}: {
  title: string;
  value: ReactNode;
  sub?: ReactNode;
  definition: string;
  href?: string;
  tone?: "warning" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className={cn("flex flex-col rounded-xl border bg-white p-3", tone === "danger" ? "border-danger/30" : tone === "warning" ? "border-amber-200" : "border-line")}>
      <div className="flex items-start justify-between gap-2">
        <p className="font-label text-xs font-semibold text-muted">{title}</p>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={id}
          aria-label={`Définition : ${title}`}
          className="rounded p-0.5 text-muted hover:bg-surface hover:text-ink"
        >
          <Info size={14} />
        </button>
      </div>
      <p className="mt-1 font-display text-xl font-extrabold tracking-tight text-ink">{value}</p>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
      <p id={id} hidden={!open} className="mt-2 rounded-md bg-surface px-2 py-1.5 text-xs text-muted">{definition}</p>
      {href && (
        <Link href={href} className="mt-auto pt-2 text-xs font-semibold text-violet-strong hover:underline">
          Voir les lignes →
        </Link>
      )}
    </div>
  );
}

/** Sélecteur de période (mois, trimestre, année, personnalisée) dans l'URL. */
export function PeriodSelector({ kind, from, to, label, prevHref, nextHref }: { kind: string; from: string; to: string; label: string; prevHref: string; nextHref: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [du, setDu] = useState(from);
  const [au, setAu] = useState(to);
  const go = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, val] of Object.entries(patch)) {
      if (val === null) sp.delete(k);
      else sp.set(k, val);
    }
    router.push(`${pathname}?${sp.toString()}`);
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="Type de période" className="inline-flex rounded-lg border border-line bg-white p-0.5">
        {[
          ["mois", "Mois"],
          ["trimestre", "Trimestre"],
          ["annee", "Année"],
          ["perso", "Personnalisée"],
        ].map(([k, l]) => (
          <button
            key={k}
            type="button"
            aria-pressed={kind === k}
            onClick={() => go(k === "perso" ? { p: k, du: from, au: to } : { p: k, ref: from, du: null, au: null })}
            className={cn("rounded-md px-2.5 py-1 text-xs font-semibold", kind === k ? "bg-ink text-white" : "text-muted hover:text-ink")}
          >
            {l}
          </button>
        ))}
      </div>
      {kind === "perso" ? (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (du && au && du <= au) go({ p: "perso", du, au });
          }}
        >
          <Input type="date" value={du} onChange={(e) => setDu(e.target.value)} aria-label="Du" className="h-8 w-36" />
          <span className="text-xs text-muted">au</span>
          <Input type="date" value={au} onChange={(e) => setAu(e.target.value)} aria-label="Au" className="h-8 w-36" />
          <button className="h-8 rounded-lg bg-ink px-2.5 text-xs font-semibold text-white">Appliquer</button>
        </form>
      ) : (
        <div className="flex items-center gap-1">
          <Link href={prevHref} className="rounded-md border border-line px-2 py-1 text-xs font-semibold hover:bg-surface" aria-label="Période précédente">←</Link>
          <span className="min-w-28 text-center text-sm font-semibold capitalize">{label}</span>
          <Link href={nextHref} className="rounded-md border border-line px-2 py-1 text-xs font-semibold hover:bg-surface" aria-label="Période suivante">→</Link>
        </div>
      )}
    </div>
  );
}

/** Champ montant en euros (saisie française), valeur en centimes. */
export function MoneyInput({
  value,
  onChange,
  required,
  placeholder = "0,00",
  ...rest
}: { value: number | null; onChange: (c: number | null) => void; required?: boolean; placeholder?: string; id?: string; "aria-label"?: string }) {
  const [text, setText] = useState(centsToInput(value));
  const parsed = parseEuroInput(text);
  const invalid = Number.isNaN(parsed);
  return (
    <div className="relative">
      <Input
        {...rest}
        inputMode="decimal"
        value={text}
        required={required}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        className={cn("pr-7", invalid && "border-danger")}
        onChange={(e) => {
          setText(e.target.value);
          const c = parseEuroInput(e.target.value);
          onChange(Number.isNaN(c) ? null : c);
        }}
      />
      <span className="pointer-events-none absolute top-2 right-2.5 text-sm text-muted">€</span>
      {invalid && <p className="mt-1 text-xs text-danger">Montant illisible (ex. 1 250,50)</p>}
    </div>
  );
}

export function CategorySelect({ categories, value, onChange }: { categories: { id: string; name: string }[]; value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Sans catégorie</option>
      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </Select>
  );
}

/** Section repliable pour les options avancées des formulaires. */
export function Advanced({ children, label = "Options avancées" }: { children: ReactNode; label?: string }) {
  return (
    <details className="rounded-lg border border-line bg-surface/50 px-3 py-2">
      <summary className="cursor-pointer font-label text-xs font-semibold text-muted">{label}</summary>
      <div className="mt-3 space-y-3">{children}</div>
    </details>
  );
}

export function Legend3() {
  return (
    <p className="flex flex-wrap gap-3 text-xs text-muted">
      <span className="inline-flex items-center gap-1"><span className="inline-block size-3 rounded-sm bg-violet-strong" aria-hidden /> Réalisé (mouvements réels)</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block size-3 rounded-sm border-2 border-violet-strong bg-violet-soft" aria-hidden /> Prévu (factures émises, charges planifiées)</span>
      <span className="inline-flex items-center gap-1"><span className="inline-block size-3 rounded-sm border-2 border-dashed border-violet-strong" aria-hidden /> Estimé (missions, abonnements, cotisations)</span>
    </p>
  );
}
