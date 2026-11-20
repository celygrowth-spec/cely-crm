// Tracking site · lot 2 : liens du Générateur de liens UTM (convention imposée, pas de doublon, propriétaire seul).
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

let db: Db;
beforeEach(async () => { db = await createDb(); });

const LINK = { name: "Post LinkedIn lancement", path: "/services", utm_source: "linkedin", utm_medium: "post", utm_campaign: "lancement", url: "https://www.celygrowth.com/services?utm_source=linkedin&utm_medium=post&utm_campaign=lancement" };

describe("liens UTM", () => {
  test("enregistrer deux fois le même lien n'en crée qu'un ; le nom est mis à jour", async () => {
    const a = await db.rpc<{ id: string }>("site_utm_link_save", { p: LINK });
    const b = await db.rpc<{ id: string; name: string }>("site_utm_link_save", { p: { ...LINK, name: "Post du 12" } });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.id).toBe(a.id);
    expect((await db.query(`select name, utm_content from site_utm_links`)).rows).toEqual([{ name: "Post du 12", utm_content: null }]);
  });
  test("convention de nommage imposée en base : majuscules, accents et espaces refusés", async () => {
    for (const bad of [{ utm_source: "LinkedIn" }, { utm_campaign: "offre découverte" }, { utm_medium: "" }, { name: " " }, { path: "services" }]) {
      await expect(db.rpc("site_utm_link_save", { p: { ...LINK, ...bad, url: LINK.url + "&x=1" } })).rejects.toThrow(/Lien invalide/);
    }
    expect((await db.query(`select 1 from site_utm_links`)).rows).toEqual([]);
  });
  test("anonyme et autre compte : ni lecture ni écriture ; Claude ne supprime pas", async () => {
    const { id } = await db.rpc<{ id: string }>("site_utm_link_save", { p: LINK });
    await db.as("anon");
    await expect(db.query(`select * from site_utm_links`)).rejects.toThrow(/permission denied/);
    await expect(db.rpc("site_utm_link_save", { p: LINK })).rejects.toThrow(/permission denied/);
    await db.as("stranger");
    expect((await db.query(`select * from site_utm_links`)).rows).toEqual([]);
    await expect(db.rpc("site_utm_link_save", { p: LINK })).rejects.toThrow();
    await expect(db.rpc("site_utm_link_delete", { p_id: id })).rejects.toThrow();
    await expect(db.query(`insert into site_utm_links (name, path, utm_source, utm_medium, utm_campaign, url) values ('x', '/', 'a', 'b', 'c', 'https://x')`)).rejects.toThrow(/permission denied/);
    await db.as("claude");
    await expect(db.rpc("site_utm_link_delete", { p_id: id })).rejects.toThrow(/réservée/);
    await db.as("owner");
    await db.rpc("site_utm_link_delete", { p_id: id });
    expect((await db.query(`select 1 from site_utm_links`)).rows).toEqual([]);
  });
});
