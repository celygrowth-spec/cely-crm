"use client";

// Briques communes de l'espace Tracking site : cartes, variations, listes à barres, tableaux, états vides.
// Tout élément qui représente une source, une campagne, une page ou un mot-clé est cliquable (filtre ou détail).
import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Skeleton, cn } from "@/components/ui";
import { channelLabel, channelVar } from "@/lib/tracking/channels";
import { num, percent } from "./state";

export function Panel({ title, hint, action, children, className, stale }: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; className?: string; stale?: boolean }) {
  return (
    <section className={cn("trk-card min-w-0 p-4 sm:p-5", className)}>
      {(title || action) && (
        <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="font-display text-base font-bold text-ink">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      <div className={stale ? "trk-stale" : "trk-fresh"}>{children}</div>
    </section>
  );
}

/** Variation par rapport à la période précédente : flèche + valeur, jamais la couleur seule. */
export function Delta({ current, previous, inverse, suffix = "%" }: { current: number; previous: number; inverse?: boolean; suffix?: string }) {
  if (!previous && !current) return <span className="inline-flex items-center gap-0.5 text-xs text-muted"><Minus size={12} aria-hidden /> stable</span>;
  if (!previous) return <span className="inline-flex items-center gap-0.5 text-xs font-semibold" style={{ color: "var(--trk-up)" }}><ArrowUpRight size={13} aria-hidden /> nouveau</span>;
  const change = suffix === "pt" ? current - previous : (100 * (current - previous)) / previous;
  const flat = Math.abs(change) < 0.05;
  const good = inverse ? change < 0 : change > 0;
  const Icon = flat ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;
  // au-delà de +999 %, un multiplicateur se lit mieux qu'un pourcentage à cinq chiffres
  const value = suffix === "%" && change > 999
    ? `× ${Math.round(current / previous).toLocaleString("fr-FR")}`
    : `${change > 0 ? "+" : ""}${change.toLocaleString("fr-FR", { maximumFractionDigits: Math.abs(change) < 10 ? 1 : 0 })} ${suffix}`;
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-semibold" style={{ color: flat ? "var(--muted)" : good ? "var(--trk-up)" : "var(--trk-down)" }}
      title={`Période précédente : ${num(previous)}`}>
      <Icon size={13} aria-hidden /> {flat ? "stable" : value}
    </span>
  );
}

export function ChannelDot({ channel, className }: { channel: string; className?: string }) {
  return <span className={cn("inline-block size-2.5 shrink-0 rounded-full", className)} style={{ background: channelVar(channel) }} aria-hidden />;
}

/** Pastille de source cliquable : même couleur partout. */
export function ChannelChip({ channel, onClick, detail }: { channel: string | null | undefined; onClick?: () => void; detail?: string | null }) {
  if (!channel) return <span className="text-muted">Non mesurée</span>;
  const body = (
    <>
      <ChannelDot channel={channel} />
      <span className="truncate">{channelLabel(channel)}{detail ? <span className="text-muted"> · {detail}</span> : null}</span>
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="inline-flex max-w-full items-center gap-1.5 rounded-md text-left hover:underline" title={`Filtrer sur ${channelLabel(channel)}`}>{body}</button>
    : <span className="inline-flex max-w-full items-center gap-1.5">{body}</span>;
}

export type BarItem = { key: string; label: string; value: number; sub?: string; color?: string; title?: string };
/** Liste classée avec barres fines : une ligne = un élément cliquable. */
export function BarList({ items, onPick, unit, max, empty = "Aucune donnée sur la période." }: { items: BarItem[]; onPick?: (key: string) => void; unit?: (v: number) => string; max?: number; empty?: string }) {
  if (!items.length) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  const top = max ?? Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="grid gap-1">
      {items.map((i) => {
        const row = (
          <>
            <span className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate font-semibold text-ink">{i.label}</span>
              <span className="shrink-0 tabular-nums text-ink">{unit ? unit(i.value) : num(i.value)}{i.sub && <span className="ml-1.5 text-xs text-muted">{i.sub}</span>}</span>
            </span>
            <span className="mt-1 block h-1.5 overflow-hidden rounded-full" style={{ background: "var(--trk-track)" }}>
              <span className="trk-bar block h-full rounded-full" style={{ width: `${Math.max((100 * i.value) / top, i.value > 0 ? 1.5 : 0)}%`, background: i.color ?? "var(--violet)" }} />
            </span>
          </>
        );
        return (
          <li key={i.key}>
            {onPick
              ? <button type="button" onClick={() => onPick(i.key)} title={i.title} className="trk-row block w-full rounded-lg px-2 py-1.5 text-left">{row}</button>
              : <div className="px-2 py-1.5" title={i.title}>{row}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export type Column<T> = { key: string; label: string; align?: "right"; className?: string; render: (row: T) => ReactNode; sort?: (row: T) => number | string };
/** Tableau dense, défilable horizontalement sur mobile ; la ligne entière est cliquable quand onRow est fourni. */
export function DataTable<T>({ rows, columns, rowKey, onRow, rowTitle, empty = "Aucune donnée sur la période.", limit }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; onRow?: (row: T) => void; rowTitle?: (row: T) => string; empty?: string; limit?: number;
}) {
  if (!rows.length) return <p className="py-8 text-center text-sm text-muted">{empty}</p>;
  const shown = limit ? rows.slice(0, limit) : rows;
  return (
    <div className="-mx-4 overflow-x-auto sm:-mx-5">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left">
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cn("py-2 font-label text-[11px] font-bold tracking-wide whitespace-nowrap text-muted uppercase px-2.5 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5", c.align === "right" && "text-right")}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr key={rowKey(r)} tabIndex={onRow ? 0 : undefined} title={rowTitle?.(r)}
              onClick={onRow ? () => onRow(r) : undefined}
              onKeyDown={onRow ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onRow(r); } } : undefined}
              className={cn("border-b border-line/60 last:border-0", onRow && "trk-row cursor-pointer")}>
              {columns.map((c) => (
                <td key={c.key} className={cn("py-2 align-middle px-2.5 first:pl-4 last:pr-4 sm:first:pl-5 sm:last:pr-5", c.align === "right" && "text-right tabular-nums", c.className)}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {limit && rows.length > limit && <p className="px-4 pt-2 text-xs text-muted sm:px-5">{rows.length - limit} autres lignes non affichées : affinez la période ou les filtres.</p>}
    </div>
  );
}

/** État vide : dit ce qui manque et comment obtenir des données. */
export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-12 text-center" data-empty>
      {icon && <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-violet-soft text-violet-strong">{icon}</div>}
      <p className="font-display text-lg font-bold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <Link href={action.href} className="mt-4 inline-flex h-9 items-center rounded-lg bg-ink px-4 text-sm font-semibold text-[var(--background)] hover:opacity-90">{action.label}</Link>}
    </div>
  );
}

export function ErrorNote({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div role="alert" className="trk-card flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
      <span className="text-danger">{message}</span>
      {retry && <button type="button" onClick={retry} className="font-semibold text-violet-strong hover:underline">Réessayer</button>}
    </div>
  );
}

/** Squelettes qui reprennent la forme finale (premier chargement uniquement). */
export function PanelSkeleton({ height = "h-64", title = true }: { height?: string; title?: boolean }) {
  return (
    <div className="trk-card p-4 sm:p-5" aria-hidden>
      {title && <Skeleton className="mb-4 h-5 w-40" />}
      <Skeleton className={cn("w-full rounded-xl", height)} />
    </div>
  );
}
export function TabSkeleton() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-label="Chargement">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <div key={i} className="trk-card p-4"><Skeleton className="h-4 w-24" /><Skeleton className="mt-3 h-8 w-20" /><Skeleton className="mt-3 h-8 w-full" /></div>)}</div>
      <PanelSkeleton height="h-72" />
      <div className="grid gap-4 lg:grid-cols-2"><PanelSkeleton height="h-48" /><PanelSkeleton height="h-48" /></div>
    </div>
  );
}

/** Légende : une pastille par série, cliquable pour filtrer. Toujours présente dès deux séries. */
export function Legend({ items, onPick, active }: { items: { key: string; label: string; color: string; value?: number }[]; onPick?: (key: string) => void; active?: string | null }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
      {items.map((i) => {
        const body = (
          <>
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: i.color }} aria-hidden />
            <span className={cn(active && active !== i.key ? "text-muted" : "text-ink")}>{i.label}</span>
            {i.value !== undefined && <span className="tabular-nums text-muted">{num(i.value)}</span>}
          </>
        );
        return (
          <li key={i.key}>
            {onPick
              ? <button type="button" onClick={() => onPick(i.key)} aria-pressed={active === i.key} className="inline-flex items-center gap-1.5 rounded hover:underline" title={active === i.key ? "Retirer ce filtre" : `Filtrer sur ${i.label}`}>{body}</button>
              : <span className="inline-flex items-center gap-1.5">{body}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export const share = (part: number, whole: number) => (whole > 0 ? percent((100 * part) / whole, 0) : "0 %");
