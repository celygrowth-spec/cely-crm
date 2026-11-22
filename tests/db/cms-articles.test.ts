// CMS lot 1 en base : visibilité selon statut et date, publication unique, date passée, slugs et redirections 301,
// temps de lecture et date de mise à jour, droits (propriétaire seul, ni second compte, ni Claude, ni visiteur),
// corbeille (dépublier d'abord).
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
type Entry = { id: string; slug: string; status: string; publish_at: string | null; first_published_at: string | null; reading_minutes: number; content_updated_at: string };

const create = async (title: string, slug: string, extra: Record<string, unknown> = {}) => {
  const id = randomUUID();
  const cols = ["id", "title", "slug", ...Object.keys(extra)];
  const vals = [id, title, slug, ...Object.values(extra)];
  await db.query(`insert into cms_entries (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")})`, vals);
  return id;
};
const get = (id: string) => db.one<Entry>(`select * from cms_entries where id = $1`, [id]);
const visible = async (id: string) => (await db.one<{ v: boolean }>(`select cms_private.is_visible(status, publish_at) v from cms_entries where id = $1`, [id])).v;
const redirects = async () => (await db.query<{ from_slug: string; entry_id: string }>(`select from_slug, entry_id from cms_redirects order by from_slug`)).rows;

beforeEach(async () => {
  db = await createDb();
});

describe("visibilité", () => {
  test("visible si et seulement si programmé ou publié et date passée", async () => {
    const id = await create("Article", "article");
    expect(await visible(id)).toBe(false); // brouillon
    await db.query(`update cms_entries set status = 'scheduled', publish_at = now() + interval '10 minutes' where id = $1`, [id]);
    expect(await visible(id)).toBe(false); // programmé dans le futur
    await db.query(`update cms_entries set publish_at = now() - interval '1 second' where id = $1`, [id]);
    expect(await visible(id)).toBe(true); // programmé, date passée : visible sans passage planifié
    await db.rpc("cms_set_status", { p_id: id, p_status: "unpublished" });
    expect(await visible(id)).toBe(false);
    await db.query(`update cms_entries set status = 'published', publish_at = now() + interval '1 day' where id = $1`, [id]);
    expect(await visible(id)).toBe(false); // publié mais daté dans le futur : pas encore
  });

  test("un programmé ou publié sans date est refusé par la base", async () => {
    const id = await create("A", "a");
    await expect(db.query(`update cms_entries set status = 'scheduled' where id = $1`, [id])).rejects.toThrow(/cms_entries_date_check/);
  });

  test("passage automatique de Programmé à Publié", async () => {
    const due = await create("A", "a", { status: "scheduled", publish_at: new Date(Date.now() - 60_000).toISOString() });
    const later = await create("B", "b", { status: "scheduled", publish_at: new Date(Date.now() + 3600_000).toISOString() });
    expect(await db.rpc("cms_promote_due", {})).toBe(1);
    expect((await get(due)).status).toBe("published");
    expect((await get(later)).status).toBe("scheduled");
  });
});

describe("publication", () => {
  test("Publier maintenant : un double clic ne produit qu'une publication", async () => {
    const id = await create("A", "a");
    const [x, y] = [await db.rpc<{ already: boolean }>("cms_publish_now", { p_id: id }), await db.rpc<{ already: boolean }>("cms_publish_now", { p_id: id })];
    expect(x.already).toBe(false);
    expect(y.already).toBe(true);
    const e = await get(id);
    expect(e.status).toBe("published");
    expect(e.first_published_at).not.toBeNull();
  });

  test("programmer une date passée demande confirmation, puis publie aussitôt", async () => {
    const id = await create("A", "a");
    const past = new Date(Date.now() - 3600_000).toISOString();
    await expect(db.rpc("cms_schedule", { p_id: id, p_at: past, p_confirm_now: false })).rejects.toThrow(/past_date/);
    expect((await get(id)).status).toBe("draft");
    await db.rpc("cms_schedule", { p_id: id, p_at: past, p_confirm_now: true });
    expect(await visible(id)).toBe(true);
    const future = new Date(Date.now() + 600_000).toISOString();
    const other = await create("B", "b");
    await db.rpc("cms_schedule", { p_id: other, p_at: future });
    expect(await get(other)).toMatchObject({ status: "scheduled" });
    expect(await visible(other)).toBe(false);
  });
});

