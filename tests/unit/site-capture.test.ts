// Capture du site du prospect par le serveur : domaine de la fiche seulement, adresses internes refusées
// (y compris après redirection), délai et taille bornés, échecs signalés sans jamais interrompre le diagnostic.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import {
  SITE_LIMITS, allowedUrl, captureSite, guardedLookup, htmlToText, httpFetchOnce, isPublicAddress, keyLinks, siteTarget,
  type FetchOnce, type RawResponse,
} from "@/lib/crm/site-capture";

const html = (title: string, body: string) => Buffer.from(`<html><head><title>${title}</title><style>.x{}</style></head><body>${body}<script>alert(1)</script></body></html>`);
const ok = (body: Buffer, contentType = "text/html; charset=utf-8"): RawResponse => ({ status: 200, location: null, contentType, body, truncated: false });
const redirect = (location: string): RawResponse => ({ status: 301, location, contentType: "", body: Buffer.alloc(0), truncated: false });
const LONG = "Cabinet de conseil en croissance commerciale pour les PME industrielles. ".repeat(8);

/** Faux réseau : une réponse par adresse ; les adresses inconnues échouent comme un domaine introuvable. */
function fake(routes: Record<string, RawResponse | (() => Promise<RawResponse>)>): FetchOnce & { seen: string[] } {
  const seen: string[] = [];
  const f = (async (url: URL) => {
    seen.push(url.href);
    const r = routes[url.href];
    if (!r) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return typeof r === "function" ? r() : r;
  }) as unknown as FetchOnce & { seen: string[] };
  f.seen = seen;
  return f;
}

describe("adresses", () => {
  test("adresses internes, privées, locales ou réservées refusées ; publiques acceptées", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
      "::1", "::", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "pas-une-ip"])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(a), a).toBe(true);
  });

  test("la résolution utilisée à la connexion refuse un nom qui pointe vers une adresse locale", async () => {
    const err = await new Promise<Error | null>((resolve) => (guardedLookup as unknown as (h: string, o: object, cb: (e: Error | null) => void) => void)("localhost", {}, resolve));
    expect(err?.message).toMatch(/interne ou privée/);
  });
});

describe("domaine de la fiche", () => {
  test("adresse de départ et domaine autorisé, avec ou sans protocole ni www", () => {
    expect(siteTarget("1-one.fr")).toMatchObject({ domain: "1-one.fr" });
    expect(siteTarget("1-one.fr").url.href).toBe("https://1-one.fr/");
    expect(siteTarget("https://www.1-one.fr/offres#x").url.href).toBe("https://www.1-one.fr/offres");
    expect(siteTarget("http://www.1-one.fr").domain).toBe("1-one.fr");
  });

  test("protocole, port, adresse IP, domaine local ou champ vide refusés", () => {
    expect(() => siteTarget("ftp://1-one.fr")).toThrow(/http et https/);
    expect(() => siteTarget("file:///etc/passwd")).toThrow(/http et https/);
    expect(() => siteTarget("http://127.0.0.1")).toThrow(/adresse IP/);
    expect(() => siteTarget("http://[::1]/")).toThrow(/adresse IP/);
    expect(() => siteTarget("https://1-one.fr:8443")).toThrow(/port/);
    expect(() => siteTarget("localhost")).toThrow(/non public/);
    expect(() => siteTarget("serveur.local")).toThrow(/non public/);
    expect(() => siteTarget("  ")).toThrow(/pas de site/);
  });

  test("sous-domaines acceptés, domaines voisins refusés", () => {
    const yes = (u: string) => allowedUrl(new URL(u), "1-one.fr");
    expect(yes("https://site.1-one.fr/a")).toBe(true);
    expect(yes("http://1-one.fr/")).toBe(true);
    expect(yes("https://evil-1-one.fr/")).toBe(false);
    expect(yes("https://1-one.fr.evil.com/")).toBe(false);
    expect(yes("https://1-one.fr:22/")).toBe(false);
    expect(yes("https://user:pw@1-one.fr/")).toBe(false);
    expect(yes("javascript:alert(1)")).toBe(false);
  });
});

