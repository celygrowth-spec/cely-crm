import "server-only";
// Accès en lecture seule pour le site (contrat : docs/cms-contrat-site.md).
// 1. Clé du site (CMS_SITE_API_KEY, 32 caractères au moins) comparée en temps constant ; absente ou fausse → 401,
//    et trop d'essais refusés depuis une même adresse → 429.
// 2. La base exige la clé serveur, filtre ce qui est visible et limite le débit (par adresse et au total).
// 3. Le Markdown est rendu ici en HTML nettoyé (aucun script), avec le sommaire.
import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { publicClient } from "@/lib/appointments/server";
import { serverHmacHex, serverRpcKey } from "@/lib/appointments/secrets";
import { renderMarkdown } from "./markdown";
import { seoDefaults } from "./types";

export const API_VERSION = 1;

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...extra } });

export function siteKey(): string | null {
  const k = process.env.CMS_SITE_API_KEY?.trim();
  return k && k.length >= 32 ? k : null;
}

export function keyMatches(header: string | null, key: string | null): boolean {
  if (!key || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Empreinte de l'adresse de l'appelant (jamais l'adresse elle-même), changée chaque jour. */
function rateHash(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "inconnue";
  try {
    return serverHmacHex("cms-rate", `${new Date().toISOString().slice(0, 10)}|${ip}`).slice(0, 32);
  } catch {
    return "sans-secret";
  }
}

type Read = Record<string, unknown> & { error?: string };

/** Contrôle d'accès commun, puis lecture en base. Renvoie une réponse prête à l'envoi ou les données. */
export async function siteRead(req: Request, what: string, args: Record<string, unknown> = {}): Promise<{ res: NextResponse } | { data: Read }> {
  const key = siteKey();
  if (!key) return { res: json({ error: "not_configured" }, 503) };
  let serverKey: string;
  try { serverKey = serverRpcKey(); } catch { return { res: json({ error: "not_configured" }, 503) }; }
  const sb = publicClient();
  if (!keyMatches(req.headers.get("authorization"), key)) {
    const { data } = await sb.rpc("cms_site_denied", { p_server_key: serverKey, p_rate: rateHash(req) });
    return { res: data === false ? json({ error: "rate_limited" }, 429, { "Retry-After": "60" }) : json({ error: "unauthorized" }, 401) };
  }
  const { data, error } = await sb.rpc("cms_site_read", { p_server_key: serverKey, p_what: what, p_args: args, p_rate: rateHash(req) });
  if (error) return { res: json({ error: "unavailable" }, 503) };
  const out = data as Read;
  if (out.error === "rate_limited") return { res: json({ error: "rate_limited" }, 429, { "Retry-After": "60" }) };
  if (out.error === "unknown_type" || out.error === "unknown_request") return { res: json({ error: out.error }, 400) };
  return { data: out };
}

export const ok = (body: unknown) => json({ version: API_VERSION, ...(body as object) });
export const notFound = () => json({ version: API_VERSION, error: "not_found" }, 404);

type RawEntry = {
  type: string; slug: string; title: string; excerpt?: string; body_md?: string; cover_image_url?: string; cover_alt?: string;
  category?: string; author?: string; tags: string[]; focus_keyword?: string; secondary_keywords: string[];
  seo_title?: string; seo_description?: string; og_title?: string; og_image_url?: string; canonical_url?: string; noindex: boolean;
  published_at: string; first_published_at?: string; updated_at: string; reading_minutes: number; extra: Record<string, unknown>;
};

/** Contenu au format du contrat. full : avec le contenu (Markdown et HTML) et le sommaire. */
export function publicEntry(e: RawEntry, full: boolean) {
  const seo = seoDefaults({ title: e.title, excerpt: e.excerpt ?? null, seo_title: e.seo_title ?? null, seo_description: e.seo_description ?? null, og_title: e.og_title ?? null });
  const base = {
    type: e.type,
    slug: e.slug,
    title: e.title,
    excerpt: e.excerpt ?? null,
    cover_image: e.cover_image_url ? { url: e.cover_image_url, alt: e.cover_alt ?? "" } : null,
    category: e.category ?? null,
    tags: e.tags,
    author: e.author ?? null,
    keywords: [e.focus_keyword, ...e.secondary_keywords].filter(Boolean) as string[],
    seo: {
      title: seo.title,
      description: seo.description || null,
      og_title: seo.ogTitle,
      og_image: e.og_image_url ?? e.cover_image_url ?? null,
      canonical: e.canonical_url ?? null,
      noindex: e.noindex,
    },
    published_at: e.published_at,
    first_published_at: e.first_published_at ?? e.published_at,
    updated_at: e.updated_at,
    reading_minutes: e.reading_minutes,
  };
  if (!full) return base;
  const { html, headings } = renderMarkdown(e.body_md ?? "");
  return { ...base, content_markdown: e.body_md ?? "", content_html: html, headings, extra: e.extra ?? {} };
}
