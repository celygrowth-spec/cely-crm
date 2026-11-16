import "server-only";
// Capture du site du prospect par le serveur du CRM, pour un diagnostic : la page d'accueil et quelques pages clés
// liées depuis elle (offre, tarifs, références, à propos). La session Claude lit ensuite ce texte par le connecteur.
// Sécurité : http et https seulement, ports standard, domaine de la fiche et ses sous-domaines uniquement, à chaque
// redirection. L'adresse IP est vérifiée au moment de la connexion (pas seulement avant) : une adresse interne ou
// privée est refusée, même si le nom résout autrement entre deux requêtes. Délai, taille et redirections bornés.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import zlib from "node:zlib";

export const SITE_LIMITS = {
  pages: 6, // accueil compris
  redirects: 3,
  pageTimeoutMs: 8_000,
  pageBytes: 2 * 1024 * 1024,
  pageChars: 30_000,
};

export type SitePage = { url: string; titre: string | null; texte: string; tronque: boolean; capture_le: string };
export type SiteCaptureResult = { status: "ok" | "partial" | "failed" | "none"; site_url: string | null; error: string | null; pages: SitePage[] };

export class SiteError extends Error {}

// ---------------------------------------------------------------------------
// Adresses : seules les adresses publiques sont jointes
// ---------------------------------------------------------------------------
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128], ["::1", 128], ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** Vrai pour une adresse joignable sur Internet ; faux pour toute adresse interne, privée, locale ou réservée. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const a = address.toLowerCase();
  // IPv4 encapsulée (::ffff:a.b.c.d, NAT64 64:ff9b::a.b.c.d, ::a.b.c.d) : on juge l'adresse IPv4
  const embedded = a.match(/^(?:::ffff:|64:ff9b::|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return isPublicAddress(embedded[1]);
  if (/^(::ffff:|64:ff9b::)/.test(a)) return false;
  return !blocked.check(a, "ipv6");
}

type LookupFn = NonNullable<http.RequestOptions["lookup"]>;

/** Résolution DNS utilisée par la connexion elle-même : refuse si l'une des adresses n'est pas publique. */
export const guardedLookup: LookupFn = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((x) => !isPublicAddress(x.address))) return callback(new SiteError("adresse interne ou privée refusée"));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}) as LookupFn;

// ---------------------------------------------------------------------------
// Domaine de la fiche
// ---------------------------------------------------------------------------
/** Adresse de départ et domaine autorisé (sans « www. ») à partir du champ site web de la fiche. */
export function siteTarget(website: string | null | undefined): { url: URL; domain: string } {
  const raw = (website ?? "").trim();
  if (!raw) throw new SiteError("pas de site sur la fiche");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new SiteError("adresse du site invalide");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new SiteError("seuls http et https sont acceptés");
  if (url.username || url.password) throw new SiteError("adresse du site invalide");
  if (url.port) throw new SiteError("port non standard refusé");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) throw new SiteError("adresse IP refusée : le site de la fiche doit être un nom de domaine");
  const domain = host.replace(/^www\./, "");
  if (!domain.includes(".") || /\.(local|localhost|internal|lan|home|corp|intranet)$/.test(domain)) throw new SiteError("domaine non public refusé");
  url.hash = "";
  return { url, domain };
}

/** Le domaine de la fiche ou l'un de ses sous-domaines, en http(s) sur un port standard. */
export function allowedUrl(url: URL, domain: string): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.port || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

// ---------------------------------------------------------------------------
// Une requête : délai, taille et décompression bornés, redirection non suivie
// ---------------------------------------------------------------------------
export type RawResponse = { status: number; location: string | null; contentType: string; body: Buffer; truncated: boolean };
export type FetchOnce = (url: URL, signal: AbortSignal) => Promise<RawResponse>;

