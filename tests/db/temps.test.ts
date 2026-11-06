// Suivi du temps en base : un seul chrono, heure du serveur, « arrêter et démarrer », double clic et
// deux onglets, fusion de fiches, accès réservé au propriétaire dans l'application.
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
let a: string;
let b: string;
beforeEach(async () => {
  db = await createDb();
  a = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Client A" }, p_people: [], p_force: true })).id;
  b = (await db.rpc<{ id: string }>("create_company", { p_company: { name: "Client B" }, p_people: [], p_force: true })).id;
});
type R = { status: string; running?: { id: string; company_name: string }; stopped?: { id: string; company_name: string; ended_at: string } | null };
const start = (company: string, sw = false, label: string | null = null) => db.rpc<R>("time_start", { p_company: company, p_label: label, p_switch: sw });
const running = async () => (await db.query<{ company_id: string }>(`select company_id from time_entries where ended_at is null`)).rows;

describe("chrono", () => {
  test("démarrer, double clic (même client) : un seul chrono ; arrêter deux fois : une seule session", async () => {
    expect((await start(a, false, "Audit SEO")).status).toBe("started");
    expect((await start(a)).status).toBe("running");
    expect(await running()).toEqual([{ company_id: a }]);
    expect((await db.rpc<R>("time_stop", {})).status).toBe("stopped");
    expect((await db.rpc<R>("time_stop", {})).status).toBe("none"); // deuxième onglet
    expect((await db.one<{ n: number }>(`select count(*)::int n from time_entries`)).n).toBe(1);
  });

  test("autre client : conflit sans rien modifier, puis « arrêter et démarrer » enregistre la première session", async () => {
    const first = (await start(a)).running!.id;
    const c = await start(b);
    expect(c.status).toBe("conflict");
    expect(c.running?.company_name).toBe("Client A");
    expect(await running()).toEqual([{ company_id: a }]);
    const sw = await start(b, true);
    expect(sw.status).toBe("started");
    expect(sw.stopped?.id).toBe(first);
    expect(await running()).toEqual([{ company_id: b }]);
    expect((await db.one<{ ended: boolean }>(`select ended_at is not null as ended from time_entries where id = $1`, [first])).ended).toBe(true);
  });

  test("la base refuse un deuxième chrono en cours, même par écriture directe", async () => {
    await start(a);
    await expect(db.query(`insert into time_entries (company_id, started_at, source) values ($1, now(), 'timer')`, [b])).rejects.toThrow(/time_entries_one_running/);
  });

  test("correction d'un oubli : heure de fin modifiable ; fin avant le début refusée", async () => {
    await start(a);
    const s = (await db.rpc<R>("time_stop", {})).stopped!;
    await db.query(`update time_entries set started_at = now() - interval '12 hours', ended_at = now() - interval '10 hours' where id = $1`, [s.id]);
    expect((await db.one<{ h: number }>(`select extract(epoch from ended_at - started_at)::int / 3600 as h from time_entries where id = $1`, [s.id])).h).toBe(2);
    await expect(db.query(`update time_entries set ended_at = started_at - interval '1 minute' where id = $1`, [s.id])).rejects.toThrow(/check constraint/);
  });

  test("fusion de fiches : le temps suit la fiche conservée", async () => {
    await db.query(`insert into time_entries (company_id, started_at, ended_at, source) values ($1, now() - interval '1 hour', now(), 'manual')`, [b]);
    await db.query("reset role");
    await db.query(`update companies set merged_into_id = $1 where id = $2`, [a, b]);
    expect((await db.one<{ company_id: string }>(`select company_id from time_entries`)).company_id).toBe(a);
  });

  test("portail (anon), autre compte et Claude : aucun accès", async () => {
    await start(a);
    await db.as("anon");
    await expect(db.query(`select * from time_entries`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("time_start", { p_company: a, p_label: null, p_switch: true })).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select * from time_entries`)).rows).toEqual([]);
    await expect(start(b, true)).rejects.toThrow(/Accès refusé/);
    await db.as("claude");
    expect((await db.query(`select * from time_entries`)).rows).toEqual([]);
    await expect(db.rpc("time_stop", {})).rejects.toThrow(/réservé à l'application/);
  });
});