describe("slugs et redirections", () => {
  test("slug unique par type et bien formé", async () => {
    await create("A", "mon-article");
    await expect(create("B", "mon-article")).rejects.toThrow(/cms_entries_slug_key/);
    await expect(create("C", "Mon Article")).rejects.toThrow(/check constraint/);
  });

  test("slug changé sur un brouillon jamais publié : pas de redirection", async () => {
    const id = await create("A", "brouillon");
    await db.query(`update cms_entries set slug = 'brouillon-2' where id = $1`, [id]);
    expect(await redirects()).toEqual([]);
  });

  test("slug changé sur un article publié : l'ancien devient une redirection, sans chaîne", async () => {
    const id = await create("A", "v1");
    await db.rpc("cms_publish_now", { p_id: id });
    await db.query(`update cms_entries set slug = 'v2' where id = $1`, [id]);
    await db.query(`update cms_entries set slug = 'v3' where id = $1`, [id]);
    expect(await redirects()).toEqual([{ from_slug: "v1", entry_id: id }, { from_slug: "v2", entry_id: id }]);
    // revenir à un ancien slug retire sa redirection
    await db.query(`update cms_entries set slug = 'v1' where id = $1`, [id]);
    expect((await redirects()).map((r) => r.from_slug)).toEqual(["v2", "v3"]);
    // une ancienne adresse reste réservée à son article
    await expect(create("B", "v2")).rejects.toThrow(/ancienne adresse/);
  });

  test("un article dépublié garde ses redirections (il a été publié)", async () => {
    const id = await create("A", "a");
    await db.rpc("cms_publish_now", { p_id: id });
    await db.rpc("cms_set_status", { p_id: id, p_status: "unpublished" });
    await db.query(`update cms_entries set slug = 'b' where id = $1`, [id]);
    expect(await redirects()).toEqual([{ from_slug: "a", entry_id: id }]);
  });
});

describe("calculs automatiques", () => {
  test("temps de lecture et date de mise à jour", async () => {
    const id = await create("A", "a", { body_md: Array(450).fill("mot").join(" ") });
    const e = await get(id);
    expect(e.reading_minutes).toBe(3);
    await db.query(`select pg_sleep(0.01)`);
    await db.rpc("cms_publish_now", { p_id: id }); // un changement de statut n'est pas une mise à jour du contenu
    expect((await get(id)).content_updated_at).toEqual(e.content_updated_at);
    await db.query(`update cms_entries set excerpt = 'Nouveau' where id = $1`, [id]);
    expect(new Date((await get(id)).content_updated_at).getTime()).toBeGreaterThan(new Date(e.content_updated_at).getTime());
  });
});

describe("droits", () => {
  test("second compte, Claude et visiteur : ni lecture ni écriture", async () => {
    const id = await create("A", "a");
    await db.as("stranger");
    expect((await db.query(`select * from cms_entries`)).rows).toEqual([]);
    await expect(db.query(`insert into cms_entries (title, slug) values ('x', 'x')`)).rejects.toThrow(/row-level security/);
    await expect(db.rpc("cms_publish_now", { p_id: id })).rejects.toThrow(/Accès refusé/);
    await db.as("claude");
    await expect(db.query(`insert into cms_entries (title, slug) values ('x', 'x')`)).rejects.toThrow(/row-level security/);
    await expect(db.rpc("cms_publish_now", { p_id: id })).rejects.toThrow(/Accès refusé/);
    const upd = await db.query(`update cms_entries set title = 'piraté' where id = $1`, [id]);
    expect(upd.affectedRows).toBe(0);
    await db.as("anon");
    await expect(db.query(`select * from cms_entries`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("cms_promote_due_server", { p_server_key: "x".repeat(40) })).rejects.toThrow(/Accès refusé/);
    await db.as("owner");
    expect((await get(id)).slug).toBe("a");
  });
});

describe("corbeille", () => {
  test("un article publié doit d'abord être dépublié ; ensuite il part à la corbeille et revient", async () => {
    const id = await create("A", "a");
    await db.rpc("cms_publish_now", { p_id: id });
    const preview = await db.rpc<{ warnings: string[] }>("trash_preview", { p_kind: "cms_entry", p_id: id });
    expect(JSON.stringify(preview)).toMatch(/dépubliez/i);
    await expect(db.rpc("trash_put", { p_kind: "cms_entry", p_id: id })).rejects.toThrow(/Dépubliez/);
    await db.rpc("cms_set_status", { p_id: id, p_status: "unpublished" });
    const put = await db.rpc<{ trash_id: string }>("trash_put", { p_kind: "cms_entry", p_id: id });
    expect((await db.query(`select id from cms_entries`)).rows).toEqual([]);
    await db.rpc("trash_restore", { p_trash: put.trash_id, p_with_parent: false });
    expect((await get(id)).status).toBe("unpublished");
  });
});
