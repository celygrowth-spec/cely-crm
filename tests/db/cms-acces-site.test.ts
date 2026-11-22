// CMS lot 5 en base : accès en lecture du site. Jamais de brouillon, de programmé futur, de dépublié ni d'article à
// la corbeille ; redirections vers des articles visibles seulement ; aperçu avec jeton valide ; clé serveur exigée ;
// limite d'abus.
import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, test } from "vitest";
import { createDb, type Db } from "./harness";

const KEY = "cle-serveur-de-test-suffisamment-longue-0123456789";
let db: Db;
type R = Record<string, unknown>;
const read = (what: string, args: R = {}, rate = "ip-test") => db.rpc<R>("cms_site_read", { p_server_key: KEY, p_what: what, p_args: JSON.stringify(args), p_rate: rate });
const slugs = async () => ((await read("list", { limit: 100 })).items as { slug: string }[]).map((i) => i.slug).sort();
const create = async (slug: string, status = "draft", at: string | null = null) => {
  const id = randomUUID();
  await db.query(`insert into cms_entries (id, title, slug, body_md, status, publish_at) values ($1, $2, $2, 'Corps de ' || $2, $3, $4)`, [id, slug, status, at]);
  return id;
};
const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 600_000).toISOString();

beforeEach(async () => {
  db = await createDb();
  await db.rpc("appt_register_server_key", { p_hash: createHash("sha256").update(KEY).digest("hex") });
});

describe("filtrage", () => {
  test("seuls les articles programmés ou publiés dont la date est passée sortent", async () => {
    await create("brouillon");
    await create("brouillon-date", "draft", past());
    await create("futur", "scheduled", future());
    await create("programme-passe", "scheduled", past());
    await create("publie", "published", past());
    await create("publie-futur", "published", future());
    const dep = await create("depublie", "published", past());
    await db.rpc("cms_set_status", { p_id: dep, p_status: "unpublished" });
    const trashed = await create("corbeille", "published", past());
    await db.rpc("cms_set_status", { p_id: trashed, p_status: "unpublished" });
    await db.rpc("trash_put", { p_kind: "cms_entry", p_id: trashed });
    await db.as("anon");
    expect(await slugs()).toEqual(["programme-passe", "publie"]);
    for (const s of ["brouillon", "brouillon-date", "futur", "publie-futur", "depublie", "corbeille", "inconnu"]) {
      expect(await read("entry", { slug: s }), s).toEqual({ not_found: true });
    }
    const one = (await read("entry", { slug: "publie" })).entry as R;
    expect(one).toMatchObject({ slug: "publie", body_md: "Corps de publie", noindex: false });
    expect(Object.keys(one)).not.toContain("status");
    const list = await read("list");
    expect((list.items as R[])[0]).not.toHaveProperty("body_md");
    expect(list.total).toBe(2);
    expect(list.next_change_at).not.toBeNull(); // une heure seulement, aucun contenu
    expect(JSON.stringify(list)).not.toMatch(/futur/);
    expect((await read("sitemap")).entries).toHaveLength(2);
  });

  test("l'article programmé apparaît à son heure, pas avant", async () => {
    const id = await create("bientot", "scheduled", new Date(Date.now() + 2000).toISOString());
    await db.as("anon");
    expect(await read("entry", { slug: "bientot" })).toEqual({ not_found: true });
    await new Promise((r) => setTimeout(r, 2200));
    expect((await read("entry", { slug: "bientot" })).entry).toMatchObject({ slug: "bientot" });
    void id;
  });

  test("noindex : article lisible mais absent du sitemap ; pages « ne pas indexer » listées", async () => {
    const id = await create("cache", "published", past());
    await db.query(`update cms_entries set noindex = true where id = $1`, [id]);
    await db.query(`insert into cms_pages (path, seo_title, noindex) values ('/merci', null, true), ('/', 'Accueil', null)`);
    await db.as("anon");
    expect((await read("entry", { slug: "cache" })).entry).toMatchObject({ noindex: true });
    expect(await read("sitemap")).toEqual({ entries: [], noindex_pages: ["/merci"] });
    // un champ vide n'est pas renvoyé : le site garde sa valeur
    expect(await read("pages")).toEqual({ pages: [{ path: "/", seo_title: "Accueil" }, { path: "/merci", noindex: true }] });
  });
});

