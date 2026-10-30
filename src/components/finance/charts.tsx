"use client";

// Graphiques Finance (recharts). Deux couleurs validées pour les daltonismes (violet / orange),
// toujours accompagnées d'une légende textuelle et d'une vue tableau.
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { eur } from "@/lib/finance/money";
import { monthLabel } from "@/lib/finance/dates";
import type { ForecastMonth } from "@/lib/finance/calc";

export const IN_COLOR = "#682dfe";
export const OUT_COLOR = "#c2620a";
const axis = { fontSize: 11, fill: "#6b6178" };
const euros = (cents: number) => eur(cents, { round: true });
const tip = { contentStyle: { borderRadius: 8, border: "1px solid #ddd3f0", fontSize: 12 } };

export function CashChart({ series }: { series: { month: string; in: number; out: number }[] }) {
  const data = series.map((s) => ({ label: monthLabel(s.month), Encaissements: s.in, Décaissements: s.out }));
  return (
    <div className="h-64" role="img" aria-label="Encaissements et décaissements réels par mois">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#eee8f6" vertical={false} />
          <XAxis dataKey="label" tick={axis} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={euros} tick={axis} tickLine={false} axisLine={false} width={72} />
          <Tooltip formatter={(v) => eur(Number(v))} {...tip} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="Encaissements" stroke={IN_COLOR} strokeWidth={2} dot={{ r: 4 }} activeDot={{ r: 6 }} />
          <Line type="monotone" dataKey="Décaissements" stroke={OUT_COLOR} strokeWidth={2} strokeDasharray="6 3" dot={{ r: 4, strokeWidth: 2 }} activeDot={{ r: 6 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CategoryChart({ rows }: { rows: { name: string; cents: number }[] }) {
  const data = rows.map((r) => ({ name: r.name, Montant: r.cents }));
  return (
    <div style={{ height: Math.max(120, data.length * 34 + 20) }} role="img" aria-label="Charges payées par catégorie">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap={6}>
          <XAxis type="number" tickFormatter={euros} tick={axis} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey="name" tick={axis} tickLine={false} axisLine={false} width={150} />
          <Tooltip formatter={(v) => eur(Number(v))} cursor={{ fill: "#f7f5fa" }} {...tip} />
          <Bar dataKey="Montant" fill={OUT_COLOR} radius={[0, 4, 4, 0]} maxBarSize={18} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

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
