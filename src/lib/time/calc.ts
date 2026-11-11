// Suivi du temps : périodes et totaux, en Europe/Paris. Sans effet de bord (testable).
// Une session compte, dans une période, uniquement pour sa partie comprise dans cette période :
// une session qui traverse minuit est répartie entre les deux jours.
import { addDaysKey, dayKey, isoWeekday, zonedToUtc } from "@/lib/appointments/time";

export const TZ = "Europe/Paris";

export type TimeEntry = {
  id: string;
  company_id: string;
  company_name: string;
  label: string | null;
  started_at: string;
  ended_at: string | null;
  source: "timer" | "manual";
  /** projet facultatif de la même fiche (K09) */
  project_id?: string | null;
  project_name?: string | null;
  /** fin corrigée après un chrono oublié (Q09) */
  corrected_at?: string | null;
};

export type PeriodKind = "jour" | "semaine" | "mois" | "perso";
/** Période en jours locaux inclus [from, to], et ses bornes en instants [start, end). */
export type Period = { kind: PeriodKind; from: string; to: string; start: number; end: number; label: string };

const startOfDay = (day: string) => zonedToUtc(day, "00:00", TZ).getTime();
const fmtDay = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtMonth = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });
const short = (d: string) => fmtDay.format(new Date(`${d}T12:00:00Z`));
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export function periodOf(kind: string | undefined, today: string, from?: string, to?: string): Period {
  const valid = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  let k: PeriodKind = kind === "jour" || kind === "mois" || kind === "perso" ? kind : "semaine";
  let f = today;
  let t = today;
  if (k === "perso") {
    if (valid(from) && valid(to) && from! <= to! && Date.parse(to!) - Date.parse(from!) <= 366 * 864e5) [f, t] = [from!, to!];
    else k = "semaine";
  }
  if (k === "semaine") {
    f = addDaysKey(today, 1 - isoWeekday(today)); // lundi
    t = addDaysKey(f, 6);
  } else if (k === "mois") {
    f = `${today.slice(0, 7)}-01`;
    const [y, m] = today.split("-").map(Number);
    t = `${today.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  }
  const label = k === "jour" ? "Aujourd'hui" : k === "semaine" ? `Semaine du ${short(f)} au ${short(t)}` : k === "mois" ? cap(fmtMonth.format(new Date(`${f}T12:00:00Z`))) : `Du ${short(f)} au ${short(t)}`;
  return { kind: k, from: f, to: t, start: startOfDay(f), end: startOfDay(addDaysKey(t, 1)), label };
}

/** Durée (ms) d'une session comprise dans [start, end). Une session en cours compte jusqu'à `now`. */
export function overlap(e: Pick<TimeEntry, "started_at" | "ended_at">, start: number, end: number, now: number): number {
  const s = Date.parse(e.started_at);
  const f = e.ended_at ? Date.parse(e.ended_at) : now;
  return Math.max(0, Math.min(f, end) - Math.max(s, start));
}

export const duration = (e: Pick<TimeEntry, "started_at" | "ended_at">, now = Date.now()) => (e.ended_at ? Date.parse(e.ended_at) : now) - Date.parse(e.started_at);

/** Répartition d'une session par jour local (minuit Europe/Paris). */
export function splitByDay(e: Pick<TimeEntry, "started_at" | "ended_at">, now = Date.now()): { day: string; ms: number }[] {
  const s = Date.parse(e.started_at);
  const f = e.ended_at ? Date.parse(e.ended_at) : now;
  const out: { day: string; ms: number }[] = [];
  for (let day = dayKey(new Date(s), TZ); out.length < 400; day = addDaysKey(day, 1)) {
    const a = startOfDay(day);
    const b = startOfDay(addDaysKey(day, 1));
    if (a >= f) break;
    const ms = Math.min(f, b) - Math.max(s, a);
    if (ms > 0) out.push({ day, ms });
  }
  return out;
}

export type ClientTotal = { company_id: string; company_name: string; ms: number; sessions: number };

/** Totaux par client des sessions ENREGISTRÉES (le chrono en cours est affiché à part). */
export function totalsByClient(entries: TimeEntry[], p: Period): { total: number; rows: ClientTotal[] } {
  const map = new Map<string, ClientTotal>();
  for (const e of entries) {
    if (!e.ended_at) continue;
    const ms = overlap(e, p.start, p.end, 0);
    if (ms <= 0) continue;
    const row = map.get(e.company_id) ?? { company_id: e.company_id, company_name: e.company_name, ms: 0, sessions: 0 };
    row.ms += ms;
    row.sessions += 1;
    map.set(e.company_id, row);
  }
  const rows = [...map.values()].sort((a, b) => b.ms - a.ms || a.company_name.localeCompare(b.company_name, "fr"));
  return { total: rows.reduce((s, r) => s + r.ms, 0), rows };
}

/** 4 h 35 · 0 h 07 · 12 min ; secondes en option (chrono). */
export function formatDuration(ms: number, opts: { seconds?: boolean } = {}): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (opts.seconds) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${h} h ${String(m).padStart(2, "0")}`;
}

/** « 1h30 », « 1:30 », « 90 », « 1,5 h », « 45 min » → millisecondes (null si illisible). */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(",", ".").replace(/\s+/g, "");
  if (!s) return null;
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{1,2})(?:h|:)(\d{1,2})?(?:min|m)?$/))) return (Number(m[1]) * 60 + Number(m[2] ?? 0)) * 60_000;
  if ((m = s.match(/^(\d{1,2}(?:\.\d{1,2})?)h$/))) return Math.round(Number(m[1]) * 60) * 60_000;
  if ((m = s.match(/^(\d{1,4})(?:min|m)?$/))) return Number(m[1]) * 60_000;
  return null;
}

/** Saisie manuelle : la session est placée dans la journée choisie (début 8 h, ou plus tôt si elle est longue). */
export function manualSlot(day: string, ms: number): { started_at: string; ended_at: string } {
  const dayStart = startOfDay(day);
  const dayEnd = startOfDay(addDaysKey(day, 1));
  const start = Math.max(dayStart, Math.min(zonedToUtc(day, "08:00", TZ).getTime(), dayEnd - ms));
  return { started_at: new Date(start).toISOString(), ended_at: new Date(start + ms).toISOString() };
}

export const todayParis = (now = new Date()) => dayKey(now, TZ);