describe("texte et pages clés", () => {
  test("texte lisible : scripts et styles retirés, entités décodées, titre et description gardés", () => {
    const r = htmlToText(`<html><head><title>Accueil &amp; offres</title><meta name="description" content="Conseil B2B"></head><body><h1>Nos offres</h1><p>Prix&nbsp;: 1&#160;000&nbsp;&euro; &eacute;t&eacute;</p><script>var secret=1</script></body></html>`);
    expect(r.titre).toBe("Accueil & offres");
    expect(r.texte).toContain("Description : Conseil B2B");
    expect(r.texte).toContain("## Nos offres");
    expect(r.texte).toContain("Prix : 1 000 € été");
    expect(r.texte).not.toContain("secret");
  });

  test("une page par catégorie d'abord, sur le domaine de la fiche, sans fichiers ni doublons", () => {
    const page = `<a href="/nos-offres">Nos offres</a><a href="/offre-2">Offre 2</a><a href="/tarifs">Tarifs</a><a href="https://site.1-one.fr/references">Clients</a>
      <a href="/qui-sommes-nous">Qui sommes-nous ?</a><a href="https://autre.fr/a-propos">Ailleurs</a><a href="/plaquette-offre.pdf">PDF</a>
      <a href="/tarifs#haut">Tarifs bis</a><a href="/blog">Blog</a><a href="mailto:a@1-one.fr">Mail</a>`;
    const links = keyLinks(page, new URL("https://1-one.fr/"), "1-one.fr", 5).map((u) => u.href);
    expect(links).toEqual(["https://1-one.fr/nos-offres", "https://1-one.fr/tarifs", "https://site.1-one.fr/references", "https://1-one.fr/qui-sommes-nous", "https://1-one.fr/offre-2"]);
  });
});

