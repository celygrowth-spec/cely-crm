"use client";

// Choix d'une date puis d'un créneau, dans le fuseau du visiteur.
// Desktop : calendrier et créneaux côte à côte. Mobile : deux étapes (date, puis créneau).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Globe, RefreshCw } from "lucide-react";
import { cn } from "@/components/ui";
import {
  COMMON_TIME_ZONES, addMonthsKey, dayKey, formatLongDate, formatTimeShort, monthGrid, monthLabel, timeZoneLabel, zonedToUtc,
} from "@/lib/appointments/time";

type MonthState = { status: "loading" } | { status: "ok"; slots: string[] } | { status: "error"; message: string };

const WEEKDAYS = ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."];

export function TimeZoneSelect({ value, onChange, id }: { value: string; onChange: (tz: string) => void; id?: string }) {
  const zones = useMemo(() => (COMMON_TIME_ZONES.includes(value) ? COMMON_TIME_ZONES : [value, ...COMMON_TIME_ZONES]), [value]);
  return (
    <label className="flex items-center gap-2 text-xs text-muted" htmlFor={id}>
      <Globe size={14} aria-hidden />
      <span className="sr-only">Fuseau horaire</span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 flex-1 truncate rounded-md border border-transparent bg-transparent py-1 pr-6 text-xs font-semibold text-ink hover:border-line focus:border-violet focus:outline-none"
      >
        {zones.map((z) => (
          <option key={z} value={z}>
            {timeZoneLabel(z)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SlotPicker({
  slug,
  tz,
  onTzChange,
  horizonDays,
  selected,
  onSelect,
  manageRef,
  confirmLabel = "Continuer",
}: {
  slug: string;
  tz: string;
  onTzChange: (tz: string) => void;
  horizonDays: number;
  selected: string | null;
  onSelect: (slot: string) => void;
  manageRef?: string;
  confirmLabel?: string;
}) {
  const todayKey = dayKey(new Date(), tz);
  const currentMonth = todayKey.slice(0, 7);
  const lastMonth = dayKey(new Date(Date.now() + horizonDays * 86400_000), tz).slice(0, 7);
  const [month, setMonth] = useState(() => (selected ? dayKey(selected, tz).slice(0, 7) : currentMonth));
  const [day, setDay] = useState<string | null>(() => (selected ? dayKey(selected, tz) : null));
  const [pending, setPending] = useState<string | null>(selected);
  const [mobileView, setMobileView] = useState<"calendar" | "slots">(selected ? "slots" : "calendar");
  const [cache, setCache] = useState<Record<string, MonthState>>({});
  const autoAdvanced = useRef(false);
  const key = `${month}|${tz}`;
  const state = cache[key];

  const load = useCallback(
    async (m: string, zone: string, signal?: AbortSignal) => {
      const k = `${m}|${zone}`;
      setCache((c) => ({ ...c, [k]: { status: "loading" } }));
      const from = zonedToUtc(`${m}-01`, "00:00", zone).toISOString();
      const to = zonedToUtc(`${addMonthsKey(m, 1)}-01`, "00:00", zone).toISOString();
      const q = new URLSearchParams({ from, to });
      if (manageRef) q.set("ref", manageRef);
      try {
        const res = await fetch(`/api/rdv/${encodeURIComponent(slug)}/slots?${q.toString()}`, { signal, cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { slots?: string[]; error?: string } | null;
        if (!res.ok || !body?.slots) throw new Error(body?.error ?? "Les créneaux n'ont pas pu être chargés.");
        setCache((c) => ({ ...c, [k]: { status: "ok", slots: body.slots! } }));
      } catch (e) {
        if (signal?.aborted) return;
        setCache((c) => ({ ...c, [k]: { status: "error", message: e instanceof Error ? e.message : "Erreur de chargement" } }));
      }
    },
    [slug, manageRef],
  );

  useEffect(() => {
    if (cache[key]) return;
    const ctrl = new AbortController();
    void load(month, tz, ctrl.signal);
    return () => ctrl.abort();
  }, [key, month, tz, load, cache]);

  // mois en cours sans disponibilité : on montre directement le suivant (une seule fois)
  useEffect(() => {
    if (autoAdvanced.current || state?.status !== "ok" || month !== currentMonth || selected) return;
    autoAdvanced.current = true;
    if (state.slots.length === 0 && month < lastMonth) setMonth(addMonthsKey(month, 1));
  }, [state, month, currentMonth, lastMonth, selected]);

  const byDay = useMemo(() => {
    const map = new Map<string, string[]>();
    if (state?.status === "ok") for (const s of state.slots) map.set(dayKey(s, tz), [...(map.get(dayKey(s, tz)) ?? []), s]);
    return map;
  }, [state, tz]);

  const daySlots = day ? (byDay.get(day) ?? []) : [];
  const grid = monthGrid(month);

  function pickDay(d: string) {
    setDay(d);
    setPending(null);
    setMobileView("slots");
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_220px]">
      <div className={cn(mobileView === "slots" && "hidden md:block")}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-display text-base font-bold text-ink" aria-live="polite">{monthLabel(month)}</h3>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setMonth(addMonthsKey(month, -1))}
              disabled={month <= currentMonth}
              className="rounded-full p-2 text-ink hover:bg-violet-soft disabled:opacity-30"
              aria-label="Mois précédent"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={() => setMonth(addMonthsKey(month, 1))}
              disabled={month >= lastMonth}
              className="rounded-full p-2 text-ink hover:bg-violet-soft disabled:opacity-30"
              aria-label="Mois suivant"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center" role="grid" aria-label={`Dates disponibles, ${monthLabel(month)}`}>
          {WEEKDAYS.map((w) => (
            <div key={w} className="pb-1 font-label text-[11px] font-semibold text-muted uppercase" role="columnheader">
              {w}
            </div>
          ))}
          {grid.map((d, i) => {
            if (!d) return <div key={`e${i}`} />;
            const available = byDay.has(d);
            const isSel = d === day;
            return (
              <button
                key={d}
                type="button"
                disabled={!available}
                onClick={() => pickDay(d)}
                aria-pressed={isSel}
                aria-label={`${formatLongDate(`${d}T12:00:00Z`, "UTC")}${available ? "" : ", aucun créneau"}`}
                className={cn(
                  "relative mx-auto flex aspect-square w-full max-w-11 items-center justify-center rounded-full text-sm font-semibold transition-colors",
                  available ? "bg-violet-soft text-violet-strong hover:bg-violet hover:text-white" : "text-muted/50",
                  isSel && "bg-ink text-white hover:bg-ink",
                )}
              >
                {Number(d.slice(8))}
                {d === todayKey && <span className={cn("absolute bottom-1 size-1 rounded-full", isSel ? "bg-white" : "bg-violet-strong")} aria-hidden />}
              </button>
            );
          })}
        </div>
        <div className="mt-3 min-h-6 text-sm">
          {state?.status === "loading" && <p className="text-muted">Recherche des disponibilités…</p>}
          {state?.status === "ok" && byDay.size === 0 && <p className="text-muted">Aucun créneau disponible ce mois-ci.</p>}
          {state?.status === "error" && (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-danger">
              <span className="flex-1">{state.message}</span>
              <button type="button" onClick={() => load(month, tz)} className="inline-flex items-center gap-1 font-semibold underline">
                <RefreshCw size={13} /> Réessayer
              </button>
            </div>
          )}
        </div>
        <div className="mt-2 border-t border-line pt-2">
          <TimeZoneSelect value={tz} onChange={onTzChange} id="rdv-tz" />
        </div>
      </div>

      <div className={cn(mobileView === "calendar" && "hidden md:block")}>
        <button type="button" onClick={() => setMobileView("calendar")} className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-violet-strong md:hidden">
          <ChevronLeft size={16} /> Changer de date
        </button>
        {day ? (
          <>
            <p className="mb-3 text-sm font-semibold text-ink">{formatLongDate(`${day}T12:00:00Z`, "UTC").replace(/ \d{4}$/, "")}</p>
            <ul className="flex max-h-[420px] flex-col gap-2 overflow-y-auto pr-1" aria-label="Créneaux disponibles">
              {daySlots.map((s) => (
                <li key={s} className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPending(s)}
                    aria-pressed={pending === s}
                    className={cn(
                      "h-11 flex-1 rounded-lg border text-sm font-semibold transition-all",
                      pending === s ? "border-ink bg-ink text-white" : "border-violet-line text-violet-strong hover:border-violet hover:bg-violet-soft",
                    )}
                  >
                    {formatTimeShort(s, tz)}
                  </button>
                  {pending === s && (
                    <button type="button" onClick={() => onSelect(s)} className="pop-in h-11 flex-1 rounded-lg bg-violet-strong text-sm font-semibold text-white hover:bg-violet">
                      {confirmLabel}
                    </button>
                  )}
                </li>
              ))}
              {daySlots.length === 0 && <li className="text-sm text-muted">Plus de créneau ce jour-là.</li>}
            </ul>
          </>
        ) : (
          <p className="hidden text-sm text-muted md:block">Choisissez une date pour voir les horaires.</p>
        )}
      </div>
    </div>
  );
}
