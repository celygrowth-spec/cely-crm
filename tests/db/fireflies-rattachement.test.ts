// Rattachement des appels Fireflies : vraies migrations, import sous le rôle anon comme en production.
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { normalizeTranscript } from "@/lib/fireflies/normalize";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-0123456789abcdef0123456789";
const ACCOUNT = { id: "ff-user-1", email: "compte-fireflies@gmail.com" };
const START = "2026-11-02T10:00:00Z";
const START_MS = Date.parse(START);

let db: Db;
let eventType: string;

type Link = {
  id: string; link_state: string; link_source: string | null; link_reason: string | null; company_id: string | null;
  person_id: string | null; booking_id: string | null; interaction_id: string | null;
  link_candidates: { company_id: string; name: string; reasons: string[] }[];
};

const counter = { n: 0 };
const nextId = () => `meet${++counter.n}`;

function transcript(id: string, o: Record<string, unknown> = {}) {
  return {
    id, title: "[TEST] Appel", date: START_MS, duration: 30, participants: ["moi@celygrowth.com"], organizer_email: "moi@celygrowth.com",
    transcript_url: `https://app.fireflies.ai/view/${id}`, meeting_info: { summary_status: "processed", silent_meeting: false },
    summary: { overview: "Résumé" }, sentences: [{ index: 0, speaker_name: "Moi", text: "Bonjour", start_time: 0, end_time: 1 }], ...o,
  };
}

/** Un passage complet : événement, prise de la tâche, enregistrement. */
async function importCall(id: string, o: Record<string, unknown> = {}, reprocessed: number | null = null): Promise<Link> {
  await db.as("anon");
  await db.rpc("fireflies_enqueue", { p_server_key: KEY, p_meeting_id: id, p_event: "meeting.transcribed", p_reprocessed_at: reprocessed });
  const jobs = await db.rpc<{ id: string; lock_token: string }[]>("fireflies_claim_jobs", { p_server_key: KEY, p_limit: 1 });
  const { call, lines } = normalizeTranscript(transcript(id, o));
  await db.rpc("fireflies_store_call", {
    p_server_key: KEY, p_job_id: jobs[0].id, p_lock_token: jobs[0].lock_token, p_account: JSON.stringify(ACCOUNT),
    p_call: JSON.stringify(call), p_lines: JSON.stringify(lines),
  });
  return link(id);
}
async function link(id: string): Promise<Link> {
  await db.as("owner");
  return db.one<Link>(`select * from fireflies_calls where fireflies_id = $1`, [id]);
}
async function company(name: string, emails: string[] = [], website?: string): Promise<string> {
  await db.as("owner");
  const r = await db.rpc<{ id: string }>("create_company", {
    p_company: JSON.stringify({ name, website }),
    p_people: JSON.stringify(emails.length ? emails.map((email) => ({ email, first_name: "Contact", last_name: email.split("@")[0] })) : [{ first_name: "Sans", last_name: "Email" }]),
    p_force: true, // des fiches volontairement proches : l'anti-doublons bloquerait la création
  });
  return r.id;
}
async function booking(o: { email: string; company?: string | null; google?: string | null; meeting?: string | null; start?: string; status?: string }) {
  await db.exec("reset role;");
  const start = o.start ?? START;
  const r = await db.one<{ id: string }>(
    `insert into appt_bookings (event_type_id, status, starts_at, ends_at, schedule_timezone, invitee_timezone, first_name, last_name, email, email_norm,
       event_snapshot, meeting_url, company_id, crm_status, idempotency_key, manage_token_hash, google_event_id)
     values ($1, $2, $3::timestamptz, $3::timestamptz + interval '30 minutes', 'Europe/Paris', 'Europe/Paris', 'Test', 'Invité', $4, lower($4),
       '{"name":"[TEST] Découverte"}', $5, $6, $7, $8, $9, $10) returning id`,
    [eventType, o.status ?? "confirmed", start, o.email, o.meeting ?? null, o.company ?? null, o.company ? "linked" : "to_link",
     `cle-${randomUUID()}`, createHash("sha256").update(randomUUID()).digest("hex"), o.google ?? null],
  );
  return r.id;
}
const activities = async (companyId: string) => {
  await db.exec("reset role;");
  return (await db.query<{ id: string; kind: string; content: string; meta: Record<string, unknown> }>(
    `select id, kind, content, meta from interactions where company_id = $1 and (meta ? 'fireflies_call_id' or meta ? 'appointment_id') order by created_at`, [companyId])).rows;
};
const count = async (table: string) => {
  await db.exec("reset role;");
  return (await db.one<{ n: number }>(`select count(*)::int n from ${table}`)).n;
};

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
  await db.exec("reset role;");
  const et = await db.query<{ id: string }>(`select id from appt_event_types limit 1`);
  eventType = et.rows[0]?.id ?? (await db.one<{ id: string }>(
    `insert into appt_event_types (name, slug, duration_min, schedule_id) select '[TEST] Découverte', 'test-decouverte', 30, id from appt_schedules where is_default returning id`)).id;
});

