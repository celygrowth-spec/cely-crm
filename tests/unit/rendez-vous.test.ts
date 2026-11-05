// Module Rendez-vous : briques pures (intervalles, ICS, jetons privés, chiffrement, fuseaux).
import { beforeAll, describe, expect, test } from "vitest";
import { mergeIntervals, subtractIntervals } from "@/lib/appointments/intervals";
import { buildIcs, foldLine, icsEscape } from "@/lib/appointments/ics";
import { dayKey, monthGrid, zonedToUtc } from "@/lib/appointments/time";
import { eventIdFor } from "@/lib/appointments/google";
import { slugify, eventTypeSchema } from "@/lib/appointments/schemas";

beforeAll(() => {
  process.env.APPOINTMENTS_SECRET = "s".repeat(48);
});

describe("intervalles", () => {
  test("fusion et soustraction de nos propres rendez-vous", () => {
    const busy = [
      { start: "2026-12-07T08:00:00Z", end: "2026-12-07T09:00:00Z" },
      { start: "2026-12-07T08:30:00Z", end: "2026-12-07T10:00:00Z" },
    ];
    expect(mergeIntervals(busy)).toEqual([{ start: "2026-12-07T08:00:00.000Z", end: "2026-12-07T10:00:00.000Z" }]);
    // notre rendez-vous 08:30-09:00 a été fusionné par Google avec un événement externe : seul l'externe reste
    expect(subtractIntervals(busy, [{ start: "2026-12-07T08:30:00Z", end: "2026-12-07T09:00:00Z" }])).toEqual([
      { start: "2026-12-07T08:00:00.000Z", end: "2026-12-07T08:30:00.000Z" },
      { start: "2026-12-07T09:00:00.000Z", end: "2026-12-07T10:00:00.000Z" },
    ]);
    expect(subtractIntervals([{ start: "2026-12-07T08:00:00Z", end: "2026-12-07T08:30:00Z" }], [{ start: "2026-12-07T08:00:00Z", end: "2026-12-07T08:30:00Z" }])).toEqual([]);
  });
});

describe("ICS", () => {
  test("fichier valide : CRLF, échappement, UID stable, SEQUENCE = version, lignes repliées", () => {
    const ics = buildIcs({
      uid: "abc@cely", sequence: 2, start: "2026-12-07T08:00:00Z", end: "2026-12-07T08:30:00Z",
      summary: "Appel découverte, Cely; test", description: "Ligne 1\nLigne 2 " + "é".repeat(60), location: "https://meet.example.com/x",
      now: new Date("2026-11-05T10:00:00Z"),
    });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20261207T080000Z\r\n");
    expect(ics).toContain("SEQUENCE:2\r\n");
    expect(ics).toContain("SUMMARY:Appel découverte\\, Cely\\; test");
    expect(ics).not.toMatch(/[^\r]\n/);
    for (const line of ics.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(icsEscape("a\\b")).toBe("a\\\\b");
    expect(foldLine("x".repeat(80))).toBe("x".repeat(75) + "\r\n " + "x".repeat(5));
    expect(buildIcs({ uid: "u", sequence: 3, start: "2026-12-07T08:00:00Z", end: "2026-12-07T08:30:00Z", summary: "s", cancelled: true })).toContain("STATUS:CANCELLED");
  });
});

describe("liens privés et chiffrement", () => {
  test("jeton propre à chaque rendez-vous, vérifié en temps constant, non falsifiable", async () => {
    const { manageRef, parseManageRef, tokenHashFor } = await import("@/lib/appointments/secrets");
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const refA = manageRef(a);
    expect(manageRef(a)).toBe(refA); // déterministe : un double clic retrouve le même lien
    expect(parseManageRef(refA)).toEqual({ id: a, tokenHash: tokenHashFor(a) });
    const tokenA = refA.split(".")[1];
    expect(parseManageRef(`${b}.${tokenA}`)).toBeNull();
    expect(parseManageRef(`${a}.${tokenA.slice(0, -1)}x`)).toBeNull();
    expect(parseManageRef("nimportequoi")).toBeNull();
  });

  test("chiffrement AES-GCM du jeton Google : aller-retour, falsification détectée", async () => {
    const { encryptSecret, decryptSecret } = await import("@/lib/appointments/secrets");
    const enc = encryptSecret("1//refresh-token");
    expect(enc).not.toContain("refresh");
    expect(decryptSecret(enc)).toBe("1//refresh-token");
    const parts = enc.split(".");
    parts[3] = Buffer.from("autre chose").toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("fuseaux", () => {
  test("heure locale → UTC, changements d'heure compris", () => {
    expect(zonedToUtc("2026-12-07", "09:00", "Europe/Paris").toISOString()).toBe("2026-12-07T08:00:00.000Z");
    expect(zonedToUtc("2027-07-05", "09:00", "Europe/Paris").toISOString()).toBe("2027-07-05T07:00:00.000Z");
    // 02:30 n'existe pas le 28 mars 2027 : décalé après le saut, comme Postgres
    expect(zonedToUtc("2027-03-28", "02:30", "Europe/Paris").toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(zonedToUtc("2026-12-07", "09:00", "America/New_York").toISOString()).toBe("2026-12-07T14:00:00.000Z");
  });
  test("jour local et grille du mois (lundi en premier)", () => {
    expect(dayKey("2026-12-07T23:30:00Z", "Europe/Paris")).toBe("2026-12-08");
    expect(dayKey("2026-12-07T23:30:00Z", "America/New_York")).toBe("2026-12-07");
    const g = monthGrid("2026-12");
    expect(g.slice(0, 3)).toEqual([null, "2026-12-01", "2026-12-02"]); // 1er décembre 2026 = mardi
    expect(g.indexOf("2026-12-01")).toBe(1);
    expect(g.length % 7).toBe(0);
  });
});

describe("divers", () => {
  test("identifiant d'événement Google déterministe et valide (base32hex)", () => {
    const id = eventIdFor("0a1b2c3d-4e5f-4789-8abc-def012345678");
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(id).toBe(eventIdFor("0a1b2c3d-4e5f-4789-8abc-def012345678"));
  });
  test("slug et validation d'un type", () => {
    expect(slugify("Appel découverte — 30 min !")).toBe("appel-decouverte-30-min");
    const base = {
      name: "Appel", slug: "appel", description: "", duration_min: 30, location_kind: "video", location_detail: null, meeting_url: "http://x",
      google_meet: false, schedule_id: "11111111-1111-4111-8111-111111111111", buffer_before_min: 0, buffer_after_min: 0, min_notice_min: 0,
      horizon_days: 30, daily_limit: null, slot_interval_min: null, phone_required: false, questions: [], active: true,
    };
    expect(eventTypeSchema.safeParse(base).success).toBe(false);
    expect(eventTypeSchema.safeParse({ ...base, meeting_url: "https://meet.example.com/a" }).success).toBe(true);
    expect(eventTypeSchema.safeParse({ ...base, meeting_url: null, questions: [{ id: "q", label: "Budget", kind: "choice", required: true, options: ["A"] }] }).success).toBe(false);
  });
});
