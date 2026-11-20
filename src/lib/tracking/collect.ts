import "server-only";
// Point de collecte : validation stricte de la forme et de la taille, classement de la source, puis une seule
// écriture en base (site_collect). L'adresse IP ne sert qu'à calculer deux empreintes salées (exclusion du
// propriétaire, limite d'abus) et n'est jamais transmise ni conservée ; le pays vient de l'en-tête posé par Vercel.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { publicClient } from "@/lib/appointments/server";
import { serverRpcKey } from "@/lib/appointments/secrets";
import { isBotAgent } from "./bots";
import { extraSiteHosts } from "./config";
import { AD_CLICK_ID_NAMES, browserOf, classifyVisit, deviceOf } from "./sources";
import { readUtm } from "./utm";

export const MAX_BODY = 4000;

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const path = z.string().min(1).max(300).regex(/^\/[^\s?#]*$/);
const common = { v: id, u: id.optional() };
export const eventSchema = z.discriminatedUnion("t", [
  z.object({ ...common, t: z.literal("pv"), p: id, path, q: z.string().max(900).optional(), r: z.string().max(200).optional() }),
  z.object({ ...common, t: z.literal("pe"), p: id, path, d: z.number().int().min(0).max(86400), s: z.number().int().min(0).max(100) }),
  z.object({ ...common, t: z.enum(["cta", "booking"]), e: id, path, label: z.string().max(120).optional() }),
  z.object({
    ...common, t: z.literal("form"), e: id, path, label: z.string().max(120).optional(),
    ds: z.string().max(60).optional(), dd: z.string().max(300).optional(),
    em: z.string().max(254).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/).optional(),
  }),
  z.object({ ...common, t: z.enum(["consent", "withdraw"]) }),
]);
export type SiteEvent = z.infer<typeof eventSchema>;

export type ClientInfo = { ip: string | null; userAgent: string; country: string | null };

/** Empreinte stable d'une adresse (jamais l'adresse elle-même) : reconnaît la connexion du propriétaire. */
export function ownerIpHash(ip: string): string {
  return createHash("sha256").update(`${serverRpcKey()}:site-owner:${ip}`).digest("hex").slice(0, 40);
}
const rateHash = (ip: string) =>
  createHash("sha256").update(`${serverRpcKey()}:site-rate:${new Date().toISOString().slice(0, 10)}:${ip}`).digest("hex").slice(0, 32);

/** Événement validé → charge utile de site_collect. Fonction pure, testée seule. */
export function toDbEvent(ev: SiteEvent, client: Omit<ClientInfo, "ip">, siteHosts: string[] = []) {
  const base = { type: ev.t, visit_id: ev.v, visitor_id: ev.u ?? null };
  if (ev.t === "pv") {
    const params = new URLSearchParams(ev.q ?? "");
    const { utm, raw } = readUtm(params);
    const clickIds = AD_CLICK_ID_NAMES.filter((n) => params.has(n));
    const c = classifyVisit({ utm, referrer: ev.r, clickIds, extraSiteHosts: siteHosts });
    return {
      ...base, pageview_id: ev.p, path: ev.path,
      visit: {
        ...c, ...utm, utm_raw: raw,
        country: client.country && /^[A-Z]{2}$/.test(client.country) && client.country !== "XX" ? client.country : null,
        device: deviceOf(client.userAgent), browser: browserOf(client.userAgent),
      },
    };
  }
  if (ev.t === "pe") return { ...base, pageview_id: ev.p, path: ev.path, duration_s: Math.min(ev.d, 3600), scroll_pct: ev.s };
  if (ev.t === "form") {
    return { ...base, event_id: ev.e, path: ev.path, label: ev.label ?? null, declared_source: ev.ds ?? null, declared_detail: ev.dd ?? null, email: ev.em ?? null };
  }
  if (ev.t === "cta" || ev.t === "booking") return { ...base, event_id: ev.e, path: ev.path, label: ev.label ?? null };
  return base;
}

export type CollectOutcome = "ok" | "excluded" | "rate_limited" | "ignored" | "invalid" | "bot";

export async function collect(raw: string, client: ClientInfo, sb: SupabaseClient = publicClient()): Promise<CollectOutcome> {
  if (!raw || raw.length > MAX_BODY) return "invalid";
  if (isBotAgent(client.userAgent)) return "bot";
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return "invalid";
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return "invalid";
  const { data, error } = await sb.rpc("site_collect", {
    p_server_key: serverRpcKey(),
    p_event: toDbEvent(parsed.data, client, extraSiteHosts()),
    p_ip_hash: client.ip ? ownerIpHash(client.ip) : null,
    p_rate_hash: client.ip ? rateHash(client.ip) : null,
  });
  if (error) throw new Error("Collecte indisponible");
  return (data as CollectOutcome) ?? "ignored";
}

export function clientIp(req: Request): string | null {
  // première adresse de x-forwarded-for : celle du visiteur derrière le proxy Vercel
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

/** Le propriétaire utilise le CRM depuis cette connexion : ses visites du site ne seront pas comptées. */
export async function noteOwnerConnection(sb: SupabaseClient, req: Request): Promise<void> {
  try {
    const ip = clientIp(req);
    if (ip) await sb.rpc("site_exclude_ip", { p_ip_hash: ownerIpHash(ip) });
  } catch {
    // jamais bloquant : la mesure ne doit pas gêner l'usage du CRM
  }
}
