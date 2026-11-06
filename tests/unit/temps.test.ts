// Suivi du temps : périodes Europe/Paris, répartition à minuit, totaux par client, saisie des durées.
import { describe, expect, test } from "vitest";
import { formatDuration, manualSlot, overlap, parseDuration, periodOf, splitByDay, totalsByClient, type TimeEntry } from "@/lib/time/calc";

const H = 3600_000;
const e = (id: string, company: string, start: string, end: string | null, source: "timer" | "manual" = "timer"): TimeEntry =>
  ({ id, company_id: company, company_name: `Client ${company}`, label: null, started_at: start, ended_at: end, source });

describe("périodes (Europe/Paris)", () => {
  test("cette semaine = lundi → dimanche, bornes à minuit heure de Paris", () => {
    const p = periodOf(undefined, "2026-11-06"); // vendredi
    expect([p.kind, p.from, p.to]).toEqual(["semaine", "2026-11-02", "2026-11-08"]);
    expect(new Date(p.start).toISOString()).toBe("2026-11-01T23:00:00.000Z"); // lundi 00:00 CET
    expect(new Date(p.end).toISOString()).toBe("2026-11-08T23:00:00.000Z");
  });
  test("aujourd'hui, ce mois-ci, période personnalisée (invalide → semaine)", () => {
    expect(periodOf("jour", "2026-11-06")).toMatchObject({ from: "2026-11-06", to: "2026-11-06" });
    expect(periodOf("mois", "2026-02-10")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodOf("perso", "2026-11-06", "2026-10-01", "2026-10-15")).toMatchObject({ kind: "perso", from: "2026-10-01", to: "2026-10-15" });
    expect(periodOf("perso", "2026-11-06", "2026-10-15", "2026-10-01").kind).toBe("semaine");
  });
  test("passage à l'heure d'hiver : la journée du 25 octobre 2026 dure 25 h", () => {
    const p = periodOf("jour", "2026-10-25");
    expect((p.end - p.start) / H).toBe(25);
  });
});

describe("sessions", () => {
  test("une session qui traverse minuit est répartie entre les deux jours", () => {
    // 22:30 → 01:15 heure de Paris (CET = UTC+1)
    const s = e("1", "A", "2026-11-05T21:30:00Z", "2026-11-06T00:15:00Z");
    expect(splitByDay(s)).toEqual([{ day: "2026-11-05", ms: 1.5 * H }, { day: "2026-11-06", ms: 1.25 * H }]);
    expect(overlap(s, periodOf("jour", "2026-11-05").start, periodOf("jour", "2026-11-05").end, 0)).toBe(1.5 * H);
    expect(totalsByClient([s], periodOf("jour", "2026-11-06")).total).toBe(1.25 * H);
    expect(totalsByClient([s], periodOf("semaine", "2026-11-06")).total).toBe(2.75 * H);
  });
  test("totaux par client triés, sessions comptées, chrono en cours exclu", () => {
    const p = periodOf("semaine", "2026-11-06");
    const t = totalsByClient([
      e("1", "A", "2026-11-03T08:00:00Z", "2026-11-03T10:00:00Z"),
      e("2", "B", "2026-11-04T08:00:00Z", "2026-11-04T08:30:00Z"),
      e("3", "A", "2026-11-05T08:00:00Z", "2026-11-05T09:35:00Z"),
      e("4", "B", "2026-11-06T08:00:00Z", null), // en cours
      e("5", "C", "2026-10-20T08:00:00Z", "2026-10-20T09:00:00Z"), // hors période
    ], p);
    expect(t.rows.map((r) => [r.company_name, formatDuration(r.ms), r.sessions])).toEqual([["Client A", "3 h 35", 2], ["Client B", "0 h 30", 1]]);
    expect(formatDuration(t.total)).toBe("4 h 05");
  });
});

describe("saisie", () => {
  test("durées lisibles", () => {
    expect([parseDuration("1h30"), parseDuration("1:30"), parseDuration("90"), parseDuration("1,5h"), parseDuration("45 min"), parseDuration("2h"), parseDuration("abc")])
      .toEqual([90, 90, 90, 90, 45, 120, null].map((m) => (m === null ? null : m * 60_000)));
    expect(formatDuration(65 * 60_000 + 7_000, { seconds: true })).toBe("1:05:07");
  });
  test("saisie manuelle : placée dans la journée choisie, même longue", () => {
    const a = manualSlot("2026-11-05", 2 * H);
    expect(a.started_at).toBe("2026-11-05T07:00:00.000Z"); // 8 h à Paris
    const b = manualSlot("2026-11-05", 20 * H);
    expect(splitByDay({ started_at: b.started_at, ended_at: b.ended_at })).toEqual([{ day: "2026-11-05", ms: 20 * H }]);
  });
});
