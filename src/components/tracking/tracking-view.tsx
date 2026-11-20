"use client";

// Espace Tracking site. En haut, en permanence : la période (avec comparaison automatique à la période précédente
// de même durée) et les filtres, qui s'appliquent à tous les onglets. Chaque onglet charge ses agrégats à la demande.
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarRange, X } from "lucide-react";
import { cn } from "@/components/ui";
import { apiGet } from "@/lib/client/query";
import { CHANNEL_ORDER, channelLabel, sourceName } from "@/lib/tracking/channels";
import { DEVICE_LABEL, FILTER_KEYS, PERIODS, TABS, countryName, dayShort, daysBetween, addDays, useTracking, type FilterKey, type TrackingState } from "./state";
import type { Live, Options } from "./types";
import { OverviewTab } from "./tab-overview";
import { SourcesTab } from "./tab-sources";
import { CampaignsTab } from "./tab-campaigns";
import { PagesTab } from "./tab-pages";
import { ProspectsTab } from "./tab-prospects";
import { SeoTab } from "./tab-seo";
import { AiTab } from "./tab-ai";
import { GeoTab } from "./tab-geo";
import "./tracking.css";

function LiveBadge() {
  const { data } = useQuery({ queryKey: ["tracking", "live"], queryFn: () => apiGet<Live>("/api/tracking/live"), refetchInterval: 30_000, staleTime: 20_000 });
  const n = data?.visitors ?? 0;
  const pages = data?.pages ?? [];
  return (
    <div className="trk-card flex items-center gap-2.5 px-3 py-2" title={pages.length ? pages.map((p) => `${p.path} (${p.n})`).join("\n") : "Aucun visiteur ces 5 dernières minutes"} data-live>
      <span className={cn("size-2.5 rounded-full", n > 0 ? "trk-live bg-success" : "bg-line")} aria-hidden />
      <span className="text-sm"><strong className="tabular-nums text-ink">{n}</strong> <span className="text-muted">en direct</span></span>
      <span className="hidden text-xs text-muted sm:inline">· 5 dernières minutes</span>
    </div>
  );
}

function PeriodPicker({ s }: { s: TrackingState }) {
  const [custom, setCustom] = useState(s.period === "perso");
  const [from, setFrom] = useState(s.from);
  const [to, setTo] = useState(s.to);
  const len = daysBetween(s.from, s.to) + 1;
  const prevTo = addDays(s.from, -1), prevFrom = addDays(s.from, -len);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="trk-card flex max-w-full items-center gap-0.5 overflow-x-auto p-0.5" role="group" aria-label="Période">
        {PERIODS.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={s.period === key}
            onClick={() => { setCustom(false); s.set({ periode: key === "30j" ? null : key, du: null, au: null }); }}
            className={cn("rounded-[13px] px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap transition-colors", s.period === key ? "bg-ink text-[var(--background)]" : "text-muted hover:text-ink")}>
            {label}
          </button>
        ))}
        <button type="button" aria-pressed={s.period === "perso"} aria-expanded={custom} onClick={() => setCustom(!custom)}
          className={cn("inline-flex items-center gap-1.5 rounded-[13px] px-3 py-1.5 text-[13px] font-semibold whitespace-nowrap transition-colors", s.period === "perso" ? "bg-ink text-[var(--background)]" : "text-muted hover:text-ink")}>
          <CalendarRange size={14} aria-hidden /> {s.period === "perso" ? `${dayShort(s.from)} – ${dayShort(s.to)}` : "Dates"}
        </button>
      </div>
      {custom && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (from && to && from <= to) s.set({ du: from, au: to, periode: null }); }}>
          <input type="date" aria-label="Du" className="trk-field" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required />
          <span className="text-muted">au</span>
          <input type="date" aria-label="Au" className="trk-field" value={to} min={from} onChange={(e) => setTo(e.target.value)} required />
          <button type="submit" className="h-9 rounded-[10px] bg-violet-strong px-3 text-[13px] font-semibold text-white dark:text-[#120e1f]">Appliquer</button>
        </form>
      )}
      <p className="text-xs text-muted">comparé à la période précédente ({dayShort(prevFrom)} – {dayShort(prevTo)})</p>
    </div>
  );
}

const FILTER_LABEL: Record<FilterKey, string> = { channel: "Source", source: "Détail", campaign: "Campagne", page: "Page", country: "Pays", device: "Appareil" };
const filterValue = (k: FilterKey, v: string) => (k === "source" ? sourceName(v) ?? v : k === "channel" ? channelLabel(v) : k === "country" ? countryName(v) : k === "device" ? DEVICE_LABEL[v] ?? v : v);

