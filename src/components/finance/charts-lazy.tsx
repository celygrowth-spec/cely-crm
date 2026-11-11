"use client";

// Graphiques Finance chargés à la demande : recharts (≈ 100 kB gzip) ne fait plus partie du JavaScript
// initial des pages Finance. Chaque graphique garde sa hauteur pendant le chargement (pas de saut de page).
import dynamic from "next/dynamic";
import { IN_COLOR, OUT_COLOR, PLANNED_IN, PLANNED_OUT } from "./chart-colors";

const placeholder = (height: string) => {
  function ChartPlaceholder() {
    return <div className={`${height} animate-pulse rounded-lg bg-surface`} aria-hidden />;
  }
  return ChartPlaceholder;
};

export const RealChart = dynamic(() => import("./charts").then((m) => m.RealChart), { ssr: false, loading: placeholder("h-64 sm:h-72") });
export const PlanChart = dynamic(() => import("./charts").then((m) => m.PlanChart), { ssr: false, loading: placeholder("h-64 sm:h-72") });
export const AgingChart = dynamic(() => import("./charts").then((m) => m.AgingChart), { ssr: false, loading: placeholder("h-44") });
export const ForecastChart = dynamic(() => import("./charts").then((m) => m.ForecastChart), { ssr: false, loading: placeholder("h-72") });

/** Légende des prévisions, en texte (lisible sur mobile, sans dépendre des couleurs seules). */
export function PlanLegend() {
  const sw = (style: React.CSSProperties) => <span className="inline-block size-3 shrink-0 rounded-sm" style={style} aria-hidden />;
  const hatch = (c: string) => ({ background: `repeating-linear-gradient(45deg, ${c} 0 2px, #fff 2px 5px)`, border: `1px dashed ${c}` });
  return (
    <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted sm:flex sm:flex-wrap">
      <li className="flex items-center gap-1.5">{sw({ background: IN_COLOR })} Déjà reçu</li>
      <li className="flex items-center gap-1.5">{sw({ background: PLANNED_IN, border: `1px solid ${IN_COLOR}` })} Factures à encaisser</li>
      <li className="flex items-center gap-1.5">{sw(hatch(IN_COLOR))} Revenus prévus</li>
      <li className="flex items-center gap-1.5">{sw({ background: OUT_COLOR })} Déjà payé</li>
      <li className="flex items-center gap-1.5">{sw({ background: PLANNED_OUT, border: `1px solid ${OUT_COLOR}` })} Charges à payer</li>
      <li className="flex items-center gap-1.5">{sw(hatch(OUT_COLOR))} Charges prévues</li>
    </ul>
  );
}

