// Timeline : repère « Aujourd'hui » avant / pendant / après le projet, et écart entre planning et avancement.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { TimelineList, TimelineVisual, currentPhase, isLate } from "@/components/portal/timeline";
import type { Phase } from "@/lib/projects/types";

const phase = (name: string, start: string, end: string, status: Phase["status"]): Phase => ({
  id: name, name, description: null, deliverables: null, start_date: start, end_date: end, color: "violet", status, completed_at: null,
});
const phases = [
  phase("Cadrage", "2026-01-01", "2026-01-31", "termine"),
  phase("Production", "2026-02-01", "2026-02-28", "en_cours"),
  phase("Livraison", "2026-03-01", "2026-03-15", "a_venir"),
];
const render = (today: string, ph = phases) =>
  renderToStaticMarkup(createElement(TimelineVisual, { phases: ph, milestones: [], meetings: [], today, start: "2026-01-01", end: "2026-03-15", projectId: "p" }));

describe("timeline", () => {
  test("avant, pendant, après : le repère n'apparaît que dans la période", () => {
    expect(render("2025-12-01")).not.toContain("data-today=");
    const during = render("2026-02-14");
    expect(during).toContain("Aujourd&#x27;hui");
    // 14 février, milieu de journée : (44 + 0,5) / 74 jours ≈ 60,1 % de la période
    expect(during).toContain('data-today="60.14"');
    expect(render("2026-06-01")).not.toContain("data-today=");
  });

  test("planning ≠ avancement : une date passée ne termine rien ; décalage signalé sans dramatiser", () => {
    const today = "2026-03-10";
    expect(isLate(phases[1], today)).toBe(true); // Production devait finir le 28/02, toujours « en cours »
    expect(isLate(phases[0], today)).toBe(false); // terminée
    expect(currentPhase(phases)?.name).toBe("Production");
    const list = renderToStaticMarkup(createElement(TimelineList, { phases, milestones: [], meetings: [], today, start: null, end: null, projectId: "p" }));
    expect(list).toContain("Dépasse la date prévue");
    expect(list).toContain("En cours");
    expect(list.match(/Dépasse la date prévue/g)).toHaveLength(1);
  });

  test("phase terminée : coche ; phase en pause : motif distinct ; sans dates : phases réparties", () => {
    const html = render("2026-02-14", [phases[0], { ...phases[1], status: "en_pause" }]);
    expect(html).toContain("tl-check");
    expect(html).toContain("tl-paused");
    const undated = renderToStaticMarkup(createElement(TimelineVisual, {
      phases: phases.map((p) => ({ ...p, start_date: null, end_date: null })), milestones: [], meetings: [], today: "2026-02-14", start: null, end: null, projectId: "p",
    }));
    expect(undated).not.toContain("data-today=");
    expect(undated.match(/flex:1/g)?.length).toBe(3);
  });
});
