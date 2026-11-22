// CMS lot 4 en base : demandes de rafraîchissement du site (quand, fusion, reprises, résolution), aperçus 24 h,
// passage planifié « contenus ».
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
type Reval = { id: string; status: string; tags: string[]; reasons: string[]; attempts: number; next_attempt_at: Date };
const revals = async () => (await db.query<Reval>(`select * from cms_revalidations order by created_at`)).rows;
const create = async (slug: string, extra = "") => {
  const id = randomUUID();
  await db.query(`insert into cms_entries (id, title, slug${extra ? ", status, publish_at" : ""}) values ($1, $2, $3${extra ? `, ${extra}` : ""})`, [id, slug, slug]);
  return id;
};
const admin = async (sql: string, params: unknown[] = []) => { await db.exec("reset role"); try { return await db.query(sql, params); } finally { await db.as("owner"); } };
const claim = () => db.rpc<{ ids: string[]; tags: string[]; reasons: string[] } | null>("cms_revalidation_claim", {});
const report = (ids: string[], ok: boolean, err: string | null = null) => db.rpc("cms_revalidation_report", { p_ids: ids, p_ok: ok, p_error: err });

beforeEach(async () => {
  db = await createDb();
});

describe("quand le site doit-il être rafraîchi ?", () => {
  test("brouillon et programmé dans le futur : jamais ; publication, modification, retrait : oui", async () => {
    const id = await create("a");
    await db.query(`update cms_entries set body_md = 'x' where id = $1`, [id]);
    await db.rpc("cms_schedule", { p_id: id, p_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(await revals()).toEqual([]);
    await db.rpc("cms_publish_now", { p_id: id });
    await db.rpc("cms_publish_now", { p_id: id }); // double clic : rien de plus
    let r = await revals();
    expect(r).toHaveLength(1);
    expect(r[0].tags).toEqual(expect.arrayContaining(["cms", "cms:articles", "cms:sitemap", "cms:article:a"]));
    await db.query(`update cms_entries set excerpt = 'nouveau' where id = $1`, [id]);
    await db.query(`update cms_entries set slug = 'b' where id = $1`, [id]);
    await db.rpc("cms_set_status", { p_id: id, p_status: "unpublished" });
    r = await revals();
    expect(r).toHaveLength(1); // fusionnées en une seule demande en attente
    expect(r[0].tags).toEqual(expect.arrayContaining(["cms:article:a", "cms:article:b", "cms:redirections"]));
    expect(r[0].reasons.join(" | ")).toMatch(/publication : a.*modification : a.*modification : b.*retrait : b/);
  });

  test("passage de Programmé à Publié : demande de rafraîchissement", async () => {
    await create("p", `'scheduled', now() - interval '1 minute'`);
    await admin(`delete from cms_revalidations`);
    expect(await db.rpc("cms_promote_due", {})).toBe(1);
    expect(await revals()).toHaveLength(1);
  });

  test("pages SEO : un réglage oui, le seul libellé non", async () => {
    await db.query(`insert into cms_pages (path, label) values ('/', 'Accueil')`);
    await admin(`delete from cms_revalidations`);
    await db.query(`update cms_pages set label = 'Home'`);
    expect(await revals()).toEqual([]);
    await db.query(`update cms_pages set seo_title = 'T'`);
    expect((await revals())[0].tags).toEqual(expect.arrayContaining(["cms:pages", "cms:page:/"]));
  });
});

describe("envoi, reprises et résolution", () => {
  test("échec : délai croissant, reste visible ; réussite plus tard : tout est résolu", async () => {
    const id = await create("a");
    await db.rpc("cms_publish_now", { p_id: id });
    const c1 = await claim();
    expect(c1!.tags).toContain("cms");
    expect(await claim()).toBeNull(); // déjà pris : pas d'envoi en double
    await report(c1!.ids, false, "Site injoignable.");
    let r = (await revals())[0];
    expect(r).toMatchObject({ status: "failed", attempts: 1 });
    expect(r.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(await claim()).toBeNull(); // pas encore dû
    expect(await db.rpc("cms_revalidation_retry", {})).toBe(1); // « Réessayer »
    const c2 = await claim();
    await report(c2!.ids, false, "Le site a répondu 500.");
    r = (await revals())[0];
    expect(r.attempts).toBe(2);
    // une nouvelle modification crée une nouvelle demande ; sa réussite résout aussi l'échec plus ancien
    await db.query(`update cms_entries set excerpt = 'x' where id = $1`, [id]);
    const pending = (await revals()).find((x) => x.status === "pending")!;
    const c3 = await claim();
    expect(c3!.ids).toEqual([pending.id]);
    await report(c3!.ids, true);
    expect((await revals()).map((x) => x.status)).toEqual(["ok", "ok"]);
  });

  test("passage planifié : clé serveur exigée ; second compte et visiteur refusés", async () => {
    await db.as("anon");
    await expect(db.rpc("cms_revalidation_claim", { p_server_key: "x".repeat(43) })).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("cms_revalidation_claim", {})).rejects.toThrow(/Accès refusé/);
    await db.as("stranger");
    await expect(db.rpc("cms_revalidation_claim", {})).rejects.toThrow(/Accès refusé/);
    await expect(db.rpc("cms_revalidation_retry", {})).rejects.toThrow(/Accès refusé/);
    expect((await db.query(`select * from cms_revalidations`)).rows).toEqual([]);
  });

  test("la tâche « contenus » est acceptée par le suivi des passages", async () => {
    await db.exec("reset role");
    await db.query(`insert into scheduled_jobs (job) values ('contenus')`);
    await db.as("owner");
  });
});

describe("aperçu", () => {
  test("24 h au plus, propriétaire seul, retrait", async () => {
    const id = await create("brouillon");
    const hash = "a".repeat(64);
    const exp = await db.rpc<string>("cms_preview_create", { p_entry: id, p_token_hash: hash, p_hours: 24 });
    expect(new Date(exp).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600_000 + 1000);
    await expect(db.rpc("cms_preview_create", { p_entry: id, p_token_hash: "b".repeat(64), p_hours: 25 })).rejects.toThrow(/24 heures/);
    await expect(db.query(`insert into cms_preview_tokens (token_hash, entry_id, expires_at) values ($1, $2, now() + interval '1 hour')`, ["c".repeat(64), id])).rejects.toThrow(/row-level security/);
    await expect(admin(`insert into cms_preview_tokens (token_hash, entry_id, expires_at) values ($1, $2, now() + interval '2 days')`, ["c".repeat(64), id])).rejects.toThrow(/check constraint/);
    await db.as("stranger");
    await expect(db.rpc("cms_preview_create", { p_entry: id, p_token_hash: "d".repeat(64), p_hours: 1 })).rejects.toThrow(/Accès refusé/);
    await db.as("owner");
    expect(await db.rpc("cms_preview_revoke", { p_entry: id })).toBe(1);
  });
});