describe("règle 1 : rendez-vous", () => {
  test("identifiant d'événement Google : rattaché à la fiche du rendez-vous, avant toute règle d'email", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const beta = await company("[TEST] Beta", ["client@beta-test.fr"]);
    const b = await booking({ email: "contact@acme-test.fr", company: acme, google: "evt123" });
    const c = await importCall(nextId(), { cal_id: "evt123", calendar_type: "google", participants: ["client@beta-test.fr"], date: Date.parse("2026-12-25T10:00:00Z") });
    expect(c).toMatchObject({ link_state: "linked", link_source: "appointment", company_id: acme, booking_id: b });
    expect(beta).toBeTruthy();
  });

  test("identifiant d'une autre série ou rendez-vous annulé : pas de rattachement à tort", async () => {
    const acme = await company("[TEST] Acme");
    await booking({ email: "x@acme-test.fr", company: acme, google: "evt-annule", status: "cancelled" });
    expect((await importCall(nextId(), { cal_id: "evt-annule" })).link_state).toBe("to_link");
    expect((await importCall(nextId(), { cal_id: "evt-outlook", calendar_type: "outlook" })).booking_id).toBeNull();
  });

  test("lien Meet réutilisé : il faut aussi l'horaire et le participant", async () => {
    const acme = await company("[TEST] Acme");
    const meet = "https://meet.google.com/abc-defg-hij";
    const b = await booking({ email: "contact@acme-test.fr", company: acme, meeting: meet });

    const autreJour = await importCall(nextId(), { meeting_link: meet, date: START_MS + 7 * 86_400_000, participants: ["contact@acme-test.fr"] });
    expect(autreJour).toMatchObject({ link_state: "to_link", booking_id: null });
    const autrePersonne = await importCall(nextId(), { meeting_link: meet, participants: ["inconnu@ailleurs-test.fr"] });
    expect(autrePersonne).toMatchObject({ link_state: "to_link", booking_id: null });
    const bon = await importCall(nextId(), { meeting_link: meet, participants: ["CONTACT@acme-test.fr", "moi@celygrowth.com"] });
    expect(bon).toMatchObject({ link_state: "linked", link_source: "appointment", company_id: acme, booking_id: b });
  });

  test("deux rendez-vous possibles : le lien Meet départage, sinon personne n'est choisi", async () => {
    const acme = await company("[TEST] Acme");
    const a = await booking({ email: "contact@acme-test.fr", company: acme, meeting: "https://meet.google.com/aaa" });
    await booking({ email: "contact@acme-test.fr", company: acme, meeting: "https://meet.google.com/bbb" });
    expect((await importCall(nextId(), { meeting_link: "https://meet.google.com/aaa", participants: ["contact@acme-test.fr"] })).booking_id).toBe(a);
    expect((await importCall(nextId(), { participants: ["contact@acme-test.fr"] })).booking_id).toBeNull();
  });

  test("rendez-vous pas encore rattaché : lié, mais l'appel reste à rattacher ; repris une fois la fiche choisie", async () => {
    const b = await booking({ email: "nouveau@gamma-test.fr", google: "evt-g" });
    const id = nextId();
    const c = await importCall(id, { cal_id: "evt-g", participants: ["nouveau@gamma-test.fr"] });
    expect(c).toMatchObject({ link_state: "to_link", booking_id: b, company_id: null });

    const gamma = await company("[TEST] Gamma");
    await db.exec(`reset role; update appt_bookings set company_id = '${gamma}', crm_status = 'linked' where id = '${b}';`);
    await db.as("anon");
    expect(await db.rpc("fireflies_rematch", { p_server_key: KEY, p_limit: 50 })).toBe(1);
    expect(await link(id)).toMatchObject({ company_id: gamma, link_source: "appointment" });
  });

  test("rendez-vous sur une fiche fusionnée : l'appel va sur la fiche conservée", async () => {
    const keep = await company("[TEST] Garde");
    const gone = await company("[TEST] Fusionnée");
    await booking({ email: "contact@x-test.fr", company: gone, google: "evt-m" });
    await db.as("owner");
    await db.rpc("merge_companies", { p_keep: keep, p_merge: gone, p_fields: "{}", p_pipeline_from: "keep" });
    expect((await importCall(nextId(), { cal_id: "evt-m" })).company_id).toBe(keep);
  });
});

