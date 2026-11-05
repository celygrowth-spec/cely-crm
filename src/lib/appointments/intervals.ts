// Opérations sur des intervalles [début, fin) en ISO.
import type { Interval } from "./types";

const ms = (s: string) => Date.parse(s);

/** Fusionne des intervalles qui se chevauchent ou se touchent. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((i) => ms(i.end) > ms(i.start))
    .map((i) => ({ s: ms(i.start), e: ms(i.end) }))
    .sort((a, b) => a.s - b.s);
  const out: { s: number; e: number }[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.s <= last.e) last.e = Math.max(last.e, i.e);
    else out.push({ ...i });
  }
  return out.map((i) => ({ start: new Date(i.s).toISOString(), end: new Date(i.e).toISOString() }));
}

/**
 * Occupations Google privées de nos propres rendez-vous : ils y figurent aussi (événements créés par
 * l'outil) et sont déjà pris en compte en base, battements compris. Sans cette soustraction, un report
 * vers un créneau proche de l'ancien serait refusé à tort.
 */
export function subtractIntervals(busy: Interval[], own: Interval[]): Interval[] {
  const holes = mergeIntervals(own).map((i) => ({ s: ms(i.start), e: ms(i.end) }));
  const out: Interval[] = [];
  for (const b of mergeIntervals(busy)) {
    let pieces = [{ s: ms(b.start), e: ms(b.end) }];
    for (const h of holes) {
      pieces = pieces.flatMap((p) => {
        if (h.e <= p.s || h.s >= p.e) return [p];
        const r: { s: number; e: number }[] = [];
        if (h.s > p.s) r.push({ s: p.s, e: h.s });
        if (h.e < p.e) r.push({ s: h.e, e: p.e });
        return r;
      });
    }
    for (const p of pieces) out.push({ start: new Date(p.s).toISOString(), end: new Date(p.e).toISOString() });
  }
  return out;
}
