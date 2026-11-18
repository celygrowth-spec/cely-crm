// Onboarding offre découverte : type déduit de l'extension (jamais du navigateur), formats par étape, écrans.
import { describe, expect, test } from "vitest";
import { acceptedFor, mimeFromName } from "@/lib/discovery/files";
import { OFFER_QUESTIONS, LEMLIST_TUTO, LINKEDIN_TUTO } from "@/lib/discovery/content";
import { stepProgress, type DiscoveryView } from "@/lib/discovery/types";

describe("fichiers", () => {
  test("type déduit de l'extension, insensible à la casse ; HTML, SVG et exécutables refusés", () => {
    expect(mimeFromName("Basic_LinkedInDataExport.ZIP")).toBe("application/zip");
    expect(mimeFromName("liste.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    for (const n of ["page.html", "logo.svg", "setup.exe", "sans-extension"]) expect(mimeFromName(n)).toBeNull();
  });
  test("formats par étape", () => {
    expect(acceptedFor("blacklist", "clients.csv")).toBe(true);
    expect(acceptedFor("blacklist", "archive.zip")).toBe(false);
    expect(acceptedFor("linkedin", "export.zip")).toBe(true);
    expect(acceptedFor("linkedin", "export.csv")).toBe(false);
    expect(acceptedFor("documents", "deck.pptx")).toBe(true);
  });
});

describe("contenu", () => {
  test("5 à 7 questions, clés uniques et valides pour la base", () => {
    expect(OFFER_QUESTIONS.length).toBeGreaterThanOrEqual(5);
    expect(OFFER_QUESTIONS.length).toBeLessThanOrEqual(7);
    const keys = OFFER_QUESTIONS.map((q) => q.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9_]{1,60}$/);
    expect(LEMLIST_TUTO.length).toBeGreaterThan(0);
    expect(LINKEDIN_TUTO.some((s) => /24 h/.test(s.title + s.body))).toBe(true);
  });
});

describe("avancement affiché dans le panneau", () => {
  const base: DiscoveryView = {
    project: { id: "p", name: "P", company: "C", read_only: false }, me: null, settings: { lemlist_invite_email: null },
    started_at: null, sent_at: null, sent_by: null, position: null, answers: {}, steps: {}, files: [],
    targets: [1, 2, 3].map((position) => ({ position, name: "", sector: "", company_size: "", roles: "", geography: "", notes: "", client_filled: [], rev: 1, validated_at: null, validated_by: null, modified_since_validation: false, comments: [] })),
  };
  test("non commencé → en cours → complétée → envoyé ; « plus tard » reste en cours", () => {
    expect(stepProgress(base, "offer")).toBe("not_started");
    const a = { ...base, answers: { offer_pitch: { value: "x", rev: 1, by: null, mine: true, at: "" } } };
    expect(stepProgress(a, "offer")).toBe("in_progress");
    const done = { ...a, steps: { offer: { status: "done" as const, by: null, at: "" }, linkedin: { status: "later" as const, by: null, at: "" } } };
    expect(stepProgress(done, "offer")).toBe("complete");
    expect(stepProgress(done, "linkedin")).toBe("in_progress");
    expect(stepProgress({ ...done, sent_at: "2026-11-18" }, "offer")).toBe("sent");
  });
});