describe("règle 2 : email d'un contact", () => {
  test("un seul contact connu : rattaché, avec la personne", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const c = await importCall(nextId(), { participants: ["Contact@Acme-test.fr", "moi@celygrowth.com", "fred@fireflies.ai"] });
    expect(c).toMatchObject({ link_state: "linked", link_source: "email", company_id: acme });
    expect(c.person_id).not.toBeNull();
  });

  test("mes adresses, mon domaine et les comptes techniques ne désignent jamais une fiche", async () => {
    await company("[TEST] Moi-même", ["moi@celygrowth.com", "collegue@celygrowth.com"]);
    await company("[TEST] Ajoutée", ["perso@gmail.com"]);
    await company("[TEST] Salle", ["salle@resource.calendar.google.com", "noreply@service-test.fr", "fred@fireflies.ai"]);
    await db.as("owner");
    await db.rpc("fireflies_set_own_addresses", { p_emails: ["PERSO@gmail.com"], p_domains: [] });
    const c = await importCall(nextId(), {
      participants: ["moi@celygrowth.com", "collegue@celygrowth.com", "perso@gmail.com", "salle@resource.calendar.google.com", "noreply@service-test.fr", "fred@fireflies.ai"],
    });
    expect(c).toMatchObject({ link_state: "to_link", link_reason: "Aucun participant externe", link_candidates: [] });
  });

  test("l'adresse du compte Fireflies est reconnue dès l'import suivant", async () => {
    await company("[TEST] Compte", [ACCOUNT.email]);
    await importCall(nextId(), { participants: ["moi@celygrowth.com"] });
    expect((await importCall(nextId(), { participants: [ACCOUNT.email] })).link_state).toBe("to_link");
  });

  test("une fiche par email, même avec un autre participant inconnu", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    expect((await importCall(nextId(), { participants: ["contact@acme-test.fr", "inconnu@autre-test.fr"] })).company_id).toBe(acme);
  });

  test("deux contacts de la même entreprise : pas d'ambiguïté", async () => {
    const acme = await company("[TEST] Acme", ["a@acme-test.fr", "b@acme-test.fr"]);
    expect((await importCall(nextId(), { participants: ["a@acme-test.fr", "b@acme-test.fr"] })).company_id).toBe(acme);
  });
});

