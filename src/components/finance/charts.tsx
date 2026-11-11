"use client";

// Graphiques Finance (recharts). Deux couleurs validées pour les daltonismes (violet / orange),
// toujours accompagnées d'une légende textuelle et d'une vue tableau.
import { Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { eur } from "@/lib/finance/money";
import { IN_COLOR, OUT_COLOR, PLANNED_IN, PLANNED_OUT } from "./chart-colors";
import { monthLabel } from "@/lib/finance/dates";
import type { ForecastMonth } from "@/lib/finance/calc";

const axis = { fontSize: 11, fill: "#6b6178" };
const euros = (cents: number) => eur(cents, { round: true });
const tip = { contentStyle: { borderRadius: 8, border: "1px solid #ddd3f0", fontSize: 12 } };

export function ForecastChart({ months }: { months: ForecastMonth[] }) {
  const data = months.map((m) => ({
    label: monthLabel(m.month),
    "Entrées réalisées": m.inRealise,
    "Entrées prévues": m.inPrevu,
    "Entrées estimées": m.inEstime,
    "Sorties réalisées": m.outRealise,
    "Sorties prévues": m.outPrevu,
    "Sorties estimées": m.outEstime,
  }));
  return (
    <div className="h-72" role="img" aria-label="Prévision des entrées et sorties : réalisé, prévu, estimé">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={4}>
          <defs>
            <pattern id="hatch-in" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="#ffffff" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={IN_COLOR} strokeWidth="2" />
            </pattern>
            <pattern id="hatch-out" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
              <rect width="6" height="6" fill="#ffffff" />
              <line x1="0" y1="0" x2="0" y2="6" stroke={OUT_COLOR} strokeWidth="2" />
            </pattern>
          </defs>
          <CartesianGrid stroke="#eee8f6" vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={euros} tick={axis} tickLine={false} axisLine={false} width={72} />
          <Tooltip formatter={(v) => eur(Number(v))} cursor={{ fill: "#f7f5fa" }} {...tip} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar dataKey="Entrées réalisées" stackId="in" fill={IN_COLOR} maxBarSize={28} />
          <Bar dataKey="Entrées prévues" stackId="in" fill="#e9d7ff" stroke={IN_COLOR} strokeWidth={1.5} maxBarSize={28} />
          <Bar dataKey="Entrées estimées" stackId="in" fill="url(#hatch-in)" stroke={IN_COLOR} strokeDasharray="3 2" maxBarSize={28} />
          <Bar dataKey="Sorties réalisées" stackId="out" fill={OUT_COLOR} maxBarSize={28} />
          <Bar dataKey="Sorties prévues" stackId="out" fill="#fbe3cc" stroke={OUT_COLOR} strokeWidth={1.5} maxBarSize={28} />
          <Bar dataKey="Sorties estimées" stackId="out" fill="url(#hatch-out)" stroke={OUT_COLOR} strokeDasharray="3 2" maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accueil : grand graphique (Réel / Prévisions) et « À encaisser »
// ---------------------------------------------------------------------------


function HatchDefs() {
  return (
    <defs>
      <pattern id="h-in" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#ffffff" /><line x1="0" y1="0" x2="0" y2="6" stroke={IN_COLOR} strokeWidth="2" />
      </pattern>
      <pattern id="h-out" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(135)">
        <rect width="6" height="6" fill="#ffffff" /><line x1="0" y1="0" x2="0" y2="6" stroke={OUT_COLOR} strokeWidth="2" />
      </pattern>
    </defs>
  );
}

/** Réel : encaissements et charges payées par mois (barres groupées, montants au survol). */
export function RealChart({ series }: { series: { month: string; in: number; out: number }[] }) {
  const data = series.map((s) => ({ label: monthLabel(s.month), Encaissé: s.in, "Charges payées": s.out }));
  return (
    <div className="h-64 sm:h-72" role="img" aria-label="Encaissements et charges payées par mois">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barGap={3} barCategoryGap="22%">
          <CartesianGrid stroke="#eee8f6" vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tickFormatter={euros} tick={axis} tickLine={false} axisLine={false} width={64} />
          <Tooltip formatter={(v) => eur(Number(v))} cursor={{ fill: "#f7f5fa" }} {...tip} />
          <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
          <Bar dataKey="Encaissé" fill={IN_COLOR} radius={[4, 4, 0, 0]} maxBarSize={36} animationDuration={350} />
          <Bar dataKey="Charges payées" fill={OUT_COLOR} radius={[4, 4, 0, 0]} maxBarSize={36} animationDuration={350} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Prévisions : entrées et sorties attendues, du mois en cours aux mois suivants. Style distinct :
 * réel (plein), factures à encaisser et charges à payer (clair), prévisions (hachuré).
 */
export function PlanChart({ months }: { months: ForecastMonth[] }) {
  const data = months.map((m, i) => ({
    label: i === 0 ? "Ce mois" : monthLabel(m.month),
    "Déjà reçu": m.inRealise,
    "Factures à encaisser": m.inPrevu,
    "Revenus prévus": m.inEstime,
    "Déjà payé": m.outRealise,
    "Charges à payer": m.outPrevu,
    "Charges prévues": m.outEstime,
  }));
  return (
    <div className="h-64 sm:h-72" role="img" aria-label="Prévision des entrées et des sorties par mois">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barGap={3} barCategoryGap="22%">
          <HatchDefs />
          <CartesianGrid stroke="#eee8f6" vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={euros} tick={axis} tickLine={false} axisLine={false} width={64} />
          <Tooltip formatter={(v) => eur(Number(v))} cursor={{ fill: "#f7f5fa" }} {...tip} />
          <Bar dataKey="Déjà reçu" stackId="in" fill={IN_COLOR} maxBarSize={36} animationDuration={350} />
          <Bar dataKey="Factures à encaisser" stackId="in" fill={PLANNED_IN} stroke={IN_COLOR} strokeWidth={1} maxBarSize={36} animationDuration={350} />
          <Bar dataKey="Revenus prévus" stackId="in" fill="url(#h-in)" stroke={IN_COLOR} strokeDasharray="3 2" maxBarSize={36} animationDuration={350} />
          <Bar dataKey="Déjà payé" stackId="out" fill={OUT_COLOR} maxBarSize={36} animationDuration={350} />
          <Bar dataKey="Charges à payer" stackId="out" fill={PLANNED_OUT} stroke={OUT_COLOR} strokeWidth={1} maxBarSize={36} animationDuration={350} />
          <Bar dataKey="Charges prévues" stackId="out" fill="url(#h-out)" stroke={OUT_COLOR} strokeDasharray="3 2" maxBarSize={36} animationDuration={350} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** « À encaisser » : soldes des factures ouvertes par échéance ; un clic ouvre les factures concernées. */
export function AgingChart({ buckets, onOpen }: { buckets: { key: string; label: string; total: number; ids: string[] }[]; onOpen: (ids: string[]) => void }) {
  const data = buckets.map((b) => ({ ...b, Montant: b.total }));
  return (
    <div className="h-44" role="img" aria-label="Factures ouvertes par échéance">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 18, right: 4, bottom: 0, left: 0 }} barCategoryGap="28%">
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} interval={0} />
          <YAxis hide />
          <Tooltip formatter={(v) => eur(Number(v))} cursor={{ fill: "#f7f5fa" }} {...tip} />
          <Bar dataKey="Montant" radius={[4, 4, 0, 0]} maxBarSize={56} cursor="pointer" animationDuration={350}
            onClick={(d) => { const ids = (d as unknown as { ids?: string[] }).ids ?? (d as unknown as { payload?: { ids: string[] } }).payload?.ids; if (ids?.length) onOpen(ids); }}
            label={{ position: "top", fontSize: 11, fill: "#1a1128", formatter: (v: unknown) => (Number(v) ? euros(Number(v)) : "") }}>
            {data.map((d) => <Cell key={d.key} fill={d.key === "retard" ? "#b5386a" : IN_COLOR} fillOpacity={d.key === "sans" ? 0.45 : 1} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