export function httpFetchOnce(opts: { lookup?: LookupFn; maxBytes?: number } = {}): FetchOnce {
  const maxBytes = opts.maxBytes ?? SITE_LIMITS.pageBytes;
  return (url, signal) =>
    new Promise<RawResponse>((resolve, reject) => {
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(url, {
        method: "GET",
        lookup: opts.lookup ?? guardedLookup,
        signal,
        // agent dédié : pas de connexion réutilisée qui contournerait le contrôle d'adresse
        agent: false,
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; CelyGrowthDiagnostic/1.0)",
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
          "accept-language": "fr,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
      });
      req.on("error", (e) => reject(e));
      req.on("response", (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location ?? null, contentType, body: Buffer.alloc(0), truncated: false });
        }
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = (truncated: boolean) => {
          if (done) return;
          done = true;
          resolve({ status, location: null, contentType, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
        };
        stream.on("data", (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          if (size >= maxBytes) {
            finish(true);
            req.destroy();
          }
        });
        stream.on("end", () => finish(false));
        stream.on("error", (e) => (done ? undefined : (done = true, reject(e))));
      });
      req.end();
    });
}

function reason(e: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "délai dépassé";
  if (e instanceof SiteError) return e.message;
  const code = (e as { code?: string })?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "domaine introuvable";
  if (code === "ECONNREFUSED") return "connexion refusée";
  if (code === "ECONNRESET") return "connexion interrompue";
  if (code && /CERT|SSL|TLS/.test(code)) return "certificat invalide";
  return "site injoignable";
}

/** Une page : redirections suivies une à une et revérifiées, tout en restant sur le domaine de la fiche. */
export async function fetchPage(start: URL, domain: string, fetchOnce: FetchOnce, timeoutMs = SITE_LIMITS.pageTimeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url = start;
  try {
    for (let hop = 0; ; hop++) {
      if (!allowedUrl(url, domain)) throw new SiteError(`redirection hors du domaine ${domain} refusée`);
      const res = await fetchOnce(url, signal);
      if (res.status >= 300 && res.status < 400 && res.location) {
        if (hop >= SITE_LIMITS.redirects) throw new SiteError("trop de redirections");
        try {
          url = new URL(res.location, url);
        } catch {
          throw new SiteError("redirection invalide");
        }
        continue;
      }
      if (res.status >= 400) throw new SiteError(`réponse ${res.status} du site`);
      if (!/text\/html|application\/xhtml|text\/plain/i.test(res.contentType)) throw new SiteError("contenu non textuel");
      return { url, ...res };
    }
  } catch (e) {
    throw new SiteError(reason(e, signal));
  }
}

// ---------------------------------------------------------------------------
// HTML → texte
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", agrave: "à", acirc: "â",
  ccedil: "ç", ocirc: "ô", ouml: "ö", ucirc: "û", ugrave: "ù", uuml: "ü", icirc: "î", iuml: "ï", oelig: "œ", Eacute: "É", Egrave: "È",
  Agrave: "À", Ccedil: "Ç", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", hellip: "…", ndash: "–", mdash: "—",
  euro: "€", copy: "©", reg: "®", trade: "™", middot: "·", bull: "•",
};
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[e] ?? m;
  });

export function htmlToText(html: string): { titre: string | null; texte: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const description = html.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0].match(/content=["']([^"']*)["']/i)?.[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|nav|ul|ol|table|blockquote)>/gi, "\n")
    .replace(/<(h[1-6]|li)\b[^>]*>/gi, (m, t: string) => (t.toLowerCase() === "li" ? "\n- " : "\n## "))
    .replace(/<[^>]+>/g, " ");
  const clean = (s: string) => decodeEntities(s).replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").replace(/\n(?:- |## )?\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const texte = [description ? `Description : ${clean(description)}` : "", clean(body)].filter(Boolean).join("\n\n");
  return { titre: title ? clean(title).slice(0, 300) || null : null, texte };
}