describe("règle 3 : appels à rattacher", () => {
  test("plusieurs entreprises : à rattacher, toutes candidates, jamais de choix automatique", async () => {
    const a = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const b = await company("[TEST] Beta", ["client@beta-test.fr"]);
    const c = await importCall(nextId(), { participants: ["contact@acme-test.fr", "client@beta-test.fr"] });
    expect(c).toMatchObject({ link_state: "to_link", company_id: null, link_reason: "Plusieurs entreprises parmi les participants" });
    expect(c.link_candidates.map((x) => x.company_id).sort()).toEqual([a, b].sort());
    expect(c.link_candidates[0].reasons[0]).toMatch(/^Contact : /);
  });

  test("même email sur deux fiches : ambigu", async () => {
    await company("[TEST] Acme", ["partage@test-x.fr"]);
    await company("[TEST] Beta", ["partage@test-x.fr"]);
    expect((await importCall(nextId(), { participants: ["partage@test-x.fr"] })).link_candidates).toHaveLength(2);
  });

  test("domaine, nom dans le titre, nom de personne : candidats, sans rattachement automatique", async () => {
    const parSite = await company("[TEST] Site", [], "https://www.delta-test.fr/");
    const parContact = await company("[TEST] Domaine", ["autre@delta-test.fr"]);
    const parTitre = await company("Zeta Conseil");
    await db.as("owner");
    const c = await importCall(nextId(), {
      title: "Point Zeta Conseil / Cely", participants: ["nouveau@delta-test.fr"],
      speakers: [{ id: 1, name: "Contact autre" }], meeting_attendees: [{ displayName: "Contact autre", email: "nouveau@delta-test.fr" }],
    });
    expect(c.link_state).toBe("to_link");
    expect(c.link_candidates.map((x) => x.company_id)).toEqual(expect.arrayContaining([parSite, parContact, parTitre]));
    expect(c.link_candidates.find((x) => x.company_id === parContact)!.reasons).toEqual(expect.arrayContaining(["Personne au même nom : contact autre"]));
  });

  test("les messageries grand public ne rapprochent jamais par domaine", async () => {
    await company("[TEST] Gmail", ["quelquun@gmail.com"]);
    expect((await importCall(nextId(), { participants: ["autre@gmail.com"] })).link_candidates).toEqual([]);
  });

  test("un appel ne crée jamais d'entreprise, de contact ni d'opportunité", async () => {
    await db.exec("reset role;");
    const before = [await count("companies"), await count("people")];
    await importCall(nextId(), { title: "Nouveau prospect", participants: ["inconnu@nouveau-test.fr"] });
    expect([await count("companies"), await count("people")]).toEqual(before);
    expect((await db.one<{ n: number }>(`select count(*)::int n from companies where pipeline_id is not null`)).n).toBe(0);
  });

  test("contact ajouté plus tard : le recalcul le rattache", async () => {
    const id = nextId();
    expect((await importCall(id, { participants: ["plus-tard@omega-test.fr"] })).link_state).toBe("to_link");
    const o = await company("[TEST] Omega", ["plus-tard@omega-test.fr"]);
    await db.as("owner");
    expect(await db.rpc("fireflies_rematch", {})).toBe(1);
    expect(await link(id)).toMatchObject({ company_id: o, link_source: "email" });
  });
});

describe("choix manuels", () => {
  test("correction manuelle puis resynchronisation : le choix reste", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const beta = await company("[TEST] Beta");
    const id = nextId();
    const c = await importCall(id, { participants: ["contact@acme-test.fr"] });
    expect(c.company_id).toBe(acme);
    await db.rpc("fireflies_link_call", { p_call: c.id, p_company: beta });

    await importCall(id, { participants: ["contact@acme-test.fr"], title: "[TEST] Modifié" }, 100);
    expect(await link(id)).toMatchObject({ company_id: beta, link_source: "manual", title: "[TEST] Modifié" });
    await db.as("anon");
    await db.rpc("fireflies_rematch", { p_server_key: KEY, p_limit: 50 });
    expect(await link(id)).toMatchObject({ company_id: beta, link_source: "manual" });
  });

  test("appel ignoré : le reste après un nouvel import ; « annuler mon choix » rend la main aux règles", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const id = nextId();
    const c = await importCall(id, { participants: ["contact@acme-test.fr"] });
    await db.rpc("fireflies_ignore_call", { p_call: c.id });
    expect(await activities(acme)).toEqual([]);
    await importCall(id, { participants: ["contact@acme-test.fr"] }, 100);
    expect(await link(id)).toMatchObject({ link_state: "ignored", company_id: null });
    await db.rpc("fireflies_reset_call_link", { p_call: c.id });
    expect(await link(id)).toMatchObject({ link_state: "linked", link_source: "email", company_id: acme });
  });

  test("garde-fous : fiche fusionnée, personne d'une autre fiche, rendez-vous d'une autre fiche", async () => {
    const a = await company("[TEST] A", ["a@a-test.fr"]);
    const b = await company("[TEST] B", ["b@b-test.fr"]);
    const merged = await company("[TEST] C");
    await db.as("owner");
    await db.rpc("merge_companies", { p_keep: a, p_merge: merged, p_fields: "{}", p_pipeline_from: "keep" });
    const c = await importCall(nextId());
    const bookingA = await booking({ email: "a@a-test.fr", company: a });
    await db.as("owner");
    const personB = (await db.one<{ id: string }>(`select id from people where company_id = $1`, [b])).id;
    await expect(db.rpc("fireflies_link_call", { p_call: c.id, p_company: merged })).rejects.toThrow(/Fiche introuvable/);
    await expect(db.rpc("fireflies_link_call", { p_call: c.id, p_company: a, p_person: personB })).rejects.toThrow(/n'appartient pas/);
    await expect(db.rpc("fireflies_link_call", { p_call: c.id, p_company: b, p_booking: bookingA })).rejects.toThrow(/autre fiche/);
  });

  test("droits : ni visiteur, ni autre compte, ni connecteur Claude", async () => {
    const a = await company("[TEST] A");
    const c = await importCall(nextId());
    await db.as("anon");
    for (const [fn, args] of [
      ["fireflies_link_call", { p_call: c.id, p_company: a }],
      ["fireflies_ignore_call", { p_call: c.id }],
      ["fireflies_reset_call_link", { p_call: c.id }],
      ["fireflies_set_own_addresses", { p_emails: [], p_domains: [] }],
    ] as const) await expect(db.rpc(fn, args)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("fireflies_rematch", {})).rejects.toThrow(/Accès refusé/);
    await db.as("stranger");
    await expect(db.rpc("fireflies_link_call", { p_call: c.id, p_company: a })).rejects.toThrow(/Accès refusé/);
    await db.as("claude");
    await expect(db.rpc("fireflies_ignore_call", { p_call: c.id })).rejects.toThrow(/réservée à l'application/);
    await expect(db.query(`select fireflies_private.is_technical_email('a@b.fr')`)).rejects.toThrow(/permission denied/);
  });
});

