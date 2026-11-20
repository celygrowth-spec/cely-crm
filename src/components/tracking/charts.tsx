"use client";

// Graphiques de l'espace Tracking site (recharts, déjà utilisé par Finance). Courbes lissées avec un dégradé léger,
// grille discrète, info-bulle détaillée qui liste toutes les séries du point survolé, clic sur un point ou une
// série pour filtrer. Les couleurs viennent de variables CSS : elles suivent le mode clair ou sombre.
import { useId } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { bucketLabel, dayShort, monthShort, num } from "./state";

export type Point = { d: string; [series: string]: number | string | null };
export type Series = { key: string; label: string; color: string };

const axis = { fontSize: 11, fill: "var(--trk-axis)" };
const ANIM = { isAnimationActive: true, animationDuration: 450, animationEasing: "ease-out" as const };

function ticks(points: Point[], bucket: string) {
  const long = points.length > 120 || (bucket === "week" && points.length > 26);
  return { format: (d: string) => (long ? monthShort(d) : dayShort(d)), gap: long ? 48 : 28 };
}

type TipProps = { active?: boolean; label?: string | number; payload?: readonly { dataKey?: unknown; value?: unknown }[]; series: Series[]; bucket: string; unit?: (v: number) => string; total?: string; hint?: string };
/** Info-bulle : la valeur en premier, une ligne de couleur par série, total en tête. */
function Tip({ active, label, payload, series, bucket, unit = num, total, hint }: TipProps) {
  if (!active || !payload?.length || typeof label !== "string") return null;
  const rows = series.map((s) => ({ ...s, value: Number(payload.find((p) => p.dataKey === s.key)?.value ?? 0) })).filter((r) => r.value > 0 || series.length <= 3);
  const sum = rows.reduce((n, r) => n + r.value, 0);
  return (
    <div className="trk-card min-w-44 px-3 py-2 text-xs" style={{ boxShadow: "0 10px 30px -10px rgb(0 0 0 / 0.35)" }}>
      <p className="mb-1.5 font-semibold text-ink first-letter:uppercase">{bucketLabel(label, bucket)}</p>
      {total && series.length > 1 && <p className="mb-1 flex justify-between gap-4 border-b border-line pb-1"><span className="text-muted">{total}</span><strong className="tabular-nums text-ink">{unit(sum)}</strong></p>}
      <ul className="grid gap-0.5">
        {rows.sort((a, b) => b.value - a.value).map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-muted"><span className="inline-block h-0.5 w-3 rounded-full" style={{ background: r.color }} aria-hidden />{r.label}</span>
            <strong className="tabular-nums text-ink">{unit(r.value)}</strong>
          </li>
        ))}
      </ul>
      {hint && <p className="mt-1.5 border-t border-line pt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

type ChartProps = {
  points: Point[]; series: Series[]; bucket: string; height?: string; label: string;
  /** clic sur un point : le jour (ou la semaine) devient la période */
  onPickPoint?: (d: string) => void;
  total?: string; unit?: (v: number) => string;
};

/** Visites dans le temps, empilées par série. Une seule journée : des points bien visibles plutôt qu'une courbe vide. */
export function StackedArea({ points, series, bucket, height = "h-72", label, onPickPoint, total = "Total" }: ChartProps) {
  const id = useId().replace(/:/g, "");
  const t = ticks(points, bucket);
  const single = points.length === 1;
  return (
    <div className={height} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
          onClick={onPickPoint ? (e) => { const d = (e as { activeLabel?: unknown } | null)?.activeLabel; if (typeof d === "string") onPickPoint(d); } : undefined}
          style={onPickPoint ? { cursor: "pointer" } : undefined}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`${id}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.42} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.06} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--trk-grid)" vertical={false} />
          <XAxis dataKey="d" tickFormatter={t.format} tick={axis} tickLine={false} axisLine={{ stroke: "var(--trk-grid)" }} minTickGap={t.gap} padding={single ? { left: 60, right: 60 } : undefined} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={44} allowDecimals={false} tickFormatter={(v) => num(Number(v))} />
          <Tooltip cursor={{ stroke: "var(--trk-axis)", strokeWidth: 1 }} content={(p) => <Tip {...(p as unknown as TipProps)} series={series} bucket={bucket} total={total} hint={onPickPoint ? "Cliquer pour voir cette période" : undefined} />} />
          {series.map((s) => (
            <Area key={s.key} type="monotone" dataKey={s.key} stackId="1" stroke={s.color} strokeWidth={2} fill={`url(#${id}-${s.key})`}
              dot={single ? { r: 4, fill: s.color, stroke: "var(--trk-card)", strokeWidth: 2 } : false}
              activeDot={{ r: 4, stroke: "var(--trk-card)", strokeWidth: 2 }} {...ANIM} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Courbes comparées (campagnes, moteurs d'IA, positions). `reversed` : axe inversé, la position 1 en haut. */
export function Lines({ points, series, bucket, height = "h-64", label, onPickPoint, reversed, unit, connectNulls = true }: ChartProps & { reversed?: boolean; connectNulls?: boolean }) {
  const t = ticks(points, bucket);
  const single = points.length === 1;
  return (
    <div className={height} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}
          onClick={onPickPoint ? (e) => { const d = (e as { activeLabel?: unknown } | null)?.activeLabel; if (typeof d === "string") onPickPoint(d); } : undefined}
          style={onPickPoint ? { cursor: "pointer" } : undefined}>
          <CartesianGrid stroke="var(--trk-grid)" vertical={false} />
          <XAxis dataKey="d" tickFormatter={t.format} tick={axis} tickLine={false} axisLine={{ stroke: "var(--trk-grid)" }} minTickGap={t.gap} padding={single ? { left: 60, right: 60 } : undefined} />
          <YAxis tick={axis} tickLine={false} axisLine={false} width={44} allowDecimals={false} reversed={reversed} domain={reversed ? [1, "auto"] : [0, "auto"]} tickFormatter={(v) => num(Number(v))} />
          <Tooltip cursor={{ stroke: "var(--trk-axis)", strokeWidth: 1 }} content={(p) => <Tip {...(p as unknown as TipProps)} series={series} bucket={bucket} unit={unit} hint={onPickPoint ? "Cliquer pour voir cette période" : undefined} />} />
          {series.map((s) => (
            <Line key={s.key} type="monotone" dataKey={s.key} stroke={s.color} strokeWidth={2} strokeLinecap="round" connectNulls={connectNulls}
              dot={single ? { r: 4, fill: s.color, stroke: "var(--trk-card)", strokeWidth: 2 } : false}
              activeDot={{ r: 4, stroke: "var(--trk-card)", strokeWidth: 2 }} {...ANIM} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Mini-courbe d'une carte de chiffre clé : la tendance seule, sans axe. */
export function Sparkline({ points, dataKey, color = "var(--violet)" }: { points: Point[]; dataKey: string; color?: string }) {
  const id = useId().replace(/:/g, "");
  if (points.length < 2) return <div className="h-10" aria-hidden />;
  return (
    <div className="h-10" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 3, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.75} fill={`url(#${id})`} dot={false} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