function decodeBody(body: Buffer, contentType: string): string {
  const label = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? body.subarray(0, 2048).toString("latin1").match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(label.toLowerCase()).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

// ---------------------------------------------------------------------------
// Pages clés liées depuis l'accueil
// ---------------------------------------------------------------------------
const KEY_PAGES: [string, RegExp][] = [
  ["offre", /(offre|service|solution|produit|prestation|expertise|accompagnement|what-we-do|products?\b)/],
  ["tarifs", /(tarif|prix|pricing|price|abonnement|devis|plans?\b)/],
  ["references", /(reference|realisation|client|temoignage|cas-|case-stud|portfolio|projets?\b)/],
  ["a-propos", /(a-propos|apropos|about|qui-sommes|equipe|team|notre-histoire|histoire|entreprise|societe|agence|cabinet)/],
];
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)$|\/(wp-admin|wp-login|login|connexion|panier|cart|compte|account|feed)\b|mailto:|tel:/i;
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Jusqu'à `max` pages clés, une par catégorie d'abord, sur le domaine de la fiche. */
export function keyLinks(html: string, base: URL, domain: string, max: number): URL[] {
  const found = new Map<string, URL[]>(KEY_PAGES.map(([k]) => [k, []]));
  const seen = new Set([base.origin + base.pathname.replace(/\/$/, "")]);
  for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    url.hash = "";
    url.search = "";
    const key = url.origin + url.pathname.replace(/\/$/, "");
    if (seen.has(key) || SKIP.test(url.href) || !allowedUrl(url, domain)) continue;
    const label = fold(`${url.pathname} ${m[2].replace(/<[^>]+>/g, " ")}`);
    const cat = KEY_PAGES.find(([, re]) => re.test(label));
    if (!cat) continue;
    seen.add(key);
    found.get(cat[0])!.push(url);
  }
  const out: URL[] = [];
  for (let round = 0; out.length < max && round < 3; round++)
    for (const [k] of KEY_PAGES) {
      const u = found.get(k)![round];
      if (u && out.length < max) out.push(u);
    }
  return out;
}

// ---------------------------------------------------------------------------
// Capture complète : n'échoue jamais, la raison est dans le résultat
// ---------------------------------------------------------------------------
function toPage(url: URL, res: RawResponse): SitePage & { html: string } {
  const html = decodeBody(res.body, res.contentType);
  const { titre, texte } = /text\/plain/i.test(res.contentType) ? { titre: null, texte: html.trim() } : htmlToText(html);
  const tronque = res.truncated || texte.length > SITE_LIMITS.pageChars;
  return { url: url.href, titre, texte: texte.slice(0, SITE_LIMITS.pageChars), tronque, capture_le: new Date().toISOString(), html };
}

export async function captureSite(website: string | null | undefined, fetchOnce: FetchOnce = httpFetchOnce()): Promise<SiteCaptureResult> {
  let target: { url: URL; domain: string };
  try {
    target = siteTarget(website);
  } catch (e) {
    const msg = e instanceof SiteError ? e.message : "adresse du site invalide";
    return { status: website?.trim() ? "failed" : "none", site_url: website?.trim() || null, error: msg, pages: [] };
  }
  const notes: string[] = [];
  let home: SitePage & { html: string };
  try {
    const r = await fetchPage(target.url, target.domain, fetchOnce);
    home = toPage(r.url, r);
  } catch (e) {
    return { status: "failed", site_url: target.url.href, error: `Page d'accueil (${target.url.href}) : ${e instanceof SiteError ? e.message : "site injoignable"}`, pages: [] };
  }
  if (home.tronque) notes.push(`Page d'accueil tronquée (${SITE_LIMITS.pageChars} caractères au plus).`);
  if (home.texte.length < 300) notes.push("Page d'accueil presque vide : le contenu est probablement affiché en JavaScript, capture partielle.");

  const links = keyLinks(home.html, new URL(home.url), target.domain, SITE_LIMITS.pages - 1);
  const subs = await Promise.all(
    links.map(async (u) => {
      try {
        const r = await fetchPage(u, target.domain, fetchOnce);
        const p = toPage(r.url, r);
        if (p.tronque) notes.push(`Page ${p.url} tronquée.`);
        return p;
      } catch (e) {
        notes.push(`Page ${u.href} non lue : ${e instanceof SiteError ? e.message : "site injoignable"}.`);
        return null;
      }
    }),
  );
  const pages = [home, ...subs.filter((p): p is SitePage & { html: string } => !!p)]
    .filter((p, i, all) => all.findIndex((q) => q.url === p.url) === i)
    .map((p): SitePage => ({ url: p.url, titre: p.titre, texte: p.texte, tronque: p.tronque, capture_le: p.capture_le }));
  return { status: notes.length ? "partial" : "ok", site_url: target.url.href, error: notes.length ? notes.join(" ").slice(0, 2000) : null, pages };
}