describe("capture", () => {
  const saved = { ...SITE_LIMITS };
  afterEach(() => Object.assign(SITE_LIMITS, saved));

  test("domaine valide : accueil et pages clés liées, avec titre, adresse et date de capture", async () => {
    const f = fake({
      "https://1-one.fr/": redirect("https://www.1-one.fr/"),
      "https://www.1-one.fr/": ok(html("1-One", `<p>${LONG}</p><a href="/offres">Offres</a><a href="https://site.1-one.fr/tarifs">Tarifs</a>`)),
      "https://www.1-one.fr/offres": ok(html("Offres", "<p>Audit, accompagnement</p>")),
      "https://site.1-one.fr/tarifs": ok(Buffer.from("Tarif unique : 990 € HT"), "text/plain"),
    });
    const r = await captureSite("1-one.fr", f);
    expect(r).toMatchObject({ status: "ok", site_url: "https://1-one.fr/", error: null });
    expect(r.pages.map((p) => [p.url, p.titre])).toEqual([["https://www.1-one.fr/", "1-One"], ["https://www.1-one.fr/offres", "Offres"], ["https://site.1-one.fr/tarifs", null]]);
    expect(r.pages[2].texte).toBe("Tarif unique : 990 € HT");
    expect(Date.parse(r.pages[0].capture_le)).not.toBeNaN();
  });

  test("site absent de la fiche : aucun appel réseau, raison donnée", async () => {
    const f = fake({});
    expect(await captureSite(null, f)).toEqual({ status: "none", site_url: null, error: "pas de site sur la fiche", pages: [] });
    expect(await captureSite("http://10.0.0.1", f)).toMatchObject({ status: "failed", error: expect.stringMatching(/adresse IP/) });
    expect(f.seen).toEqual([]);
  });

  test("redirection vers un autre domaine ou une adresse interne : refusée, sans requête vers la cible", async () => {
    const f = fake({ "https://1-one.fr/": redirect("https://pirate.example/"), "https://b.fr/": redirect("http://169.254.169.254/latest/meta-data") });
    expect(await captureSite("1-one.fr", f)).toMatchObject({ status: "failed", error: expect.stringMatching(/hors du domaine 1-one\.fr/) });
    expect(await captureSite("b.fr", f)).toMatchObject({ status: "failed", error: expect.stringMatching(/hors du domaine/) });
    expect(f.seen).toEqual(["https://1-one.fr/", "https://b.fr/"]);
  });

  test("redirections en boucle : bornées", async () => {
    const f = fake({ "https://a.fr/": redirect("/1"), "https://a.fr/1": redirect("/2"), "https://a.fr/2": redirect("/3"), "https://a.fr/3": redirect("/4") });
    expect(await captureSite("a.fr", f)).toMatchObject({ status: "failed", error: expect.stringMatching(/trop de redirections/) });
    expect(f.seen).toHaveLength(SITE_LIMITS.redirects + 1);
  });

  test("délai dépassé : échec signalé, sans erreur levée", async () => {
    SITE_LIMITS.pageTimeoutMs = 50;
    const slow: FetchOnce = (_url, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await captureSite("lent.fr", slow)).toMatchObject({ status: "failed", error: expect.stringMatching(/délai dépassé/), pages: [] });
  });

  test("site rendu en JavaScript, page lourde ou page clé en échec : capture partielle signalée", async () => {
    SITE_LIMITS.pageChars = 500;
    const f = fake({
      "https://js.fr/": ok(html("App", `<div id="root"></div><a href="/tarifs">Tarifs</a><a href="/offres">Offres</a>`)),
      "https://js.fr/offres": { ...ok(Buffer.from("x".repeat(2000)), "text/plain"), truncated: true },
    });
    const r = await captureSite("js.fr", f);
    expect(r.status).toBe("partial");
    expect(r.error).toMatch(/JavaScript/);
    expect(r.error).toMatch(/https:\/\/js\.fr\/tarifs non lue : domaine introuvable/);
    expect(r.error).toMatch(/offres tronquée/);
    expect(r.pages[1]).toMatchObject({ tronque: true });
    expect(r.pages[1].texte).toHaveLength(500);
  });

  test("contenu non textuel ou erreur HTTP : page non lue", async () => {
    const f = fake({ "https://a.fr/": ok(Buffer.from("%PDF"), "application/pdf"), "https://b.fr/": { ...ok(Buffer.from("")), status: 503 } });
    expect(await captureSite("a.fr", f)).toMatchObject({ status: "failed", error: expect.stringMatching(/non textuel/) });
    expect(await captureSite("b.fr", f)).toMatchObject({ status: "failed", error: expect.stringMatching(/503/) });
  });
});

describe("requête HTTP réelle (serveur local)", () => {
  let server: http.Server;
  let port: number;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/lent") return; // ne répond jamais
      if (req.url === "/gros") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("a".repeat(5000));
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" });
      res.end(zlib.gzipSync(`<title>Local</title><p>${LONG}</p>`));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  test("par défaut, un nom qui résout vers une adresse locale est refusé à la connexion", async () => {
    await expect(httpFetchOnce()(new URL(`http://localhost:${port}/`), AbortSignal.timeout(2000))).rejects.toThrow(/interne ou privée/);
  });

  test("réponse compressée lue, taille bornée, délai respecté", async () => {
    const open = httpFetchOnce({ lookup: dnsLookup as never, maxBytes: 1000 });
    const page = await open(new URL(`http://localhost:${port}/`), AbortSignal.timeout(2000));
    expect(page.body.toString()).toContain("<title>Local</title>");
    const big = await open(new URL(`http://localhost:${port}/gros`), AbortSignal.timeout(2000));
    expect(big).toMatchObject({ truncated: true });
    expect(big.body.length).toBe(1000);
    const t0 = Date.now();
    await expect(open(new URL(`http://localhost:${port}/lent`), AbortSignal.timeout(150))).rejects.toThrow(/abort/i);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