function FilterBar({ s }: { s: TrackingState }) {
  const { data } = useQuery({ queryKey: ["tracking", "options"], queryFn: () => apiGet<Options>("/api/tracking/options"), staleTime: 5 * 60_000 });
  const select = (key: FilterKey, placeholder: string, options: [string, string][]) => (
    <select aria-label={`Filtrer par ${FILTER_LABEL[key].toLowerCase()}`} className={cn("trk-field max-w-44", s.filters[key] && "border-violet")}
      value={s.filters[key] ?? ""} onChange={(e) => s.setFilter(key, e.target.value)}>
      <option value="">{placeholder}</option>
      {/* une valeur choisie depuis un graphique reste sélectionnable même si elle n'est pas dans la liste */}
      {s.filters[key] && !options.some(([v]) => v === s.filters[key]) && <option value={s.filters[key]}>{filterValue(key, s.filters[key]!)}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
  const active = FILTER_KEYS.filter((k) => s.filters[k]);
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-0.5 sm:flex-wrap sm:overflow-visible [&>*]:shrink-0" data-filters>
      {select("channel", "Toutes les sources", CHANNEL_ORDER.map((c) => [c, channelLabel(c)]))}
      {select("campaign", "Toutes les campagnes", (data?.campaigns ?? []).map((c) => [c, c]))}
      {select("page", "Toutes les pages", (data?.pages ?? []).map((p) => [p, p]))}
      {select("country", "Tous les pays", (data?.countries ?? []).map((c) => [c, countryName(c)]))}
      {select("device", "Tous les appareils", Object.entries(DEVICE_LABEL))}
      {active.map((k) => (
        <button key={k} type="button" onClick={() => s.setFilter(k, null)}
          className="inline-flex h-7 items-center gap-1 rounded-full border border-violet-line bg-violet-soft px-2.5 text-xs font-semibold text-ink hover:border-violet" title="Retirer ce filtre">
          <span className="text-muted">{FILTER_LABEL[k]} :</span> <span className="max-w-40 truncate">{filterValue(k, s.filters[k]!)}</span> <X size={12} aria-hidden />
        </button>
      ))}
      {active.length > 1 && (
        <button type="button" onClick={() => s.set(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))} className="text-xs font-semibold text-violet-strong hover:underline">Tout effacer</button>
      )}
    </div>
  );
}

export function TrackingView() {
  const s = useTracking();
  const panels: Record<string, ReactNode> = {
    vue: <OverviewTab s={s} />, sources: <SourcesTab s={s} />, campagnes: <CampaignsTab s={s} />, pages: <PagesTab s={s} />,
    prospects: <ProspectsTab s={s} />, seo: <SeoTab s={s} />, ia: <AiTab s={s} />, geo: <GeoTab s={s} />,
  };
  return (
    <div className="trk -mx-4 -mt-5 -mb-36 min-h-dvh px-4 pt-5 pb-36 md:-mx-8 md:-mt-7 md:-mb-24 md:px-8 md:pt-7 md:pb-24" data-tracking>
      <div className="mx-auto max-w-[1320px]">
        <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-extrabold tracking-tight text-ink">Tracking site</h1>
            <p className="mt-1 text-sm text-muted">D&apos;où viennent les visiteurs de celygrowth.com, et lesquels prennent rendez-vous.</p>
          </div>
          <LiveBadge />
        </header>
        <div className="sticky top-12 z-10 -mx-4 mb-4 grid grid-cols-[minmax(0,1fr)] gap-2.5 border-b border-line bg-[color-mix(in_srgb,var(--background)_92%,transparent)] px-4 py-2.5 backdrop-blur md:top-0 md:-mx-8 md:px-8">
          <PeriodPicker s={s} />
          <FilterBar s={s} />
        </div>
        <nav className="mb-5 flex gap-1 overflow-x-auto border-b border-line" aria-label="Onglets de Tracking site" role="tablist">
          {TABS.map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={s.tab === key} onClick={() => s.goto(key)}
              className={cn("-mb-px border-b-2 px-3 py-2 font-label text-sm font-semibold whitespace-nowrap transition-colors", s.tab === key ? "border-violet text-ink" : "border-transparent text-muted hover:text-ink")}>
              {label}
            </button>
          ))}
        </nav>
        <div role="tabpanel" aria-label={TABS.find(([k]) => k === s.tab)?.[1]} key={s.tab} className="fade-in">{panels[s.tab]}</div>
      </div>
    </div>
  );
}
