"use client";

// Carte du monde colorée par nombre de visites (SVG en ligne). Le tracé des pays (~112 ko) est chargé à la
// demande, jamais avec le JavaScript initial. Cinq classes sur une échelle logarithmique : un pays dominant
// n'écrase pas les autres. Chaque pays est un bouton (clic ou Entrée : filtre), avec info-bulle au survol et au focus.
import { useEffect, useRef, useState } from "react";
import { countryName, num } from "./state";

export type CountryStat = { country: string; visits: number; visitors: number; bookings: number };
type World = { width: number; height: number; paths: Record<string, string> };

/** Bornes hautes des classes (entiers croissants, cinq au plus) : progression géométrique jusqu'au maximum. */
function classBreaks(max: number): number[] {
  if (max <= 0) return [];
  const out: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const b = i === 5 ? max : Math.max(1, Math.round(Math.pow(max, i / 5)));
    if (b > (out[out.length - 1] ?? 0)) out.push(b);
  }
  return out;
}
/** Teinte d'une classe : avec moins de cinq classes, on garde le haut de la rampe (plus lisible sur la carte). */
const rampVar = (index: number, count: number) => `var(--trk-seq-${5 - (count - 1 - index)})`;

type Tip = { code: string; x: number; y: number; width: number };

export function WorldMap({ countries, active, onPick }: { countries: CountryStat[]; active?: string | null; onPick: (code: string) => void }) {
  const [world, setWorld] = useState<World | null>(null);
  const [failed, setFailed] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    import("./world.json").then((m) => { if (alive) setWorld(m.default as World); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);

  if (failed) return <p className="py-10 text-center text-sm text-muted">La carte n&apos;a pas pu être chargée. La liste des pays reste disponible.</p>;
  // même proportion que la carte : pas de saut de page à l'arrivée du tracé
  if (!world) return <div className="skeleton w-full rounded-xl" style={{ aspectRatio: "960 / 470" }} aria-hidden />;

  const stats = new Map(countries.map((c) => [c.country, c]));
  const max = Math.max(0, ...countries.filter((c) => c.country in world.paths).map((c) => c.visits));
  const breaks = classBreaks(max);
  const fill = (code: string) => {
    const v = stats.get(code)?.visits ?? 0;
    if (v <= 0) return "var(--trk-seq-0)";
    const i = breaks.findIndex((b) => v <= b);
    return rampVar(i < 0 ? breaks.length - 1 : i, breaks.length);
  };
  const place = (code: string, clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    if (r) setTip({ code, x: clientX - r.left, y: clientY - r.top, width: r.width });
  };
  const codes = Object.keys(world.paths);
  // le pays actif est dessiné en dernier : son contour passe au-dessus des voisins
  const ordered = active && codes.includes(active) ? [...codes.filter((c) => c !== active), active] : codes;
  const tipStat = tip ? stats.get(tip.code) : null;

  return (
    <div>
      <div ref={box} className="relative">
        <svg viewBox={`0 0 ${world.width} ${world.height}`} className="block h-auto w-full" role="group" aria-label="Carte des visites par pays" onPointerLeave={() => setTip(null)}>
          {ordered.map((code) => {
            const st = stats.get(code);
            const on = active === code;
            return (
              <path key={code} d={world.paths[code]} fill={fill(code)} className="trk-country" tabIndex={0} role="button" aria-pressed={on}
                aria-label={`${countryName(code)} : ${num(st?.visits ?? 0)} ${(st?.visits ?? 0) > 1 ? "visites" : "visite"}`}
                style={on ? { stroke: "var(--ink)", strokeWidth: 1.2 } : undefined}
                onPointerMove={(e) => place(code, e.clientX, e.clientY)}
                onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); place(code, r.left + r.width / 2, r.top + r.height / 2); }}
                onBlur={() => setTip(null)}
                onClick={() => onPick(code)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(code); } }} />
            );
          })}
        </svg>
        {tip && (
          <div className="trk-card pointer-events-none absolute z-10 w-max max-w-56 px-3 py-2 text-xs" role="status"
            style={{
              left: Math.min(Math.max(tip.x, 90), Math.max(tip.width - 90, 90)), top: tip.y,
              transform: `translate(-50%, ${tip.y < 96 ? "14px" : "calc(-100% - 12px)"})`, boxShadow: "0 10px 30px -10px rgb(0 0 0 / 0.35)",
            }}>
            <p className="mb-1 font-semibold text-ink">{countryName(tip.code)}</p>
            {tipStat ? (
              <ul className="grid gap-0.5">
                {([["Visites", tipStat.visits], ["Visiteurs", tipStat.visitors], ["Rendez-vous", tipStat.bookings]] as const).map(([label, value]) => (
                  <li key={label} className="flex justify-between gap-4"><span className="text-muted">{label}</span><strong className="tabular-nums text-ink">{num(value)}</strong></li>
                ))}
              </ul>
            ) : <p className="text-muted">Aucune visite sur la période</p>}
            <p className="mt-1.5 border-t border-line pt-1 text-[11px] text-muted">{active === tip.code ? "Cliquer pour retirer le filtre" : "Cliquer pour filtrer sur ce pays"}</p>
          </div>
        )}
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs" aria-label="Échelle : visites par pays">
        <li className="inline-flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-sm" style={{ background: "var(--trk-seq-0)" }} aria-hidden /><span className="text-muted">Aucune visite</span></li>
        {breaks.map((b, i) => {
          const low = (breaks[i - 1] ?? 0) + 1;
          return (
            <li key={b} className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm" style={{ background: rampVar(i, breaks.length) }} aria-hidden />
              <span className="tabular-nums text-ink">{low === b ? num(b) : `${num(low)} – ${num(b)}`}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
