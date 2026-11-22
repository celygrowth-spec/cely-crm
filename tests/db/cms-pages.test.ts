// CMS lot 3 en base : pages SEO par chemin, champ vide = valeur du site, import en lot sans toucher aux réglages.
import { beforeEach, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => {
  db = await createDb();
});
type Page = { path: string; label: string | null; seo_title: string | null; noindex: boolean | null; site_defaults: Record<string, unknown> };
const pages = async () => (await db.query<Page>(`select path, label, seo_title, noindex, site_defaults from cms_pages order by path`)).rows;

test("chemin bien formé et unique ; champ vide enregistré comme vide (valeur du site)", async () => {
  await db.query(`insert into cms_pages (path, seo_title) values ('/offres', '   ')`);
  expect((await pages())[0]).toMatchObject({ path: "/offres", seo_title: null, noindex: null });
  for (const bad of ["offres", "/offres/", "/offres?x=1", "/a b", "/#x"]) {
    await expect(db.query(`insert into cms_pages (path) values ($1)`, [bad]), bad).rejects.toThrow(/check constraint/);
  }
  await expect(db.query(`insert into cms_pages (path) values ('/offres')`)).rejects.toThrow(/duplicate key/);
});

test("import en lot : crée, met à jour libellé et valeurs du site, ne touche jamais aux réglages du CMS", async () => {
  await db.query(`insert into cms_pages (path, label, seo_title, noindex) values ('/offres', 'Offres', 'Mon title', true)`);
  const r = await db.rpc("cms_pages_import", { p_pages: JSON.stringify([
    { path: "/", label: "Accueil", defaults: { title: "Cely Growth", noindex: false } },
    { path: "/offres", label: "Nos offres", defaults: { title: "Offres du code" } },
  ]) });
  expect(r).toEqual({ created: 1, updated: 1, unchanged: 0 });
  expect(await pages()).toEqual([
    { path: "/", label: "Accueil", seo_title: null, noindex: null, site_defaults: { title: "Cely Growth", noindex: false } },
    { path: "/offres", label: "Nos offres", seo_title: "Mon title", noindex: true, site_defaults: { title: "Offres du code" } },
  ]);
  const again = await db.rpc("cms_pages_import", { p_pages: JSON.stringify([{ path: "/", label: "Accueil", defaults: { title: "Cely Growth", noindex: false } }]) });
  expect(again).toEqual({ created: 0, updated: 0, unchanged: 1 });
  // tout ou rien : un chemin invalide annule l'import
  await expect(db.rpc("cms_pages_import", { p_pages: JSON.stringify([{ path: "/ok" }, { path: "pas-un-chemin" }]) })).rejects.toThrow(/check constraint/);
  expect((await pages()).map((p) => p.path)).toEqual(["/", "/offres"]);
});

test("second compte, Claude et visiteur : ni lecture ni écriture", async () => {
  await db.query(`insert into cms_pages (path) values ('/')`);
  for (const who of ["stranger", "claude"] as const) {
    await db.as(who);
    await expect(db.rpc("cms_pages_import", { p_pages: "[]" })).rejects.toThrow(/Accès refusé/);
    expect((await db.query(`update cms_pages set seo_title = 'piraté' returning id`)).rows).toEqual([]);
    await expect(db.query(`insert into cms_pages (path) values ('/x')`)).rejects.toThrow(/row-level security/);
  }
  await db.as("anon");
  await expect(db.query(`select * from cms_pages`)).rejects.toThrow(/permission denied/);
});
