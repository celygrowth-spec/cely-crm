import { describe, expect, test } from "vitest";
import type { Booking } from "@/lib/appointments/types";
import { buildActivity, buildJournal, emailThread, matchesFilter, nextBooking, openTasks, recentExchanges } from "@/lib/crm/record-activity";
import type { ClaudeLogEntry, Interaction, Task } from "@/lib/crm/types";
import type { Call } from "@/lib/fireflies/types";
import type { MailMessage } from "@/lib/mail/types";

const interaction = (id: string, kind: Interaction["kind"], at: string, extra: Partial<Interaction> = {}): Interaction => ({
  id, company_id: "c", person_id: null, kind, channel: null, occurred_at: at, content: null, content_origin: "user", source: "user", campaign_participant_id: null, meta: {}, created_at: at, ...extra,
});
const call = (id: string, title: string, at: string, extra: Partial<Call> = {}) =>
  ({ id, title, occurred_at: at, person_id: null, summary: { gist: `Résumé ${id}` }, summary_state: "available", ...extra }) as Call;
const task = (id: string, due: string, done: string | null = null): Task =>
  ({ id, company_id: "c", person_id: null, title: id, due_date: due, done_at: done, source: "user", created_at: "2026-01-01T00:00:00Z" });
const mail = (id: string, status: MailMessage["status"], extra: Partial<MailMessage> = {}) =>
  ({ id, status, subject: id, body_text: "", person_id: null, sent_at: null, updated_at: "2026-11-01T10:00:00Z", provider_thread_id: null, ...extra }) as MailMessage;
const booking = (id: string, at: string, status: Booking["display_status"], extra: Partial<Booking> = {}) =>
  ({ id, starts_at: at, ends_at: at, display_status: status, person_id: null, event_snapshot: { name: "R1" }, ...extra }) as unknown as Booking;

describe("appels Fireflies dans la timeline", () => {
  test("un appel relié à une activité n'apparaît qu'une fois, avec son résumé", () => {
    const entries = buildActivity({
      interactions: [interaction("i1", "call", "2026-11-05T13:30:00Z", { content: "Appel enregistré par Fireflies", meta: { fireflies_call_id: "f1" } })],
      calls: [call("f1", "Corentin & Célien - Diagnostic", "2026-11-05T13:30:00Z")],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "i1", title: "Corentin & Célien - Diagnostic", preview: "Résumé f1" });
    expect(entries[0].call?.id).toBe("f1");
  });

  test("deux appels distincts au même titre restent distincts", () => {
    const entries = buildActivity({
      interactions: [
        interaction("i1", "call", "2026-11-05T13:30:00Z", { meta: { fireflies_call_id: "f1" } }),
        interaction("i2", "call", "2026-11-05T13:35:00Z", { meta: { fireflies_call_id: "f2" } }),
      ],
      calls: [call("f1", "Diagnostic", "2026-11-05T13:30:00Z"), call("f2", "Diagnostic", "2026-11-05T13:35:00Z")],
    });
    expect(entries.map((e) => e.call?.id)).toEqual(["f2", "f1"]);
  });

  test("un appel manuel proche d'un compte rendu n'est pas fusionné : aucun lien fiable", () => {
    const entries = buildActivity({
      interactions: [
        interaction("manuel", "call", "2026-11-05T13:31:00Z"),
        interaction("i1", "call", "2026-11-05T13:30:00Z", { meta: { fireflies_call_id: "f1" } }),
      ],
      calls: [call("f1", "Appel", "2026-11-05T13:30:00Z")],
    });
    expect(entries.map((e) => e.key)).toEqual(["manuel", "i1"]);
    expect(entries[0].call).toBeUndefined();
  });

  test("un compte rendu sans activité reliée garde sa propre entrée", () => {
    const entries = buildActivity({ interactions: [], calls: [call("f1", "Seul", "2026-11-05T13:30:00Z")] });
    expect(entries.map((e) => e.key)).toEqual(["call-f1"]);
  });

  test("activité reliée, comptes rendus pas encore chargés : l'entrée existe déjà, sans doublon ensuite", () => {
    const interactions = [interaction("i1", "call", "2026-11-05T13:30:00Z", { content: "Appel enregistré par Fireflies", meta: { fireflies_call_id: "f1" } })];
    expect(buildActivity({ interactions })).toHaveLength(1);
    expect(buildActivity({ interactions, calls: [call("f1", "Diagnostic", "2026-11-05T13:30:00Z")] })).toHaveLength(1);
  });

  test("un rendez-vous enregistré par Fireflies répond aux filtres Appels et Rendez-vous, en une seule entrée", () => {
    const entries = buildActivity({
      interactions: [interaction("i1", "meeting", "2026-11-05T13:30:00Z", { meta: { fireflies_call_id: "f1", appointment_id: "b1" } })],
      calls: [call("f1", "R1", "2026-11-05T13:30:00Z")],
      bookings: [booking("b1", "2026-11-05T13:30:00Z", "done")],
    });
    expect(entries).toHaveLength(1);
    expect(matchesFilter(entries[0], "call")).toBe(true);
    expect(matchesFilter(entries[0], "meeting")).toBe(true);
    expect(matchesFilter(entries[0], "note")).toBe(false);
  });
});