describe("activité sur la fiche", () => {
  test("une seule, même après plusieurs imports ; elle suit un déplacement ; rien de Fireflies dans le texte", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const beta = await company("[TEST] Beta");
    const id = nextId();
    const secret = "Titre confidentiel de l'appel";
    const c = await importCall(id, { title: secret, participants: ["contact@acme-test.fr"] });
    await importCall(id, { title: secret, participants: ["contact@acme-test.fr"] }, 10);
    await importCall(id, { title: secret, participants: ["contact@acme-test.fr"] }, 20);
    const list = await activities(acme);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "call", content: "Appel enregistré par Fireflies" });
    expect(JSON.stringify(list[0])).not.toContain(secret);

    await db.as("owner");
    await db.rpc("fireflies_link_call", { p_call: c.id, p_company: beta });
    expect(await activities(acme)).toEqual([]);
    expect((await activities(beta)).map((x) => x.id)).toEqual([list[0].id]);
    await db.exec("reset role;");
    expect((await db.one<{ d: string | null }>(`select last_interaction_at d from companies where id = $1`, [beta])).d).not.toBeNull();
  });

  test("appel puis « Rendez-vous réalisé » : une seule activité", async () => {
    const acme = await company("[TEST] Acme");
    const b = await booking({ email: "contact@acme-test.fr", company: acme, google: "evt1" });
    await importCall(nextId(), { cal_id: "evt1" });
    await db.as("owner");
    await db.rpc("appt_set_outcome", { p_id: b, p_outcome: "done" });
    const list = await activities(acme);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "meeting" });
    expect(list[0].meta.appointment_id).toBe(b);
  });

  test("« Rendez-vous réalisé » puis appel : réutilise l'activité existante, qui reste si l'appel part ailleurs", async () => {
    const acme = await company("[TEST] Acme");
    const beta = await company("[TEST] Beta");
    const b = await booking({ email: "contact@acme-test.fr", company: acme, google: "evt2" });
    await db.as("owner");
    await db.rpc("appt_set_outcome", { p_id: b, p_outcome: "done" });
    const id = nextId();
    const c = await importCall(id, { cal_id: "evt2" });
    const list = await activities(acme);
    expect(list).toHaveLength(1);
    expect(list[0].content).toMatch(/^Rendez-vous réalisé/);
    expect(list[0].id).toBe(c.interaction_id);

    await db.as("owner");
    await db.rpc("fireflies_link_call", { p_call: c.id, p_company: beta });
    expect((await activities(acme)).map((x) => x.content)).toEqual([list[0].content]);
    expect((await activities(acme))[0].meta.fireflies_call_id).toBeUndefined();
    expect(await activities(beta)).toHaveLength(1);
    expect((await link(id)).booking_id).toBeNull();
  });

  test("deux enregistrements du même rendez-vous : le second reste un simple appel", async () => {
    const acme = await company("[TEST] Acme");
    await booking({ email: "contact@acme-test.fr", company: acme, google: "evt3" });
    await importCall(nextId(), { cal_id: "evt3" });
    await importCall(nextId(), { cal_id: "evt3" });
    expect((await activities(acme)).map((x) => x.kind).sort()).toEqual(["call", "meeting"]);
  });

  test("le rendez-vous retrouve son compte rendu", async () => {
    const acme = await company("[TEST] Acme");
    const b = await booking({ email: "contact@acme-test.fr", company: acme, google: "evt4" });
    const id = nextId();
    await importCall(id, { cal_id: "evt4" });
    await db.as("owner");
    const r = await db.query<{ fireflies_id: string; transcript_url: string }>(`select fireflies_id, transcript_url from fireflies_calls where booking_id = $1`, [b]);
    expect(r.rows).toEqual([{ fireflies_id: id, transcript_url: `https://app.fireflies.ai/view/${id}` }]);
  });
});