describe("redirections", () => {
  test("ancien slug → slug actuel, seulement si l'article est visible", async () => {
    const id = await create("v1", "published", past());
    await db.query(`update cms_entries set slug = 'v2' where id = $1`, [id]);
    await db.as("anon");
    expect(await read("entry", { slug: "v1" })).toEqual({ redirect: "v2" });
    expect(await read("redirects")).toEqual({ redirects: [{ type: "article", from: "v1", to: "v2" }] });
    await db.as("owner");
    await db.rpc("cms_set_status", { p_id: id, p_status: "unpublished" });
    await db.as("anon");
    expect(await read("entry", { slug: "v1" })).toEqual({ not_found: true });
    expect(await read("redirects")).toEqual({ redirects: [] });
  });
});

describe("aperçu", () => {
  test("jeton valide : le brouillon ; jeton faux, expiré ou article à la corbeille : rien", async () => {
    const id = await create("secret");
    const hash = createHash("sha256").update("jeton-de-test").digest("hex");
    await db.rpc("cms_preview_create", { p_entry: id, p_token_hash: hash, p_hours: 1 });
    await db.as("anon");
    expect(await read("preview", { token_hash: hash })).toMatchObject({ status: "draft", entry: { slug: "secret" } });
    expect(await read("preview", { token_hash: "0".repeat(64) })).toEqual({ not_found: true });
    expect(await read("entry", { slug: "secret" })).toEqual({ not_found: true }); // sans jeton : invisible
    await db.exec("reset role");
    await db.query(`update cms_preview_tokens set expires_at = now() - interval '1 second', created_at = now() - interval '1 hour'`);
    await db.as("anon");
    expect(await read("preview", { token_hash: hash })).toEqual({ not_found: true });
  });
});

describe("accès", () => {
  test("clé serveur fausse ou absente : refus ; tables illisibles pour un visiteur ; aucune écriture possible", async () => {
    await create("publie", "published", past());
    await db.as("anon");
    for (const k of ["x".repeat(50), "", KEY.slice(0, -1) + "x"]) {
      await expect(db.rpc("cms_site_read", { p_server_key: k, p_what: "list", p_args: "{}", p_rate: "a" })).rejects.toThrow(/Accès refusé/);
    }
    for (const t of ["cms_entries", "cms_redirects", "cms_pages", "cms_preview_tokens", "cms_revalidations", "cms_media"]) {
      await expect(db.query(`select * from ${t}`), t).rejects.toThrow(/permission denied/);
    }
    await expect(db.rpc("cms_publish_now", { p_id: randomUUID() })).rejects.toThrow(/permission denied|Accès refusé/);
    expect(await read("list", { type: "inconnu" })).toEqual({ error: "unknown_type" });
    expect(await read("autre")).toEqual({ error: "unknown_request" });
  });

  test("limite d'abus par adresse ; les refus de clé sont comptés à part", async () => {
    // compteurs préremplis pour la minute en cours et la suivante : le test ne dépend pas d'un changement de minute
    await db.exec("reset role");
    for (const [bucket, n] of [["cms:ip-bavarde", 600], ["cms-denied:ip-qui-devine", 20]] as const) {
      await db.query(`insert into site_rate (bucket, minute, n) select $1, m, $2 from (values (date_trunc('minute', now())), (date_trunc('minute', now()) + interval '1 minute')) v(m)`, [bucket, n]);
    }
    await db.as("anon");
    expect(await read("pages", {}, "ip-bavarde")).toEqual({ error: "rate_limited" }); // 601e appel de la minute
    expect(await read("pages", {}, "autre-ip")).toEqual({ pages: [] });
    expect(await db.rpc<boolean>("cms_site_denied", { p_server_key: KEY, p_rate: "ip-qui-devine" })).toBe(false); // 21e refus
    expect(await db.rpc<boolean>("cms_site_denied", { p_server_key: KEY, p_rate: "autre-ip" })).toBe(true);
  });
});