describe("timeline et derniers échanges", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");

  test("les traces système vont au journal, jamais dans le fil", () => {
    const interactions = [
      interaction("n", "note", "2026-11-03T10:00:00Z"),
      interaction("s", "stage_change", "2026-11-04T10:00:00Z"),
      interaction("d", "task_done", "2026-11-04T11:00:00Z"),
      interaction("y", "system", "2026-11-04T12:00:00Z"),
    ];
    const log: ClaudeLogEntry[] = [
      { id: 1, table_name: "companies", operation: "UPDATE", summary: null, created_at: "2026-11-04T13:00:00Z" },
      { id: 2, table_name: "interactions", operation: "INSERT", summary: null, created_at: "2026-11-04T14:00:00Z" },
    ];
    expect(buildActivity({ interactions }).map((e) => e.key)).toEqual(["n"]);
    expect(buildJournal(interactions, log).map((e) => e.key)).toEqual(["log-1", "y", "d", "s"]);
  });

  test("email envoyé : une seule entrée ; brouillon : gardé dans le fil mais pas dans les derniers échanges", () => {
    const entries = buildActivity({
      interactions: [interaction("i1", "message_out", "2026-11-05T10:00:00Z", { channel: "email", content: "Objet : Devis\n\nBonjour", meta: { mail_id: "m1" } })],
      mails: [mail("m1", "accepted", { subject: "Devis" }), mail("m2", "draft")],
    });
    expect(entries.map((e) => e.key).sort()).toEqual(["i1", "mail-m2"]);
    expect(entries.find((e) => e.key === "i1")).toMatchObject({ title: "Email · Devis", preview: "Bonjour" });
    expect(recentExchanges(entries, 3, now).map((e) => e.key)).toEqual(["i1"]);
  });

  test("derniers échanges : trois au plus, sans tâche ni rendez-vous à venir ou annulé", () => {
    const entries = buildActivity({
      interactions: ["1", "2", "3", "4"].map((n) => interaction(`n${n}`, "note", `2026-11-0${n}T10:00:00Z`)),
      tasks: [task("t", "2026-11-05", "2026-11-05T15:00:00Z")],
      bookings: [booking("futur", "2026-11-20T10:00:00Z", "a_venir"), booking("annule", "2026-11-05T18:00:00Z", "cancelled")],
    });
    expect(recentExchanges(entries, 3, now).map((e) => e.key)).toEqual(["n4", "n3", "n2"]);
  });

  test("seules les tâches terminées entrent dans le fil, les autres sont triées par urgence", () => {
    const tasks = [task("b", "2026-11-09"), task("a", "2026-11-05"), task("fait", "2026-11-01", "2026-11-02T09:00:00Z")];
    expect(buildActivity({ interactions: [], tasks }).map((e) => e.key)).toEqual(["task-fait"]);
    expect(openTasks(tasks).map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("prochain rendez-vous : le plus proche à venir, jamais un annulé", () => {
    const list = [booking("loin", "2026-12-01T10:00:00Z", "a_venir"), booking("annule", "2026-11-07T10:00:00Z", "cancelled"), booking("proche", "2026-11-10T10:00:00Z", "a_venir"), booking("passe", "2026-11-01T10:00:00Z", "done")];
    expect(nextBooking(list, now)?.id).toBe("proche");
    expect(nextBooking([list[1], list[3]], now)).toBeNull();
  });

  test("le fil d'un email regroupe les messages du même fil Gmail, du plus ancien au plus récent", () => {
    const a = mail("a", "accepted", { provider_thread_id: "t", sent_at: "2026-11-02T10:00:00Z" });
    const b = mail("b", "accepted", { provider_thread_id: "t", sent_at: "2026-11-01T10:00:00Z" });
    const c = mail("c", "accepted", { provider_thread_id: "u" });
    expect(emailThread(a, [a, b, c]).map((m) => m.id)).toEqual(["b", "a"]);
    expect(emailThread(mail("seul", "draft"), [a, b]).map((m) => m.id)).toEqual(["seul"]);
  });
});

describe("clôture de l'opportunité", () => {
  test("gagnée, perdue, rouverte : jalons du fil, hors échanges récents et hors journal", () => {
    const won = interaction("d1", "deal_status", "2026-11-08T10:00:00Z", { content: "Opportunité gagnée : signée le 08/11/2026 · 4500 €", meta: { from: "open", to: "won" } });
    const reopened = interaction("d2", "deal_status", "2026-11-09T10:00:00Z", { content: "Opportunité rouverte : était gagnée · retour à l'étape Vente › Proposition", meta: { from: "won", to: "open" } });
    const old = interaction("d3", "deal_status", "2026-11-01T10:00:00Z", { content: "Opportunité perdue", meta: { from: "open", to: "lost" } });
    const entries = buildActivity({ interactions: [won, reopened, old] });
    expect(entries.map((e) => [e.type, e.title, e.preview])).toEqual([
      ["deal", "Opportunité rouverte", "était gagnée · retour à l'étape Vente › Proposition"],
      ["deal", "Opportunité gagnée", "signée le 08/11/2026 · 4500 €"],
      ["deal", "Opportunité perdue", null],
    ]);
    expect(recentExchanges(entries, 3, Date.parse("2026-12-01"))).toHaveLength(0);
    expect(buildJournal([won, reopened, old], [])).toHaveLength(0);
    expect(entries.filter((e) => matchesFilter(e, "all"))).toHaveLength(3);
    expect(entries.filter((e) => matchesFilter(e, "note"))).toHaveLength(0);
  });
});
