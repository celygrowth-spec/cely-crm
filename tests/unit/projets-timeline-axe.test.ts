// Repères de la frise : mois et 10 · 20 · 30 seulement s'ils existent et tombent dans la période,
// densité selon la durée, phases à leurs dates réelles, aujourd'hui distinct de la phase en cours,
// et « Mes prochains points » (mise en avant, deux suivants, lien Meet ou « Lien à venir »).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { axisTicks, makeScale } from "@/lib/projects/timeline-axis";
import { TimelineVisual } from "@/components/portal/timeline";
import { UpcomingMeetings, type UpcomingMeeting } from "@/components/portal/overview";
import type { Phase } from "@/lib/projects/types";

const labels = (a: string, b: string) => axisTicks(makeScale([a, b])!).map((t) => `${t.label}${t.year ? ` ${t.year}` : ""}`);

describe("axe de la frise", () => {
  test("février : pas de 30 ; seuls les jours de la période", () => {
    expect(labels("2026-02-01", "2026-02-28")).toEqual(["Févr", "10", "20"]);
    expect(labels("2026-01-01", "2026-03-15")).toEqual(["Janv", "10", "20", "Févr", "10", "20", "Mars", "10"]);
    // période commençant le 12 : pas de « 10 » avant le début
    expect(labels("2026-03-12", "2026-03-31")).toEqual(["Mars", "20", "30"]);
  });

  test("densité selon la durée et l'écran ; année affichée au changement d'année", () => {
    const mid = axisTicks(makeScale(["2026-11-04", "2027-01-31"])!);
    expect(mid.filter((t) => t.kind === "month").map((t) => `${t.label}${t.year ?? ""}`)).toEqual(["Nov2026", "Déc", "Janv2027"]);
    expect(new Set(mid.filter((t) => t.kind === "day").map((t) => t.reach))).toEqual(new Set(["sm"])); // jours masqués sur mobile
    const long = axisTicks(makeScale(["2026-01-01", "2027-06-30"])!);
    expect(long.some((t) => t.kind === "day")).toBe(false);
    expect(long.filter((t) => t.reach === "all").map((t) => t.label)).toEqual(["Janv", "Avr", "Juil", "Oct", "Janv", "Avr"]); // trimestres sur mobile
    // aucun numéro de jour collé à un repère de mois (30 novembre / 1er décembre)
    expect(mid.find((t) => t.label === "30" && t.left < 35)).toBeUndefined();
  });

  test("positions : une phase occupe ses jours de début à fin inclus ; aujourd'hui au milieu de sa journée", () => {
    const s = makeScale(["2026-02-01", "2026-02-28"])!;
    expect(s.days).toBe(28);
    expect(s.at("2026-02-01")).toBe(0);
    expect(s.at("2026-02-28", "end")).toBe(100);
    expect(s.at("2026-02-14", "mid")).toBeCloseTo((13.5 / 28) * 100, 5);
  });
});

const phase = (name: string, start: string, end: string, status: Phase["status"]): Phase => ({
  id: name, name, description: null, deliverables: null, start_date: start, end_date: end, color: "violet", status, completed_at: null,
});

describe("frise", () => {
  test("phase en cours après sa date de fin : repère « En cours », dépassement hachuré jusqu'à aujourd'hui, distinct du trait du jour", () => {
    const html = renderToStaticMarkup(createElement(TimelineVisual, {
      phases: [phase("Cadrage", "2026-01-01", "2026-01-31", "termine"), phase("Production", "2026-02-01", "2026-02-28", "en_cours"), phase("Livraison", "2026-03-01", "2026-03-31", "a_venir")],
      milestones: [], meetings: [], today: "2026-03-10", start: null, end: null, projectId: "p",
    }));
    expect(html).toContain('data-current-phase="Production"');
    expect(html).toContain("En cours · Production");
    expect(html).toContain("tl-overrun");
    expect(html).toMatch(/Aujourd&#x27;hui · 10 mars/);
    expect(html).toContain("data-axis");
  });
});

const m = (id: string, day: number, extra: Partial<UpcomingMeeting> = {}): UpcomingMeeting => ({
  id, title: `Point ${id}`, starts_at: `2026-11-${String(day).padStart(2, "0")}T09:00:00Z`, ends_at: `2026-11-${String(day).padStart(2, "0")}T09:30:00Z`,
  timezone: "Europe/Paris", status: "upcoming", meeting_url: null, location_kind: "video", participants: null, has_recap: false, ...extra,
});

describe("Mes prochains points", () => {
  test("le prochain mis en avant, deux suivants compacts, ordre par date réelle, annulés et passés exclus", () => {
    const html = renderToStaticMarkup(createElement(UpcomingMeetings, {
      meetings: [m("D", 20), m("B", 12, { meeting_url: "https://meet.google.com/abc-defg-hij" }), m("X", 10, { status: "cancelled" }), m("C", 15), m("A", 9, { status: "past" }), m("E", 25)],
      hrefFor: (x: UpcomingMeeting) => `/portail/p/p1/points/${x.id}`,
    }));
    expect([...html.matchAll(/data-meeting="(\w)"/g)].map((r) => r[1])).toEqual(["B", "C", "D"]);
    expect(html).toContain("Rejoindre sur Google Meet");
    expect(html.match(/Lien à venir/g)).toHaveLength(2);
    expect(html).toContain('href="/portail/p/p1/points/B"');
    expect(html).not.toContain("Point X");
  });

  test("plusieurs projets : nom du projet ; aucun point : message simple", () => {
    const multi = renderToStaticMarkup(createElement(UpcomingMeetings, { meetings: [m("A", 9, { project_name: "Refonte" })], showProject: true }));
    expect(multi).toContain("Refonte");
    expect(renderToStaticMarkup(createElement(UpcomingMeetings, { meetings: [m("X", 10, { status: "cancelled" })] }))).toContain("Aucun point prévu pour le moment");
  });
});

test("mois de départ proche du mois suivant : masqué sur mobile pour éviter le chevauchement", () => {
  const t = axisTicks(makeScale(["2026-10-17", "2027-01-05"])!);
  expect(t[0]).toMatchObject({ label: "Oct", reach: "sm", year: 2026 });
  expect(t.find((x) => x.label === "Nov")?.reach).toBe("all");
});
