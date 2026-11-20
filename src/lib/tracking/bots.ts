// Robots des moteurs de recherche et des IA : reconnaissance par l'agent utilisateur, puis contrôle de l'origine
// quand l'éditeur publie ses plages d'adresses. Un robot qui porte un nom connu sans venir d'une adresse publiée
// est classé « non vérifié » (usurpation probable). L'adresse sert au contrôle et n'est jamais conservée.
import { isIP } from "node:net";

export type BotKind = "ai" | "search" | "other";
export type BotStatus = "verified" | "unverified" | "unverifiable";
type BotDef = { name: string; test: RegExp; kind: BotKind; ranges?: string[] };

const GOOGLE = [
  "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
  "https://developers.google.com/static/search/apis/ipranges/special-crawlers.json",
  "https://developers.google.com/static/search/apis/ipranges/user-triggered-fetchers-google.json",
];

// l'ordre compte : les noms les plus précis d'abord (OAI-SearchBot avant GPTBot, Google-Extended avant Googlebot)
export const BOTS: BotDef[] = [
  { name: "OAI-SearchBot", test: /OAI-SearchBot/i, kind: "ai", ranges: ["https://openai.com/searchbot.json"] },
  { name: "ChatGPT-User", test: /ChatGPT-User/i, kind: "ai", ranges: ["https://openai.com/chatgpt-user.json"] },
  { name: "GPTBot", test: /GPTBot/i, kind: "ai", ranges: ["https://openai.com/gptbot.json"] },
  { name: "Claude-SearchBot", test: /Claude-SearchBot/i, kind: "ai" },
  { name: "Claude-User", test: /Claude-User/i, kind: "ai" },
  { name: "ClaudeBot", test: /ClaudeBot|anthropic-ai/i, kind: "ai" },
  { name: "Perplexity-User", test: /Perplexity-User/i, kind: "ai", ranges: ["https://www.perplexity.com/perplexity-user.json"] },
  { name: "PerplexityBot", test: /PerplexityBot/i, kind: "ai", ranges: ["https://www.perplexity.com/perplexitybot.json"] },
  { name: "Google-CloudVertexBot", test: /Google-CloudVertexBot/i, kind: "ai", ranges: GOOGLE },
  { name: "GoogleOther", test: /GoogleOther/i, kind: "other", ranges: GOOGLE },
  { name: "Googlebot", test: /Googlebot|Google-InspectionTool|Storebot-Google|AdsBot-Google/i, kind: "search", ranges: GOOGLE },
  { name: "Bingbot", test: /bingbot|BingPreview|adidxbot/i, kind: "search", ranges: ["https://www.bing.com/toolbox/bingbot.json"] },
  { name: "Applebot-Extended", test: /Applebot-Extended/i, kind: "ai" },
  { name: "Applebot", test: /Applebot/i, kind: "search" },
  { name: "DuckAssistBot", test: /DuckAssistBot/i, kind: "ai" },
  { name: "DuckDuckBot", test: /DuckDuckBot/i, kind: "search" },
  { name: "MistralAI-User", test: /MistralAI-User/i, kind: "ai" },
  { name: "Meta-ExternalAgent", test: /meta-externalagent|meta-externalfetcher|FacebookBot/i, kind: "ai" },
  { name: "Amazonbot", test: /Amazonbot/i, kind: "ai" },
  { name: "Bytespider", test: /Bytespider/i, kind: "ai" },
  { name: "CCBot", test: /CCBot/i, kind: "ai" },
  { name: "cohere-ai", test: /cohere-ai|cohere-training-data-crawler/i, kind: "ai" },
  { name: "YouBot", test: /YouBot/i, kind: "ai" },
  { name: "Diffbot", test: /Diffbot/i, kind: "ai" },
  { name: "YandexBot", test: /YandexBot/i, kind: "search" },
  { name: "Baiduspider", test: /Baiduspider/i, kind: "search" },
  { name: "Qwantbot", test: /Qwantbot|Qwantify/i, kind: "search" },
  { name: "AhrefsBot", test: /AhrefsBot/i, kind: "other" },
  { name: "SemrushBot", test: /SemrushBot/i, kind: "other" },
  { name: "LinkedInBot", test: /LinkedInBot/i, kind: "other" },
  { name: "facebookexternalhit", test: /facebookexternalhit/i, kind: "other" },
];

/** Tout ce qui ressemble à un robot ou à un navigateur piloté : jamais compté comme visite humaine. */
export const GENERIC_BOT = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|phantomjs|puppeteer|playwright|selenium|curl\/|wget\/|python-requests|python-urllib|go-http-client|axios\/|node-fetch|okhttp|java\/|libwww|httpclient|scrapy|monitor|uptime|pingdom|preview|fetcher|facebookexternalhit|whatsapp\/|vercel-screenshot|google-read-aloud/i;