describe("cycle de vie des fiches", () => {
  test("fusion : les appels et les choix manuels suivent la fiche conservée, une seule activité", async () => {
    const keep = await company("[TEST] Garde");
    const gone = await company("[TEST] Fusionnée", ["c@f-test.fr"]);
    const auto = nextId();
    const manual = nextId();
    await importCall(auto, { participants: ["c@f-test.fr"] });
    const m = await importCall(manual);
    await db.rpc("fireflies_link_call", { p_call: m.id, p_company: gone });
    await db.rpc("merge_companies", { p_keep: keep, p_merge: gone, p_fields: "{}", p_pipeline_from: "keep" });
    expect(await link(auto)).toMatchObject({ company_id: keep, link_source: "email" });
    expect(await link(manual)).toMatchObject({ company_id: keep, link_source: "manual" });
    expect(await activities(keep)).toHaveLength(2);
    expect(await activities(gone)).toEqual([]);
    await importCall(manual, {}, 50);
    expect(await link(manual)).toMatchObject({ company_id: keep, link_source: "manual" });
  });

  test("fusion : une fiche candidate est remplacée par la fiche conservée", async () => {
    const keep = await company("[TEST] Garde", ["x@g-test.fr"]);
    const gone = await company("[TEST] Fusionnée", ["y@g2-test.fr"]);
    const id = nextId();
    expect((await importCall(id, { participants: ["x@g-test.fr", "y@g2-test.fr"] })).link_candidates).toHaveLength(2);
    await db.as("owner");
    await db.rpc("merge_companies", { p_keep: keep, p_merge: gone, p_fields: "{}", p_pipeline_from: "keep" });
    expect(await link(id)).toMatchObject({ link_state: "linked", company_id: keep });
  });

  test("fiche supprimée : l'appel revient dans la file, avec sa transcription", async () => {
    const acme = await company("[TEST] Acme", ["contact@acme-test.fr"]);
    const id = nextId();
    const c = await importCall(id, { title: "Vrai titre d'appel", participants: ["contact@acme-test.fr"] });
    await db.exec(`reset role; delete from interactions where company_id = '${acme}'; delete from people where company_id = '${acme}'; delete from companies where id = '${acme}';`);
    expect(await link(id)).toMatchObject({ link_state: "to_link", company_id: null, link_source: null, interaction_id: null });
    await db.exec("reset role;");
    expect((await db.one<{ n: number }>(`select count(*)::int n from fireflies_call_transcripts where call_id = $1`, [c.id])).n).toBe(1);
  });

  test("un rattachement en erreur n'empêche pas d'enregistrer l'appel", async () => {
    await db.exec(`reset role; alter table people rename to people_cache;`);
    const c = await importCall(nextId(), { participants: ["x@y-test.fr"] });
    expect(c).toMatchObject({ link_state: "to_link", line_count: 1 });
    await db.exec(`reset role; alter table people_cache rename to people;`);
  });
});

