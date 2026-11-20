"use client";

// Graphiques chargés à la demande : recharts ne fait pas partie du JavaScript initial. Chaque graphique garde
// sa hauteur pendant le chargement (pas de saut de page).
import dynamic from "next/dynamic";

const placeholder = (height: string) => {
  function ChartPlaceholder() {
    return <div className={`${height} skeleton rounded-xl`} aria-hidden />;
  }
  return ChartPlaceholder;
};

export const StackedArea = dynamic(() => import("./charts").then((m) => m.StackedArea), { ssr: false, loading: placeholder("h-72") });
export const Lines = dynamic(() => import("./charts").then((m) => m.Lines), { ssr: false, loading: placeholder("h-64") });
export const Sparkline = dynamic(() => import("./charts").then((m) => m.Sparkline), { ssr: false, loading: placeholder("h-10") });
export type { Point, Series } from "./charts";