export function matchBot(ua: string): BotDef | null {
  return BOTS.find((b) => b.test.test(ua)) ?? null;
}
export const isBotAgent = (ua: string) => !ua || !!matchBot(ua) || GENERIC_BOT.test(ua);

// ---------------------------------------------------------------------------
// Plages d'adresses publiées (IPv4 et IPv6), gardées en mémoire une journée
// ---------------------------------------------------------------------------
type Range = { value: bigint; bits: number; size: 32 | 128 };

function ipToBig(ip: string): { value: bigint; size: 32 | 128 } | null {
  const v = isIP(ip);
  if (v === 4) {
    return { value: ip.split(".").reduce((acc, part) => (acc << BigInt(8)) + BigInt(Number(part)), BigInt(0)), size: 32 };
  }
  if (v === 6) {
    let s = ip.split("%")[0];
    // forme mixte « ::ffff:1.2.3.4 »
    const mixed = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mixed) {
      const p = mixed[2].split(".").map(Number);
      s = `${mixed[1]}${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
    }
    const [head, tail] = s.split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined && tail ? tail.split(":") : [];
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill("0"), ...t];
    if (groups.length !== 8) return null;
    return { value: groups.reduce((acc, g) => (acc << BigInt(16)) + BigInt(parseInt(g || "0", 16)), BigInt(0)), size: 128 };
  }
  return null;
}

function parseCidr(cidr: string): Range | null {
  const [addr, len] = cidr.split("/");
  const ip = ipToBig(addr ?? "");
  const bits = Number(len);
  if (!ip || !Number.isInteger(bits) || bits < 0 || bits > ip.size) return null;
  return { value: ip.value, bits, size: ip.size };
}

export function inRanges(ip: string, ranges: Range[]): boolean {
  let addr = ipToBig(ip);
  if (!addr) return false;
  // adresse IPv4 présentée en IPv6 (::ffff:a.b.c.d)
  if (addr.size === 128 && addr.value >> BigInt(32) === BigInt(0xffff)) addr = { value: addr.value & BigInt(0xffffffff), size: 32 };
  return ranges.some((r) => {
    if (r.size !== addr.size) return false;
    const shift = BigInt(r.size - r.bits);
    return addr.value >> shift === r.value >> shift;
  });
}

export function parseRanges(json: unknown): Range[] {
  const prefixes = (json as { prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[] } | null)?.prefixes;
  if (!Array.isArray(prefixes)) return [];
  return prefixes.map((p) => parseCidr(p.ipv4Prefix ?? p.ipv6Prefix ?? "")).filter((r): r is Range => !!r);
}

const cache = new Map<string, { at: number; ranges: Range[] | null }>();
const DAY = 24 * 3600_000;

async function loadRanges(url: string): Promise<Range[] | null> {
  const hit = cache.get(url);
  // un échec n'est retenté qu'après dix minutes : le site ne doit jamais attendre une liste indisponible
  if (hit && Date.now() - hit.at < (hit.ranges ? DAY : 600_000)) return hit.ranges;
  let ranges: Range[] | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
    if (res.ok) {
      const parsed = parseRanges(await res.json());
      if (parsed.length) ranges = parsed;
    }
  } catch {
    ranges = null;
  }
  cache.set(url, { at: Date.now(), ranges: ranges ?? hit?.ranges ?? null });
  return ranges ?? hit?.ranges ?? null;
}

export type BotVerdict = { bot: string; kind: BotKind; status: BotStatus };

/** Nul si l'agent utilisateur n'est pas celui d'un robot connu. */
export async function identifyBot(ua: string, ip: string | null, load: (url: string) => Promise<Range[] | null> = loadRanges): Promise<BotVerdict | null> {
  const def = matchBot(ua);
  if (!def) return null;
  if (!def.ranges) return { bot: def.name, kind: def.kind, status: "unverifiable" };
  if (!ip) return { bot: def.name, kind: def.kind, status: "unverified" };
  const lists = await Promise.all(def.ranges.map(load));
  const known = lists.filter((l): l is Range[] => !!l);
  // liste momentanément illisible : on ne peut ni confirmer ni démentir
  if (!known.length) return { bot: def.name, kind: def.kind, status: "unverifiable" };
  return { bot: def.name, kind: def.kind, status: known.some((l) => inRanges(ip, l)) ? "verified" : "unverified" };
}