describe("historique des appels", () => {
  test("liste d'une fiche : plus récents en premier, états, sans transcription", async () => {
    const acme = await company("[TEST] Acme", ["c@acme-test.fr"]);
    await importCall(nextId(), { title: "[TEST] Ancien", date: START_MS - 86_400_000, participants: ["c@acme-test.fr"] });
    await importCall(nextId(), { title: "[TEST] Récent", date: START_MS, participants: ["c@acme-test.fr"], summary: null, meeting_info: { summary_status: "processing", silent_meeting: false } });
    await db.as("owner");
    const { rows } = await db.query<Record<string, unknown>>(`select * from fireflies_call_list where company_id = $1 order by occurred_at desc nulls last`, [acme]);
    expect(rows.map((r) => [r.title, r.display_state, r.company_name])).toEqual([
      ["[TEST] Récent", "summary_pending", "[TEST] Acme"],
      ["[TEST] Ancien", "imported", "[TEST] Acme"],
    ]);
    expect(rows[0]).not.toHaveProperty("lines");
  });

  test("note interne : distincte du résumé, conservée à l'import suivant", async () => {
    const id = nextId();
    const c = await importCall(id);
    await db.rpc("fireflies_set_call_note", { p_call: c.id, p_note: "  Rappeler lundi  " });
    await importCall(id, { summary: { overview: "Nouveau résumé" } }, 10);
    const row = await db.one<{ internal_note: string; summary: { overview: string } }>(`select internal_note, summary from fireflies_call_list where id = $1`, [c.id]);
    expect(row).toEqual({ internal_note: "Rappeler lundi", summary: { overview: "Nouveau résumé" } });
    await db.rpc("fireflies_set_call_note", { p_call: c.id, p_note: "" });
    expect((await db.one<{ internal_note: string | null }>(`select internal_note from fireflies_call_list where id = $1`, [c.id])).internal_note).toBeNull();
  });

  test("portail client, visiteur, autre compte, connecteur Claude : ni liste, ni résumé, ni lien, ni transcription", async () => {
    const c = await importCall(nextId(), { summary: { overview: "Secret commercial" } });
    await db.as("anon");
    await expect(db.query(`select * from fireflies_call_list`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select * from fireflies_call_transcripts`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("fireflies_set_call_note", { p_call: c.id, p_note: "x" })).rejects.toThrow(/permission denied/);
    for (const who of ["stranger", "claude"] as const) {
      await db.as(who);
      expect((await db.query(`select * from fireflies_call_list`)).rows).toEqual([]);
      expect((await db.query(`select * from fireflies_call_transcripts`)).rows).toEqual([]);
      await expect(db.rpc("fireflies_set_call_note", { p_call: c.id, p_note: "x" })).rejects.toThrow(/Accès refusé|réservée/);
    }
  });

  test("aucune fonction du portail n'expose les tables Fireflies", async () => {
    await db.exec("reset role;");
    const { rows } = await db.query<{ proname: string }>(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosrc ilike '%fireflies%' and p.proname not like 'fireflies\\_%' and p.proname not like 'onboarding\\_%'
         and p.proname not in ('merge_preview', 'nav_counters')`);
    expect(rows).toEqual([]);
    // la préparation des projets, l'aperçu de fusion et le compteur du menu (comptes) lisent les appels, mais n'est ouverte qu'au propriétaire connecté
    const open = await db.query(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and (p.proname like 'onboarding\\_%' or p.proname in ('merge_preview', 'nav_counters')) and p.prosrc ilike '%fireflies%' and has_function_privilege('anon', p.oid, 'execute')`);
    expect(open.rows).toEqual([]);
  });

  test("import historique : une réunion connue ne repart pas, un choix manuel reste", async () => {
    const beta = await company("[TEST] Beta");
    const id = nextId();
    const c = await importCall(id);
    await db.rpc("fireflies_link_call", { p_call: c.id, p_company: beta });
    await db.as("anon");
    expect(await db.rpc("fireflies_enqueue", { p_server_key: KEY, p_meeting_id: id, p_event: "sync", p_reprocessed_at: null })).toBe("duplicate");
    expect(await db.rpc("fireflies_claim_jobs", { p_server_key: KEY, p_limit: 5 })).toEqual([]);
    expect(await link(id)).toMatchObject({ company_id: beta, link_source: "manual" });
  });
});
