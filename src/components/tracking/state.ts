"use client";

// État de l'espace Tracking site : période, filtres et onglet vivent dans l'adresse (partageable, bouton retour),
// et s'appliquent à tous les onglets. Les lectures gardent leur rendu précédent pendant un rechargement.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { apiGet } from "@/lib/client/query";

export const TABS = [
  ["vue", "Vue d'ensemble"], ["sources", "Sources"], ["campagnes", "Campagnes"], ["pages", "Pages"],
  ["prospects", "Prospects"], ["seo", "SEO"], ["ia", "IA"], ["geo", "Géographie"],
] as const;
export type TabKey = (typeof TABS)[number][0];

export const PERIODS = [["7j", "7 jours", 7], ["30j", "30 jours", 30], ["90j", "90 jours", 90], ["12m", "12 mois", 365]] as const;
export type PeriodKey = (typeof PERIODS)[number][0] | "perso";

export const FILTER_KEYS = ["channel", "source", "campaign", "page", "country", "device"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string>>;

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00`) - Date.parse(`${a}T12:00:00`)) / 86_400_000);

export type TrackingState = {
  tab: TabKey; period: PeriodKey; from: string; to: string; filters: Filters;
  /** paramètres communs à toutes les lectures */
  query: string;
  set: (patch: Record<string, string | null | undefined>) => void;
  setFilter: (key: FilterKey, value: string | null | undefined) => void;
  goto: (tab: TabKey, patch?: Record<string, string | null | undefined>) => void;
};

export function useTracking(): TrackingState {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = sp.toString();
  return useMemo(() => {
    const p = new URLSearchParams(raw);
    const tab = (TABS.find(([k]) => k === p.get("onglet"))?.[0] ?? "vue") as TabKey;
    const today = iso(new Date());
    const custom = DAY.test(p.get("du") ?? "") && DAY.test(p.get("au") ?? "") && p.get("du")! <= p.get("au")!;
    const preset = PERIODS.find(([k]) => k === p.get("periode")) ?? PERIODS[1];
    const period: PeriodKey = custom ? "perso" : preset[0];
    let from = custom ? p.get("du")! : addDays(today, -(preset[2] - 1));
    const to = custom ? (p.get("au")! > today ? today : p.get("au")!) : today;
    if (daysBetween(from, to) > 399) from = addDays(to, -399);
    const filters: Filters = {};
    for (const k of FILTER_KEYS) { const v = p.get(k); if (v) filters[k] = v; }
    const q = new URLSearchParams({ from, to, ...filters }).toString();
    const set = (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(raw);
      for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
      const s = next.toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    };
    return {
      tab, period, from, to, filters, query: q, set,
      setFilter: (key, value) => set({ [key]: value || null, ...(key === "channel" ? { source: null } : {}) }),
      goto: (t, patch) => set({ onglet: t === "vue" ? null : t, ...patch }),
    };
  }, [raw, router, pathname]);
}

/** Lecture d'un rapport pour la période et les filtres en cours. `stale` : rendu précédent encore affiché. */
export function useReport<T>(name: string, state: TrackingState, extra: Record<string, string | undefined> = {}, enabled = true) {
  const more = Object.entries(extra).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v!)}`).join("");
  const url = `/api/tracking/${name}?${state.query}${more}`;
  const q = useQuery({ queryKey: ["tracking", url], queryFn: ({ signal }) => apiGet<T>(url, signal), placeholderData: keepPreviousData, staleTime: 60_000, enabled });
  return { data: q.data, loading: q.isPending && enabled, stale: q.isPlaceholderData, error: q.isError ? (q.error as Error).message : null, refetch: q.refetch };
}

// --- formats ---
const nf = new Intl.NumberFormat("fr-FR");
const compact = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
export const num = (n: number | null | undefined) => nf.format(Math.round(Number(n ?? 0)));
export const short = (n: number | null | undefined) => (Math.abs(Number(n ?? 0)) >= 10_000 ? compact.format(Number(n)) : num(n));
export const percent = (n: number | null | undefined, digits = 1) => `${Number(n ?? 0).toLocaleString("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
export const rate = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0);
export function seconds(s: number | null | undefined): string {
  const v = Math.round(Number(s ?? 0));
  if (v < 60) return `${v} s`;
  return `${Math.floor(v / 60)} min ${String(v % 60).padStart(2, "0")}`;
}
const dShort = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const dLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const dMonth = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit" });
export const dayShort = (d: string) => dShort.format(new Date(`${d}T12:00:00`));
export const dayLong = (d: string) => dLong.format(new Date(`${d}T12:00:00`));
export const monthShort = (d: string) => dMonth.format(new Date(`${d}T12:00:00`));
/** Libellé d'un point de courbe : le jour, ou la semaine qui commence ce jour-là. */
export const bucketLabel = (d: string, bucket: string) => (bucket === "week" ? `Semaine du ${dayShort(d)} au ${dayShort(addDays(d, 6))}` : dayLong(d));

let regions: Intl.DisplayNames | null = null;
export function countryName(code: string | null | undefined): string {
  if (!code || code === "??") return "Pays inconnu";
  try {
    regions ??= new Intl.DisplayNames(["fr"], { type: "region" });
    return regions.of(code) ?? code;
  } catch {
    return code;
  }
}
export const DEVICE_LABEL: Record<string, string> = { desktop: "Ordinateur", mobile: "Mobile", tablet: "Tablette" };
